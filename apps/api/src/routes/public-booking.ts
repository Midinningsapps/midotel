// Guest-facing booking engine API. No login: bookings are reached with their reference plus a secret manage token.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@midotel/db';
import { HttpError } from '../app.ts';
import { cancelBooking, confirmPaidBooking, createBooking, hashManageToken, searchAvailability } from '../booking/service.ts';
import { cancellationPenalty, describePolicy, todayIn } from '../booking/pricing.ts';
import { decryptSecret } from '../crypto.ts';
import { demoGateway, razorpay, type Gateway } from '../payments.ts';
import { mediaUrl } from '../site-data.ts';
import { audit } from '../audit.ts';
import { queueCancellation, queueConfirmation } from '../notify/outbox.ts';

const Phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');

const StayBody = z.object({
  propertyId: z.uuid(),
  checkIn: z.string(),
  checkOut: z.string(),
  adults: z.number().int().min(1).max(10),
  children: z.number().int().min(0).max(10).default(0),
});

const BookBody = StayBody.extend({
  selections: z
    .array(z.object({ roomTypeId: z.uuid(), ratePlanId: z.uuid(), quantity: z.number().int().min(1).max(10) }))
    .min(1)
    .max(10),
  guest: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.email().max(200),
    phone: Phone,
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters')
      .nullable()
      .optional(),
    specialRequests: z.string().trim().max(1000).nullable().optional(),
  }),
  paymentMode: z.enum(['pay_now', 'pay_at_hotel']),
});

/** The hotel's own gateway, or the demo gateway when none is set up yet. */
export async function gatewayFor(db: Db, propertyId: string): Promise<Gateway & { payAtHotel: boolean }> {
  const [g] = await db.select().from(schema.gatewayAccount).where(eq(schema.gatewayAccount.propertyId, propertyId));
  if (g?.provider === 'razorpay' && g.keyId && g.keySecretEnc) {
    return Object.assign(razorpay(g.keyId, decryptSecret(g.keySecretEnc)), { payAtHotel: g.payAtHotel });
  }
  return Object.assign(demoGateway(), { payAtHotel: g?.payAtHotel ?? true });
}

/** Refund up to `amount` across the booking's captured payments, newest first. */
export async function refundPayments(db: Db, booking: typeof schema.booking.$inferSelect, amount: number, gateway: Gateway): Promise<number> {
  const charges = await db
    .select()
    .from(schema.payment)
    .where(and(eq(schema.payment.bookingId, booking.id), eq(schema.payment.kind, 'charge'), eq(schema.payment.status, 'captured')));
  let left = amount;
  for (const c of charges) {
    if (left <= 0) break;
    const part = Math.min(left, c.amount);
    const r = await gateway.refund(c.providerPaymentId!, part);
    await db.insert(schema.payment).values({
      tenantId: booking.tenantId,
      bookingId: booking.id,
      provider: gateway.provider,
      kind: 'refund',
      providerOrderId: c.providerOrderId,
      providerPaymentId: r.refundId,
      amount: part,
      status: r.status,
    });
    left -= part;
  }
  const refunded = amount - left;
  if (refunded) await db.update(schema.booking).set({ paid: booking.paid - refunded }).where(eq(schema.booking.id, booking.id));
  return refunded;
}

async function tenantForProperty(app: FastifyInstance, propertyId: string): Promise<string> {
  const { rows } = await app.pool.query<{ t: string | null }>('SELECT property_tenant($1) AS t', [propertyId]);
  if (!rows[0]?.t) throw new HttpError(404, 'Hotel not found');
  return rows[0].t;
}

async function tenantForBooking(app: FastifyInstance, reference: string): Promise<string> {
  const { rows } = await app.pool.query<{ t: string | null }>('SELECT booking_tenant($1) AS t', [reference]);
  if (!rows[0]?.t) throw new HttpError(404, 'Booking not found');
  return rows[0].t;
}

async function loadProperty(db: Db, propertyId: string) {
  const [p] = await db.select().from(schema.property).where(eq(schema.property.id, propertyId));
  if (!p || p.status === 'archived') throw new HttpError(404, 'Hotel not found');
  return p;
}

/** Find a booking by reference and check the guest's manage token. */
async function guestBooking(db: Db, reference: string, token: string, lock = false) {
  const query = db.select().from(schema.booking).where(eq(schema.booking.reference, reference.toUpperCase()));
  const [b] = lock ? await query.for('update') : await query;
  if (!b || b.manageTokenHash !== hashManageToken(token)) throw new HttpError(404, 'Booking not found');
  return b;
}

async function bookingView(db: Db, b: typeof schema.booking.$inferSelect) {
  const p = await loadProperty(db, b.propertyId);
  const rooms = await db.select().from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, b.id));
  const today = todayIn(p.timezone);
  return {
    reference: b.reference,
    status: b.status,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    guestName: b.guestName,
    guestEmail: b.guestEmail,
    guestPhone: b.guestPhone,
    specialRequests: b.specialRequests,
    currency: b.currency,
    subtotal: b.subtotal,
    tax: b.tax,
    total: b.total,
    paid: b.paid,
    paymentMode: b.paymentMode,
    holdExpiresAt: b.holdExpiresAt,
    cancelPenalty: b.cancelPenalty,
    policyText: describePolicy(b.cancellationPolicy),
    cancellationChargeIfCancelledToday:
      b.status === 'confirmed' ? cancellationPenalty(b.cancellationPolicy, b.checkIn, today, rooms) : 0,
    rooms: rooms.map((r) => ({ roomName: r.roomName, ratePlanName: r.ratePlanName, adults: r.adults, children: r.children, nights: r.nights, subtotal: r.subtotal, tax: r.tax })),
    hotel: { name: p.name, phone: p.phone, email: p.email, address: [p.addressLine, p.city, p.state, p.postalCode].filter(Boolean).join(', '), checkInTime: p.checkInTime.slice(0, 5), checkOutTime: p.checkOutTime.slice(0, 5) },
  };
}

export async function publicBookingRoutes(app: FastifyInstance) {
  const pool = app.pool;

  // Everything the booking engine shows before a search.
  app.get<{ Params: { propertyId: string } }>('/booking-engine/:propertyId', async (req) => {
    const propertyId = z.uuid().parse(req.params.propertyId);
    const tenantId = await tenantForProperty(app, propertyId);
    return withTenant(pool, tenantId, async (db) => {
      const p = await loadProperty(db, propertyId);
      const rooms = await db
        .select()
        .from(schema.roomType)
        .where(and(eq(schema.roomType.propertyId, propertyId), eq(schema.roomType.isActive, true)))
        .orderBy(asc(schema.roomType.sortOrder));
      const g = await gatewayFor(db, propertyId);
      return {
        property: { id: p.id, name: p.name, tagline: p.tagline, currency: p.currency, timezone: p.timezone, checkInTime: p.checkInTime.slice(0, 5), checkOutTime: p.checkOutTime.slice(0, 5), phone: p.phone, email: p.email, amenities: p.amenities },
        today: todayIn(p.timezone),
        rooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          shortDescription: r.shortDescription,
          description: r.description,
          sizeSqft: r.sizeSqft,
          bedType: r.bedType,
          maxAdults: r.maxAdults,
          maxChildren: r.maxChildren,
          maxOccupancy: r.maxOccupancy,
          images: r.imageIds.map((i) => mediaUrl(tenantId, i)),
        })),
        payment: { provider: g.provider, payAtHotel: g.payAtHotel },
      };
    });
  });

  app.post('/availability', async (req, reply) => {
    const body = StayBody.parse(req.body);
    const tenantId = await tenantForProperty(app, body.propertyId);
    const offers = await withTenant(pool, tenantId, async (db) => {
      const p = await loadProperty(db, body.propertyId);
      return searchAvailability(db, p, body);
    });
    reply.header('cache-control', 'no-store');
    return { offers };
  });

  // Create the booking. Pay now: rooms are held while the guest pays. Pay at hotel: confirmed straight away.
  app.post('/bookings', async (req, reply) => {
    const body = BookBody.parse(req.body);
    const tenantId = await tenantForProperty(app, body.propertyId);
    const result = await withTenant(pool, tenantId, async (db, client) => {
      const p = await loadProperty(db, body.propertyId);
      const gateway = await gatewayFor(db, p.id);
      if (body.paymentMode === 'pay_at_hotel' && !gateway.payAtHotel) throw new HttpError(400, 'This hotel asks for payment when booking');
      const { booking, manageToken } = await createBooking(db, client, {
        tenantId,
        property: p,
        stay: body,
        selections: body.selections,
        guest: body.guest,
        paymentMode: body.paymentMode,
        source: 'website',
      });
      let payment = null;
      if (body.paymentMode === 'pay_now') {
        const order = await gateway.createOrder(booking.total, booking.currency, booking.reference);
        await db.insert(schema.payment).values({
          tenantId,
          bookingId: booking.id,
          provider: gateway.provider,
          providerOrderId: order.orderId,
          amount: order.amount,
          status: 'created',
        });
        payment = { provider: gateway.provider, keyId: gateway.publicKey, orderId: order.orderId, amount: order.amount, currency: order.currency };
      }
      await audit(db, { tenantId, userId: null, action: 'create', entity: 'booking', entityId: booking.id, data: { reference: booking.reference, mode: body.paymentMode } });
      if (booking.status === 'confirmed') await queueConfirmation(db, booking.id, manageToken);
      return { reference: booking.reference, manageToken, status: booking.status, total: booking.total, holdExpiresAt: booking.holdExpiresAt, payment };
    });
    return reply.status(201).send(result);
  });

  app.get<{ Params: { reference: string }; Querystring: { token?: string } }>('/bookings/:reference', async (req, reply) => {
    const token = z.string().min(10).max(200).parse(req.query.token);
    const tenantId = await tenantForBooking(app, req.params.reference);
    reply.header('cache-control', 'no-store');
    return withTenant(pool, tenantId, async (db) => bookingView(db, await guestBooking(db, req.params.reference, token)));
  });

  // Called by the checkout page after the gateway reports success. The signature proves it came from the gateway.
  app.post<{ Params: { reference: string } }>('/bookings/:reference/payment', async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(10).max(200) }).parse(req.body);
    const tenantId = await tenantForBooking(app, req.params.reference);
    return withTenant(pool, tenantId, async (db, client) => {
      const b = await guestBooking(db, req.params.reference, body.token, true);
      const gateway = await gatewayFor(db, b.propertyId);
      const [pay] = await db.select().from(schema.payment).where(and(eq(schema.payment.bookingId, b.id), eq(schema.payment.providerOrderId, body.orderId)));
      if (!pay) throw new HttpError(400, 'Unknown payment order');
      if (!gateway.verify(body.orderId, body.paymentId, body.signature)) throw new HttpError(400, 'Payment could not be verified');
      if (pay.status === 'captured') return bookingView(db, b); // repeated callback
      await db.update(schema.payment).set({ status: 'captured', providerPaymentId: body.paymentId }).where(eq(schema.payment.id, pay.id));
      const { alreadyConfirmed } = await confirmPaidBooking(db, client, b, pay.amount);
      if (!alreadyConfirmed) await queueConfirmation(db, b.id, body.token);
      await audit(db, { tenantId, userId: null, action: 'payment', entity: 'booking', entityId: b.id, data: { amount: pay.amount, provider: gateway.provider } });
      const [fresh] = await db.select().from(schema.booking).where(eq(schema.booking.id, b.id));
      return bookingView(db, fresh!);
    });
  });

  // Demo checkout only: produces the signature a real gateway would, so the full flow can be shown without real money.
  app.post<{ Params: { reference: string } }>('/bookings/:reference/demo-checkout', async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), orderId: z.string().min(1).max(100) }).parse(req.body);
    const tenantId = await tenantForBooking(app, req.params.reference);
    return withTenant(pool, tenantId, async (db) => {
      const b = await guestBooking(db, req.params.reference, body.token);
      const gateway = await gatewayFor(db, b.propertyId);
      if (gateway.provider !== 'demo') throw new HttpError(400, 'This hotel takes real payments');
      const paymentId = `demo_pay_${Math.random().toString(36).slice(2, 12)}`;
      return { orderId: body.orderId, paymentId, signature: demoGateway().sign(body.orderId, paymentId) };
    });
  });

  app.post<{ Params: { reference: string } }>('/bookings/:reference/cancel', async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const tenantId = await tenantForBooking(app, req.params.reference);
    return withTenant(pool, tenantId, async (db, client) => {
      const b = await guestBooking(db, req.params.reference, token, true);
      const p = await loadProperty(db, b.propertyId);
      const result = await cancelBooking(db, client, b, { timezone: p.timezone });
      const refunded = result.refund > 0 ? await refundPayments(db, b, result.refund, await gatewayFor(db, b.propertyId)) : 0;
      await audit(db, { tenantId, userId: null, action: 'cancel', entity: 'booking', entityId: b.id, data: { ...result, refunded, by: 'guest' } });
      await queueCancellation(db, b.id, refunded);
      const [fresh] = await db.select().from(schema.booking).where(eq(schema.booking.id, b.id));
      return { ...(await bookingView(db, fresh!)), refunded };
    });
  });
}
