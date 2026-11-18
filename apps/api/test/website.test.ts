import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createPool } from '@midotel/db';
import { buildApp } from '../src/app.ts';
import { LocalStorage } from '../src/storage.ts';
import { signUp, type Owner } from './helpers.ts';

const mediaDir = await mkdtemp(path.join(tmpdir(), 'midotel-media-'));
const pool = createPool(inject('appUrl'), 5);
const app = await buildApp({ pool, storage: new LocalStorage(mediaDir) });
afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(mediaDir, { recursive: true, force: true });
});

// Smallest valid PNG (1x1 pixel).
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

function multipart(fileName: string, type: string, bytes: Buffer) {
  const boundary = '----midotel' + Math.random().toString(16).slice(2);
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`;
  const payload = Buffer.concat([Buffer.from(head), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('website builder', () => {
  let owner: Owner;
  const as = (o: Owner) => ({ cookie: o.cookie });
  beforeAll(async () => {
    owner = await signUp(app, 'Desert');
  });

  it('creates starter pages the first time the site is opened', async () => {
    const res = await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/site`, headers: as(owner) });
    expect(res.statusCode).toBe(200);
    const site = res.json();
    expect(site.theme).toBe('aurora');
    expect(site.publishedVersion).toBe(0);
    expect(site.pages.map((p: { slug: string }) => p.slug)).toEqual(['home', 'rooms', 'gallery', 'contact']);
    expect(site.pages[0].sections[0].type).toBe('hero');
    // Opening it again does not duplicate pages.
    const again = await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/site`, headers: as(owner) });
    expect(again.json().pages).toHaveLength(4);
  });

  it('uploads images, rejects files that are not images', async () => {
    const ok = await app.inject({ method: 'POST', url: `/properties/${owner.propertyId}/media`, ...upload(owner, multipart('pool.png', 'image/png', PNG)) });
    expect(ok.statusCode).toBe(201);
    const img = ok.json();
    expect(img.contentType).toBe('image/png');

    const served = await app.inject({ method: 'GET', url: new URL(img.url).pathname });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.rawPayload.equals(PNG)).toBe(true);

    const fake = await app.inject({
      method: 'POST',
      url: `/properties/${owner.propertyId}/media`,
      ...upload(owner, multipart('evil.png', 'image/png', Buffer.from('<script>alert(1)</script> not an image'))),
    });
    expect(fake.statusCode).toBe(400);
  });

  it('edits sections, previews the draft, and only shows it publicly after publish', async () => {
    const site = (await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/site`, headers: as(owner) })).json();
    const home = site.pages[0];
    const media = (await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/media`, headers: as(owner) })).json();
    const sections = [
      { id: 'h1', type: 'hero', data: { heading: 'Sand dunes and starry nights', subheading: 'Luxury tents near Jaisalmer', imageIds: [media[0].id] } },
      { id: 't1', type: 'text', data: { heading: 'Our story', body: 'Family-run since 1998.' } },
    ];
    const saved = await app.inject({ method: 'PATCH', url: `/pages/${home.id}`, headers: as(owner), payload: { sections, seoTitle: 'Desert Camp | Jaisalmer' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().hasUnpublishedChanges).toBe(true);
    expect(saved.json().sections[1].data.imageSide).toBe('right'); // defaults filled in

    const bad = await app.inject({ method: 'PATCH', url: `/pages/${home.id}`, headers: as(owner), payload: { sections: [{ id: 'x', type: 'video', data: {} }] } });
    expect(bad.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: `/properties/${owner.propertyId}/domains`, headers: as(owner), payload: { hostname: 'www.desert-test.example', purpose: 'website' } });
    expect((await app.inject({ method: 'GET', url: '/public/site?host=www.desert-test.example' })).statusCode).toBe(404);

    const { token } = (await app.inject({ method: 'POST', url: `/properties/${owner.propertyId}/preview-token`, headers: as(owner) })).json();
    const preview = await app.inject({ method: 'GET', url: `/public/preview?token=${encodeURIComponent(token)}` });
    expect(preview.statusCode).toBe(200);
    const draftHome = preview.json().pages.find((p: { kind: string }) => p.kind === 'home');
    expect(draftHome.sections[0].data.heading).toBe('Sand dunes and starry nights');
    expect(Object.keys(preview.json().images)).toContain(media[0].id);

    const tampered = await app.inject({ method: 'GET', url: `/public/preview?token=${encodeURIComponent(token.slice(0, -2) + 'xx')}` });
    expect(tampered.statusCode).toBe(401);

    const pub = await app.inject({ method: 'POST', url: `/properties/${owner.propertyId}/publish`, headers: as(owner) });
    expect(pub.json().version).toBe(1);
    const live = await app.inject({ method: 'GET', url: '/public/site?host=www.desert-test.example' });
    expect(live.statusCode).toBe(200);
    expect(live.json().pages[0].seoTitle).toBe('Desert Camp | Jaisalmer');

    // Later draft edits stay off the live site until the next publish.
    await app.inject({ method: 'PATCH', url: `/pages/${home.id}`, headers: as(owner), payload: { sections: [] } });
    const stillLive = await app.inject({ method: 'GET', url: '/public/site?host=www.desert-test.example' });
    expect(stillLive.json().pages[0].sections).toHaveLength(2);
  });

  it('adds and deletes custom pages but protects the home page', async () => {
    const created = await app.inject({ method: 'POST', url: `/properties/${owner.propertyId}/pages`, headers: as(owner), payload: { title: 'Weddings', slug: 'weddings' } });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: `/properties/${owner.propertyId}/pages`, headers: as(owner), payload: { title: 'Weddings 2', slug: 'weddings' } });
    expect(dup.statusCode).toBe(409);
    const site = (await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/site`, headers: as(owner) })).json();
    const home = site.pages.find((p: { kind: string }) => p.kind === 'home');
    expect((await app.inject({ method: 'DELETE', url: `/pages/${home.id}`, headers: as(owner) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/pages/${created.json().id}`, headers: as(owner) })).statusCode).toBe(204);
  });

  it("keeps one hotel's pages and images away from another", async () => {
    const other = await signUp(app, 'Other');
    const site = (await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/site`, headers: as(owner) })).json();
    const media = (await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/media`, headers: as(owner) })).json();
    expect((await app.inject({ method: 'GET', url: `/pages/${site.pages[0].id}`, headers: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/site`, headers: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/media/${media[0].id}`, headers: as(other) })).statusCode).toBe(404);
    // The other hotel cannot attach this hotel's photo to its rooms.
    const room = await app.inject({
      method: 'POST',
      url: `/properties/${other.propertyId}/room-types`,
      headers: as(other),
      payload: { name: 'Tent', code: 'TNT', imageIds: [media[0].id] },
    });
    expect(room.statusCode).toBe(400);
  });
});

function upload(o: Owner, m: { payload: Buffer; headers: Record<string, string> }) {
  return { payload: m.payload, headers: { ...m.headers, cookie: o.cookie } };
}
