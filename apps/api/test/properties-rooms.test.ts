import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signUp, type Owner } from './helpers.ts';

const ctx = await makeApp();
const { app } = ctx;
afterAll(async () => {
  await app.close();
  await ctx.pool.end();
});

describe('properties and room types', () => {
  let owner: Owner;
  beforeAll(async () => {
    owner = await signUp(app, 'Lake');
  });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: owner.cookie } });

  it('lists the first property with India defaults', async () => {
    const res = await get('/properties');
    expect(res.statusCode).toBe(200);
    const [p] = res.json();
    expect(p.id).toBe(owner.propertyId);
    expect(p.currency).toBe('INR');
    expect(p.timezone).toBe('Asia/Kolkata');
    expect(p.status).toBe('draft');
  });

  it('updates property details and validates GSTIN', async () => {
    const ok = await send('PATCH', `/properties/${owner.propertyId}`, {
      tagline: 'Heritage stay by the lake',
      city: 'Udaipur',
      state: 'Rajasthan',
      gstin: '08abcde1234f1z5',
      latitude: 24.5854,
      longitude: 73.7125,
      checkInTime: '13:00',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ city: 'Udaipur', gstin: '08ABCDE1234F1Z5', latitude: 24.5854, checkInTime: '13:00:00' });

    const bad = await send('PATCH', `/properties/${owner.propertyId}`, { gstin: '123' });
    expect(bad.statusCode).toBe(400);
  });

  it('adds a second property', async () => {
    const res = await send('POST', '/properties', { name: 'Lake Annexe', slug: 'lake-annexe' });
    expect(res.statusCode).toBe(201);
    const dup = await send('POST', '/properties', { name: 'Lake Annexe 2', slug: 'lake-annexe' });
    expect(dup.statusCode).toBe(409);
  });

  it('creates, edits, lists and deletes room types', async () => {
    const created = await send('POST', `/properties/${owner.propertyId}/room-types`, {
      name: 'Deluxe Lake View',
      code: 'dlx',
      maxAdults: 3,
      maxChildren: 1,
      maxOccupancy: 4,
      totalUnits: 12,
      bedType: 'King',
    });
    expect(created.statusCode).toBe(201);
    const room = created.json();
    expect(room.code).toBe('DLX');

    const edited = await send('PATCH', `/room-types/${room.id}`, { totalUnits: 10, sortOrder: 1 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().totalUnits).toBe(10);

    const tooMany = await send('PATCH', `/room-types/${room.id}`, { maxOccupancy: 9 });
    expect(tooMany.statusCode).toBe(400);

    const dupCode = await send('POST', `/properties/${owner.propertyId}/room-types`, { name: 'Other', code: 'DLX' });
    expect(dupCode.statusCode).toBe(409);

    const list = await get(`/properties/${owner.propertyId}/room-types`);
    expect(list.json()).toHaveLength(1);

    const del = await send('DELETE', `/room-types/${room.id}`);
    expect(del.statusCode).toBe(204);
    expect((await get(`/properties/${owner.propertyId}/room-types`)).json()).toHaveLength(0);
  });

  it('routes a hostname to the public site data', async () => {
    await send('POST', `/properties/${owner.propertyId}/room-types`, { name: 'Garden Room', code: 'GDN' });
    const d = await send('POST', `/properties/${owner.propertyId}/domains`, { hostname: 'www.lake-test.example', purpose: 'website' });
    expect(d.statusCode).toBe(201);
    const before = await app.inject({ method: 'GET', url: '/public/site?host=www.lake-test.example' });
    expect(before.statusCode).toBe(404); // nothing published yet
    await send('POST', `/properties/${owner.propertyId}/publish`);
    const site = await app.inject({ method: 'GET', url: '/public/site?host=WWW.lake-test.example:443' });
    expect(site.statusCode).toBe(200);
    expect(site.json().property.id).toBe(owner.propertyId);
    expect(site.json().rooms.map((r: { code: string }) => r.code)).toContain('GDN');
    const unknown = await app.inject({ method: 'GET', url: '/public/site?host=nope.example' });
    expect(unknown.statusCode).toBe(404);
  });
});
