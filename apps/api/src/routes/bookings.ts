// Hotel staff: reservations list, details, cancellation, and phone/desk bookings.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, assertPropertyExists, HttpError, requireAuth, type Role } from '../app.ts';
import { audit } from '../audit.ts';
import { cancelBooking, loadBookingRooms } from '../booking/service.ts';
import { gatewayFor, refundPayments } from './public-booking.ts';
import { queueCancellation } from '../notify/outbox.ts';
import { queueBookingPush } from '../channel/sync.ts';

const STAFF: Role[] = ['owner', 'manager', 'front_desk'];

export async function bookingRoutes(app: FastifyInstance) {
  const pool = app.pool;

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/bookings', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, STAFF);
    const q = z
      .object({
        status: z.enum(['pending_payment', 'confirmed', 'cancelled', 'expired']).optional(),
        arrivalFrom: z.string().optional(),
        arrivalTo: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const where = [eq(schema.booking.propertyId, propertyId)];
      if (q.status) where.push(eq(schema.booking.status, q.status));
      if (q.arrivalFrom) where.push(gte(schema.booking.checkIn, q.arrivalFrom));
      if (q.arrivalTo) where.push(lte(schema.booking.checkIn, q.arrivalTo));
      const rows = await db.select().from(schema.booking).where(and(...where)).orderBy(desc(schema.booking.createdAt)).limit(q.limit);
      const rooms = await loadBookingRooms(db, rows.map((r) => r.id));
      return rows.map(({ manageTokenHash: _, ...b }) => ({
        ...b,
        rooms: rooms.filter((r) => r.bookingId === b.id).map((r) => ({ roomName: r.roomName, ratePlanName: r.ratePlanName, adults: r.adults, children: r.children })),
      }));
    });
  });

  app.get<{ Params: { id: string } }>('/bookings/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, id));
      if (!b) throw new HttpError(404, 'Booking not found');
      assertProperty(auth, b.propertyId, STAFF);
      const rooms = await db.select().from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, id));
      const payments = await db.select().from(schema.payment).where(eq(schema.payment.bookingId, id)).orderBy(desc(schema.payment.createdAt));
      const { manageTokenHash: _, ...rest } = b;
      return { ...rest, rooms, payments };
    });
  });

  app.post<{ Params: { id: string } }>('/bookings/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const body = z.object({ waivePenalty: z.boolean().default(false), notifyGuest: z.boolean().default(true) }).parse(req.body ?? {});
    return withTenant(pool, auth.tenantId, async (db, client) => {
      const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, id)).for('update');
      if (!b) throw new HttpError(404, 'Booking not found');
      assertProperty(auth, b.propertyId, body.waivePenalty ? ['owner', 'manager'] : STAFF);
      const [prop] = await db.select().from(schema.property).where(eq(schema.property.id, b.propertyId));
      const result = await cancelBooking(db, client, b, { timezone: prop!.timezone, waivePenalty: body.waivePenalty });
      const refunded = result.refund > 0 ? await refundPayments(db, b, result.refund, await gatewayFor(db, b.propertyId)) : 0;
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'cancel', entity: 'booking', entityId: id, data: { ...result, refunded } });
      await queueCancellation(db, b.id, refunded, body.notifyGuest);
      if (b.status === 'confirmed') {
        const [fresh] = await db.select().from(schema.booking).where(eq(schema.booking.id, b.id));
        await queueBookingPush(db, fresh!);
      }
      return { ...result, refunded };
    });
  });

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/bookings-summary', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, STAFF);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const rows = await db
        .select({ status: schema.booking.status, total: schema.booking.total, paid: schema.booking.paid })
        .from(schema.booking)
        .where(and(eq(schema.booking.propertyId, propertyId), inArray(schema.booking.status, ['confirmed', 'pending_payment'])));
      const confirmed = rows.filter((r) => r.status === 'confirmed');
      return {
        confirmedBookings: confirmed.length,
        confirmedRevenue: confirmed.reduce((s, r) => s + r.total, 0),
        collected: confirmed.reduce((s, r) => s + r.paid, 0),
        awaitingPayment: rows.length - confirmed.length,
      };
    });
  });

  // Emails sent (or waiting to be sent) for a property, optionally for one booking.
  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/messages', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, STAFF);
    const q = z.object({ bookingId: z.uuid().optional() }).parse(req.query);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const where = [eq(schema.messageOutbox.propertyId, propertyId)];
      if (q.bookingId) where.push(eq(schema.messageOutbox.bookingId, q.bookingId));
      return db
        .select({
          id: schema.messageOutbox.id,
          bookingId: schema.messageOutbox.bookingId,
          template: schema.messageOutbox.template,
          recipient: schema.messageOutbox.recipient,
          subject: schema.messageOutbox.subject,
          status: schema.messageOutbox.status,
          attempts: schema.messageOutbox.attempts,
          lastError: schema.messageOutbox.lastError,
          sentAt: schema.messageOutbox.sentAt,
          createdAt: schema.messageOutbox.createdAt,
        })
        .from(schema.messageOutbox)
        .where(and(...where))
        .orderBy(desc(schema.messageOutbox.createdAt))
        .limit(100);
    });
  });

  app.get<{ Params: { id: string } }>('/messages/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [m] = await db.select().from(schema.messageOutbox).where(eq(schema.messageOutbox.id, id));
      if (!m) throw new HttpError(404, 'Message not found');
      assertProperty(auth, m.propertyId, STAFF);
      return m;
    });
  });

  // Resend a failed message.
  app.post<{ Params: { id: string } }>('/messages/:id/retry', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [m] = await db.select().from(schema.messageOutbox).where(eq(schema.messageOutbox.id, id));
      if (!m) throw new HttpError(404, 'Message not found');
      assertProperty(auth, m.propertyId, STAFF);
      if (m.status !== 'failed') throw new HttpError(409, 'Only failed messages can be retried');
      await db.update(schema.messageOutbox).set({ status: 'pending', attempts: 0, sendAfter: new Date(), lastError: null }).where(eq(schema.messageOutbox.id, id));
      return { ok: true };
    });
  });
}
