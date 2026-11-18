import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { HttpError } from '../app.ts';

// Unauthenticated endpoints used by hotel websites and the booking engine.
export async function publicRoutes(app: FastifyInstance) {
  const pool = app.pool;

  // Resolve a hostname to its property and return what a website or booking page needs.
  app.get('/site', async (req) => {
    const { host } = z.object({ host: z.string().min(1).max(253) }).parse(req.query);
    const { rows } = await pool.query<{ tenant_id: string; property_id: string; purpose: string }>(
      'SELECT * FROM resolve_hostname($1)',
      [host.toLowerCase().split(':')[0]],
    );
    const hit = rows[0];
    if (!hit) throw new HttpError(404, 'Unknown site');
    return withTenant(pool, hit.tenant_id, async (db) => {
      const [p] = await db.select().from(schema.property).where(eq(schema.property.id, hit.property_id));
      if (!p || p.status === 'archived') throw new HttpError(404, 'Unknown site');
      const rooms = await db
        .select({
          id: schema.roomType.id,
          name: schema.roomType.name,
          code: schema.roomType.code,
          shortDescription: schema.roomType.shortDescription,
          description: schema.roomType.description,
          maxAdults: schema.roomType.maxAdults,
          maxChildren: schema.roomType.maxChildren,
          maxOccupancy: schema.roomType.maxOccupancy,
          sizeSqft: schema.roomType.sizeSqft,
          bedType: schema.roomType.bedType,
        })
        .from(schema.roomType)
        .where(and(eq(schema.roomType.propertyId, p.id), eq(schema.roomType.isActive, true)))
        .orderBy(asc(schema.roomType.sortOrder), asc(schema.roomType.name));
      return {
        purpose: hit.purpose,
        property: {
          id: p.id,
          name: p.name,
          tagline: p.tagline,
          description: p.description,
          email: p.email,
          phone: p.phone,
          address: [p.addressLine, p.city, p.state, p.postalCode].filter(Boolean).join(', '),
          latitude: p.latitude === null ? null : Number(p.latitude),
          longitude: p.longitude === null ? null : Number(p.longitude),
          currency: p.currency,
          timezone: p.timezone,
          checkInTime: p.checkInTime,
          checkOutTime: p.checkOutTime,
        },
        rooms,
      };
    });
  });
}
