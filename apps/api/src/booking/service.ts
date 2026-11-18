// Availability, holds, confirmation and cancellation. Every function runs inside withTenant().
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { schema, type Db } from '@midotel/db';
import { HttpError } from '../app.ts';
import {
  addDays,
  cancellationPenalty,
  daysBetween,
  describePolicy,
  isDate,
  priceStay,
  stayNights,
  todayIn,
  type BaseRate,
  type PolicySnapshot,
  type PricedNight,
  type TaxSlab,
} from './pricing.ts';

export const MAX_NIGHTS = 30;
export const MAX_ADVANCE_DAYS = 500;
export const HOLD_MINUTES = 15;

export interface StayQuery {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
}

export interface RateOffer {
  ratePlanId: string;
  name: string;
  description: string | null;
  mealPlan: string;
  refundable: boolean;
  policy: PolicySnapshot | null;
  policyText: string;
  nights: PricedNight[];
  subtotal: number;
  tax: number;
  total: number;
}

export interface RoomOffer {
  roomTypeId: string;
  name: string;
  code: string;
  available: number;
  unavailableReason: string | null;
  baseOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  rates: RateOffer[];
}

export function validateStay(q: StayQuery, timezone: string, now = new Date()) {
  if (!isDate(q.checkIn) || !isDate(q.checkOut)) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  const nights = daysBetween(q.checkIn, q.checkOut);
  if (nights < 1) throw new HttpError(400, 'Check-out must be after check-in');
  if (nights > MAX_NIGHTS) throw new HttpError(400, `Stays can be at most ${MAX_NIGHTS} nights online`);
  const today = todayIn(timezone, now);
  if (q.checkIn < today) throw new HttpError(400, 'Check-in cannot be in the past');
  if (daysBetween(today, q.checkIn) > MAX_ADVANCE_DAYS) throw new HttpError(400, 'That date is too far ahead');
  if (q.adults < 1) throw new HttpError(400, 'At least one adult is required');
  return { today, nights: stayNights(q.checkIn, q.checkOut) };
}

async function policyMap(db: Db, propertyId: string) {
  const rows = await db.select().from(schema.cancellationPolicy).where(eq(schema.cancellationPolicy.propertyId, propertyId));
  return new Map(rows.map((p) => [p.id, { name: p.name, rules: p.rules, isNonRefundable: p.isNonRefundable } satisfies PolicySnapshot]));
}

/** Rooms and prices sellable for one room with this occupancy over these dates. */
export async function searchAvailability(
  db: Db,
  property: { id: string; timezone: string; taxSlabs: TaxSlab[] },
  q: StayQuery,
  now = new Date(),
): Promise<RoomOffer[]> {
  const { nights } = validateStay(q, property.timezone, now);
  const [rooms, plans, policies] = await Promise.all([
    db
      .select()
      .from(schema.roomType)
      .where(and(eq(schema.roomType.propertyId, property.id), eq(schema.roomType.isActive, true)))
      .orderBy(asc(schema.roomType.sortOrder), asc(schema.roomType.name)),
    db
      .select()
      .from(schema.ratePlan)
      .where(and(eq(schema.ratePlan.propertyId, property.id), eq(schema.ratePlan.isActive, true)))
      .orderBy(asc(schema.ratePlan.sortOrder), asc(schema.ratePlan.name)),
    policyMap(db, property.id),
  ]);
  const rates = await db
    .select()
    .from(schema.roomRate)
    .where(and(eq(schema.roomRate.propertyId, property.id), gte(schema.roomRate.date, q.checkIn), lt(schema.roomRate.date, q.checkOut)));
  const inventory = await db
    .select()
    .from(schema.inventoryDay)
    .where(and(eq(schema.inventoryDay.propertyId, property.id), gte(schema.inventoryDay.date, q.checkIn), lt(schema.inventoryDay.date, addDays(q.checkOut, 1))));

  const rateKey = (rt: string, rp: string, d: string) => `${rt}|${rp}|${d}`;
  const rateIndex = new Map<string, BaseRate>(rates.map((r) => [rateKey(r.roomTypeId, r.ratePlanId, r.date), r]));
  const invIndex = new Map(inventory.map((i) => [`${i.roomTypeId}|${i.date}`, i]));
  const plansById = new Map(plans.map((p) => [p.id, p]));

  return rooms
    .filter((rt) => q.adults <= rt.maxAdults && q.children <= rt.maxChildren && q.adults + q.children <= rt.maxOccupancy)
    .map((rt) => {
      let available = rt.totalUnits;
      let reason: string | null = null;
      for (const d of nights) {
        const inv = invIndex.get(`${rt.id}|${d}`);
        const free = inv ? (inv.closed ? 0 : inv.total - inv.sold - inv.held) : rt.totalUnits;
        available = Math.min(available, Math.max(free, 0));
      }
      const arrival = invIndex.get(`${rt.id}|${q.checkIn}`);
      const departure = invIndex.get(`${rt.id}|${q.checkOut}`);
      if (arrival?.closedToArrival) reason = 'Arrival is not possible on this date';
      else if (departure?.closedToDeparture) reason = 'Departure is not possible on this date';
      else if (arrival?.minStay && nights.length < arrival.minStay) reason = `Minimum stay is ${arrival.minStay} nights for these dates`;
      else if (arrival?.maxStay && nights.length > arrival.maxStay) reason = `Maximum stay is ${arrival.maxStay} nights for these dates`;
      if (reason) available = 0;

      const offers: RateOffer[] = [];
      for (const plan of plans) {
        const base = plan.parentId ? plansById.get(plan.parentId) : plan;
        if (!base || base.parentId) continue; // parent inactive, or a chain of derivations (not supported)
        const derive = plan.parentId && plan.deriveKind ? { kind: plan.deriveKind, value: plan.deriveValue ?? 0 } : null;
        const priced = priceStay(nights, (d) => rateIndex.get(rateKey(rt.id, base.id, d)), rt.baseOccupancy, q.adults, q.children, property.taxSlabs, derive);
        if (!priced) continue;
        const policy = plan.cancellationPolicyId ? (policies.get(plan.cancellationPolicyId) ?? null) : null;
        offers.push({
          ratePlanId: plan.id,
          name: plan.name,
          description: plan.description,
          mealPlan: plan.mealPlan,
          refundable: !policy?.isNonRefundable,
          policy,
          policyText: describePolicy(policy),
          ...priced,
        });
      }
      return {
        roomTypeId: rt.id,
        name: rt.name,
        code: rt.code,
        available: offers.length ? available : 0,
        unavailableReason: reason ?? (offers.length ? (available ? null : 'Sold out for these dates') : 'No rates loaded for these dates'),
        baseOccupancy: rt.baseOccupancy,
        maxAdults: rt.maxAdults,
        maxChildren: rt.maxChildren,
        maxOccupancy: rt.maxOccupancy,
        rates: offers,
      };
    });
}

export interface Selection {
  roomTypeId: string;
  ratePlanId: string;
  quantity: number;
}

export interface Guest {
  name: string;
  email: string;
  phone: string;
  gstin?: string | null;
  specialRequests?: string | null;
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function newReference(): string {
  const bytes = randomBytes(8);
  return 'MD' + Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}
export const hashManageToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Reserve inventory and create the booking. Pay-at-hotel bookings are confirmed at once;
 * pay-now bookings hold the rooms for HOLD_MINUTES while the guest pays.
 */
export async function createBooking(
  db: Db,
  client: pg.PoolClient,
  args: {
    tenantId: string;
    property: { id: string; timezone: string; taxSlabs: TaxSlab[]; currency: string };
    stay: StayQuery;
    selections: Selection[];
    guest: Guest;
    paymentMode: 'pay_now' | 'pay_at_hotel';
    source: 'website' | 'desk';
    now?: Date;
  },
) {
  const { property, stay, selections } = args;
  const offers = await searchAvailability(db, property, stay, args.now);
  const nights = stayNights(stay.checkIn, stay.checkOut);

  // Price every selected room server-side; never trust prices from the browser.
  const wantedByRoom = new Map<string, number>();
  const lines: { offer: RoomOffer; rate: RateOffer }[] = [];
  for (const s of selections) {
    const offer = offers.find((o) => o.roomTypeId === s.roomTypeId);
    const rate = offer?.rates.find((r) => r.ratePlanId === s.ratePlanId);
    if (!offer || !rate) throw new HttpError(409, 'That room or rate is no longer available for these dates');
    wantedByRoom.set(s.roomTypeId, (wantedByRoom.get(s.roomTypeId) ?? 0) + s.quantity);
    for (let i = 0; i < s.quantity; i++) lines.push({ offer, rate });
  }
  for (const [roomTypeId, n] of wantedByRoom) {
    const offer = offers.find((o) => o.roomTypeId === roomTypeId)!;
    if (offer.available < n) throw new HttpError(409, `Only ${offer.available} ${offer.name} left for these dates`);
  }

  // Lock inventory: create missing day rows, then take the units atomically. All nights or nothing.
  for (const [roomTypeId, n] of wantedByRoom) {
    await client.query(
      `INSERT INTO inventory_day (tenant_id, property_id, room_type_id, date, total)
       SELECT $1, $2, rt.id, d::date, rt.total_units
       FROM room_type rt, unnest($4::date[]) d
       WHERE rt.id = $3
       ON CONFLICT (room_type_id, date) DO NOTHING`,
      [args.tenantId, property.id, roomTypeId, nights],
    );
    const column = args.paymentMode === 'pay_at_hotel' ? 'sold' : 'held';
    const { rowCount } = await client.query(
      `UPDATE inventory_day SET ${column} = ${column} + $3
       WHERE room_type_id = $1 AND date = ANY($2::date[]) AND NOT closed AND total - sold - held >= $3`,
      [roomTypeId, nights, n],
    );
    if (rowCount !== nights.length) throw new HttpError(409, 'Someone just booked the last room. Please search again.');
  }

  const policy = lines.some((l) => l.rate.policy?.isNonRefundable)
    ? lines.find((l) => l.rate.policy?.isNonRefundable)!.rate.policy
    : (lines.map((l) => l.rate.policy).find((p) => p && p.rules.length) ?? null);
  const subtotal = lines.reduce((s, l) => s + l.rate.subtotal, 0);
  const tax = lines.reduce((s, l) => s + l.rate.tax, 0);
  const manageToken = randomBytes(24).toString('base64url');
  const reference = newReference();
  const now = args.now ?? new Date();
  const confirmed = args.paymentMode === 'pay_at_hotel';

  const [b] = await db
    .insert(schema.booking)
    .values({
      tenantId: args.tenantId,
      propertyId: property.id,
      reference,
      status: confirmed ? 'confirmed' : 'pending_payment',
      source: args.source,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      guestName: args.guest.name,
      guestEmail: args.guest.email,
      guestPhone: args.guest.phone,
      guestGstin: args.guest.gstin ?? null,
      specialRequests: args.guest.specialRequests ?? null,
      adults: stay.adults * lines.length,
      children: stay.children * lines.length,
      currency: property.currency,
      subtotal,
      tax,
      total: subtotal + tax,
      paymentMode: args.paymentMode,
      cancellationPolicy: policy,
      holdExpiresAt: confirmed ? null : new Date(now.getTime() + HOLD_MINUTES * 60_000),
      confirmedAt: confirmed ? now : null,
      manageTokenHash: hashManageToken(manageToken),
    })
    .returning();
  await db.insert(schema.bookingRoom).values(
    lines.map((l) => ({
      tenantId: args.tenantId,
      bookingId: b!.id,
      roomTypeId: l.offer.roomTypeId,
      ratePlanId: l.rate.ratePlanId,
      roomName: l.offer.name,
      ratePlanName: l.rate.name,
      adults: stay.adults,
      children: stay.children,
      nights: l.rate.nights,
      subtotal: l.rate.subtotal,
      tax: l.rate.tax,
    })),
  );
  return { booking: b!, manageToken };
}

/** Units per (room type, night) used by a booking. */
async function bookingUnits(db: Db, bookingId: string) {
  const rooms = await db.select().from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, bookingId));
  const units = new Map<string, number>();
  for (const r of rooms) for (const n of r.nights) units.set(`${r.roomTypeId}|${n.date}`, (units.get(`${r.roomTypeId}|${n.date}`) ?? 0) + 1);
  return { rooms, units };
}

async function moveInventory(client: pg.PoolClient, units: Map<string, number>, from: 'held' | 'sold' | null, to: 'held' | 'sold' | null) {
  for (const [key, n] of units) {
    const [roomTypeId, date] = key.split('|');
    const sets = [from && `${from} = greatest(${from} - $3, 0)`, to && `${to} = ${to} + $3`].filter(Boolean).join(', ');
    if (!sets) continue;
    await client.query(`UPDATE inventory_day SET ${sets} WHERE room_type_id = $1 AND date = $2`, [roomTypeId, date, n]);
  }
}

/** A captured payment confirms the booking and turns held rooms into sold rooms. */
export async function confirmPaidBooking(db: Db, client: pg.PoolClient, booking: typeof schema.booking.$inferSelect, amount: number) {
  if (booking.status === 'confirmed') return { alreadyConfirmed: true };
  const { units } = await bookingUnits(db, booking.id);
  if (booking.status === 'pending_payment') {
    await moveInventory(client, units, 'held', 'sold');
  } else if (booking.status === 'expired') {
    // Paid after the hold ran out: take the rooms again if they are still free.
    for (const [key, n] of units) {
      const [roomTypeId, date] = key.split('|');
      const { rowCount } = await client.query(
        `UPDATE inventory_day SET sold = sold + $3 WHERE room_type_id = $1 AND date = $2 AND NOT closed AND total - sold - held >= $3`,
        [roomTypeId, date, n],
      );
      if (rowCount !== 1) throw new HttpError(409, 'The rooms were released before payment arrived. The payment will be refunded.');
    }
  } else {
    throw new HttpError(409, 'This booking was cancelled');
  }
  await db
    .update(schema.booking)
    .set({ status: 'confirmed', paid: booking.paid + amount, confirmedAt: new Date(), holdExpiresAt: null })
    .where(eq(schema.booking.id, booking.id));
  return { alreadyConfirmed: false };
}

export async function cancelBooking(
  db: Db,
  client: pg.PoolClient,
  booking: typeof schema.booking.$inferSelect,
  opts: { timezone: string; waivePenalty?: boolean; now?: Date },
) {
  if (booking.status === 'cancelled' || booking.status === 'expired') throw new HttpError(409, 'This booking is already cancelled');
  const { rooms, units } = await bookingUnits(db, booking.id);
  const today = todayIn(opts.timezone, opts.now);
  if (booking.checkOut <= today) throw new HttpError(409, 'Past stays cannot be cancelled online');
  const penalty =
    opts.waivePenalty || booking.status === 'pending_payment'
      ? 0
      : cancellationPenalty(booking.cancellationPolicy, booking.checkIn, today, rooms);
  await moveInventory(client, units, booking.status === 'pending_payment' ? 'held' : 'sold', null);
  const refund = Math.max(booking.paid - penalty, 0);
  await db
    .update(schema.booking)
    .set({ status: 'cancelled', cancelPenalty: penalty, cancelledAt: new Date(), holdExpiresAt: null })
    .where(eq(schema.booking.id, booking.id));
  return { penalty, refund };
}

export async function expireHolds(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT expire_booking_holds() AS n');
  return rows[0]?.n ?? 0;
}

export async function loadBookingRooms(db: Db, bookingIds: string[]) {
  if (!bookingIds.length) return [];
  return db.select().from(schema.bookingRoom).where(inArray(schema.bookingRoom.bookingId, bookingIds));
}
