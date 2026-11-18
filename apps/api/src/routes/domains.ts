import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, assertPropertyExists, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';

const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a hostname like www.hotel.com');

export async function domainRoutes(app: FastifyInstance) {
  const pool = app.pool;

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/domains', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      return db.select().from(schema.domain).where(eq(schema.domain.propertyId, propertyId));
    });
  });

  // DNS verification and certificate issuance come with hosting (Phase 1); for now the row only routes.
  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/domains', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, ['owner', 'manager']);
    const body = z.object({ hostname: Hostname, purpose: z.enum(['website', 'booking']) }).parse(req.body);
    const created = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [d] = await db
        .insert(schema.domain)
        .values({ tenantId: auth.tenantId, propertyId, hostname: body.hostname, purpose: body.purpose })
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'domain', entityId: d!.id, data: body });
      return d!;
    });
    return reply.status(201).send(created);
  });
}
