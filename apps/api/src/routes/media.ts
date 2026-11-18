import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, assertPropertyExists, HttpError, requireAuth, type Role } from '../app.ts';
import { audit } from '../audit.ts';
import { mediaUrl } from '../site-data.ts';
import type { Storage } from '../storage.ts';

const EDITORS: Role[] = ['owner', 'manager', 'content_editor'];
const TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Check the file really is the image type it claims, from its first bytes. */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 12).toString() === 'ftypavif') return 'image/avif';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  return null;
}

export async function mediaRoutes(app: FastifyInstance, opts: { storage: Storage }) {
  const pool = app.pool;
  const { storage } = opts;
  const dto = (m: typeof schema.mediaAsset.$inferSelect) => ({
    id: m.id,
    fileName: m.fileName,
    contentType: m.contentType,
    byteSize: m.byteSize,
    alt: m.alt,
    url: mediaUrl(m.tenantId, m.id),
    createdAt: m.createdAt,
  });

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/media', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const rows = await db
        .select()
        .from(schema.mediaAsset)
        .where(eq(schema.mediaAsset.propertyId, propertyId))
        .orderBy(desc(schema.mediaAsset.createdAt));
      return rows.map(dto);
    });
  });

  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/media', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, EDITORS);
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw new HttpError(400, 'No file uploaded');
    const bytes = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'Images must be 10 MB or smaller');
    const type = sniff(bytes);
    if (!type) throw new HttpError(400, 'Upload a JPEG, PNG, WebP, AVIF or GIF image');
    const id = randomUUID();
    const key = `${auth.tenantId}/${propertyId}/${id}.${TYPES[type]}`;
    const created = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      await storage.put(key, bytes);
      const [m] = await db
        .insert(schema.mediaAsset)
        .values({
          id,
          tenantId: auth.tenantId,
          propertyId,
          fileName: file.filename.slice(0, 200) || 'image',
          contentType: type,
          byteSize: bytes.length,
          storageKey: key,
        })
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'upload', entity: 'media', entityId: id });
      return m!;
    });
    return reply.status(201).send(dto(created));
  });

  app.patch<{ Params: { id: string } }>('/media/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const { alt } = z.object({ alt: z.string().trim().max(200).nullable() }).parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [m] = await db.select().from(schema.mediaAsset).where(eq(schema.mediaAsset.id, id));
      if (!m) throw new HttpError(404, 'Image not found');
      assertProperty(auth, m.propertyId, EDITORS);
      const [u] = await db.update(schema.mediaAsset).set({ alt }).where(eq(schema.mediaAsset.id, id)).returning();
      return dto(u!);
    });
  });

  app.delete<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const key = await withTenant(pool, auth.tenantId, async (db) => {
      const [m] = await db.select().from(schema.mediaAsset).where(eq(schema.mediaAsset.id, id));
      if (!m) throw new HttpError(404, 'Image not found');
      assertProperty(auth, m.propertyId, EDITORS);
      await db.delete(schema.mediaAsset).where(eq(schema.mediaAsset.id, id));
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'delete', entity: 'media', entityId: id });
      return m.storageKey;
    });
    await storage.remove(key);
    return reply.status(204).send();
  });

  // Public image delivery. In production a CDN with resizing sits in front of this.
  app.get<{ Params: { tenantId: string; id: string } }>('/media/:tenantId/:id', async (req, reply) => {
    const parsed = z.object({ tenantId: z.uuid(), id: z.uuid() }).safeParse(req.params);
    if (!parsed.success) throw new HttpError(404, 'Not found');
    const m = await withTenant(pool, parsed.data.tenantId, async (db) => {
      const [row] = await db.select().from(schema.mediaAsset).where(eq(schema.mediaAsset.id, parsed.data.id));
      return row;
    });
    if (!m) throw new HttpError(404, 'Not found');
    const bytes = await storage.get(m.storageKey);
    if (!bytes) throw new HttpError(404, 'Not found');
    return reply
      .header('content-type', m.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });
}
