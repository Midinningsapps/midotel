import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, assertPropertyExists, HttpError, requireAuth, type Role } from '../app.ts';
import { audit } from '../audit.ts';

const EDITORS: Role[] = ['owner', 'manager', 'content_editor'];
const small = (min: number) => z.number().int().min(min).max(500);

const RoomTypeFields = z.object({
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,20}$/, 'Code: up to 20 letters, digits, - or _'),
  shortDescription: z.string().trim().max(500).nullable().optional(),
  description: z.string().trim().max(10000).nullable().optional(),
  baseOccupancy: small(1),
  maxAdults: small(1),
  maxChildren: small(0),
  maxOccupancy: small(1),
  totalUnits: small(0),
  sizeSqft: z.number().int().positive().max(100000).nullable().optional(),
  bedType: z.string().trim().max(60).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10000),
  isActive: z.boolean(),
});

function checkOccupancy(v: { baseOccupancy: number; maxAdults: number; maxChildren: number; maxOccupancy: number }) {
  if (v.maxOccupancy > v.maxAdults + v.maxChildren) {
    throw new HttpError(400, 'Max occupancy cannot exceed max adults plus max children');
  }
  if (v.baseOccupancy > v.maxOccupancy) throw new HttpError(400, 'Base occupancy cannot exceed max occupancy');
}

const CreateRoomType = RoomTypeFields.partial().required({ name: true, code: true });

export async function roomTypeRoutes(app: FastifyInstance) {
  const pool = app.pool;

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/room-types', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      return db
        .select()
        .from(schema.roomType)
        .where(eq(schema.roomType.propertyId, propertyId))
        .orderBy(asc(schema.roomType.sortOrder), asc(schema.roomType.name));
    });
  });

  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/room-types', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, EDITORS);
    const body = CreateRoomType.parse(req.body);
    const merged = { baseOccupancy: 2, maxAdults: 2, maxChildren: 1, maxOccupancy: 3, ...body };
    checkOccupancy(merged);
    const created = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [rt] = await db
        .insert(schema.roomType)
        .values({ ...merged, tenantId: auth.tenantId, propertyId })
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'room_type', entityId: rt!.id });
      return rt!;
    });
    return reply.status(201).send(created);
  });

  app.patch<{ Params: { id: string } }>('/room-types/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const body = RoomTypeFields.partial().parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [current] = await db.select().from(schema.roomType).where(eq(schema.roomType.id, id));
      if (!current) throw new HttpError(404, 'Room type not found');
      assertProperty(auth, current.propertyId, EDITORS);
      checkOccupancy({ ...current, ...body });
      const [rt] = await db.update(schema.roomType).set(body).where(eq(schema.roomType.id, id)).returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'room_type', entityId: id, data: body });
      return rt;
    });
  });

  app.delete<{ Params: { id: string } }>('/room-types/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    await withTenant(pool, auth.tenantId, async (db) => {
      const [current] = await db.select().from(schema.roomType).where(eq(schema.roomType.id, id));
      if (!current) throw new HttpError(404, 'Room type not found');
      assertProperty(auth, current.propertyId, ['owner', 'manager']);
      await db.delete(schema.roomType).where(and(eq(schema.roomType.id, id)));
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'delete', entity: 'room_type', entityId: id, data: { name: current.name } });
    });
    return reply.status(204).send();
  });
}
