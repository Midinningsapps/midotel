import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, canAccessProperty, HttpError, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM');

export const PropertyFields = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  tagline: optText(200),
  description: optText(5000),
  propertyType: z.enum(['hotel', 'resort', 'homestay', 'villa', 'camp', 'hostel', 'apartment']),
  starRating: z.number().int().min(1).max(7).nullable().optional(),
  email: z.email().nullable().optional(),
  phone: optText(30),
  addressLine: optText(300),
  city: optText(100),
  state: optText(100),
  country: z.string().length(2).toUpperCase(),
  postalCode: optText(12),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().min(1).max(64),
  currency: z.string().length(3).toUpperCase(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters')
    .nullable()
    .optional(),
  checkInTime: time,
  checkOutTime: time,
  status: z.enum(['draft', 'live', 'archived']),
  amenities: z.array(z.string().trim().min(1).max(60)).max(60),
  notificationEmails: z.array(z.email().max(200)).max(10),
});

const CreateProperty = PropertyFields.pick({ name: true, slug: true }).extend(
  PropertyFields.omit({ name: true, slug: true }).partial().shape,
);
const UpdateProperty = PropertyFields.partial();

/** numeric columns come back as strings from pg; send numbers to clients. */
function toDto(p: typeof schema.property.$inferSelect) {
  return {
    ...p,
    latitude: p.latitude === null ? null : Number(p.latitude),
    longitude: p.longitude === null ? null : Number(p.longitude),
  };
}

function toRow(input: z.infer<typeof UpdateProperty>) {
  const { latitude, longitude, ...rest } = input;
  return {
    ...rest,
    ...(latitude !== undefined && { latitude: latitude === null ? null : String(latitude) }),
    ...(longitude !== undefined && { longitude: longitude === null ? null : String(longitude) }),
  };
}

export async function propertyRoutes(app: FastifyInstance) {
  const pool = app.pool;

  app.get('/', async (req) => {
    const auth = requireAuth(req);
    const rows = await withTenant(pool, auth.tenantId, (db) =>
      db.select().from(schema.property).orderBy(asc(schema.property.name)),
    );
    return rows.filter((p) => canAccessProperty(auth, p.id)).map(toDto);
  });

  app.post('/', async (req, reply) => {
    const auth = requireAuth(req);
    if (!auth.roles.some((r) => r.propertyId === null && (r.role === 'owner' || r.role === 'manager'))) {
      throw new HttpError(403, 'Only owners and managers can add properties');
    }
    const body = CreateProperty.parse(req.body);
    const created = await withTenant(pool, auth.tenantId, async (db) => {
      const [p] = await db
        .insert(schema.property)
        .values({ ...toRow(body), name: body.name, slug: body.slug, tenantId: auth.tenantId })
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'property', entityId: p!.id });
      return p!;
    });
    return reply.status(201).send(toDto(created));
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    assertProperty(auth, id);
    const [p] = await withTenant(pool, auth.tenantId, (db) =>
      db.select().from(schema.property).where(eq(schema.property.id, id)),
    );
    if (!p) throw new HttpError(404, 'Property not found');
    return toDto(p);
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    assertProperty(auth, id, ['owner', 'manager']);
    const body = UpdateProperty.parse(req.body);
    const updated = await withTenant(pool, auth.tenantId, async (db) => {
      const [p] = await db.update(schema.property).set(toRow(body)).where(eq(schema.property.id, id)).returning();
      if (!p) return null;
      await audit(db, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        action: 'update',
        entity: 'property',
        entityId: id,
        data: body,
      });
      return p;
    });
    if (!updated) throw new HttpError(404, 'Property not found');
    return toDto(updated);
  });
}
