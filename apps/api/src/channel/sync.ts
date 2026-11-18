// Channel sync: queue changes, deliver them, and apply what the channel manager sends us.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@midotel/db';
import { HttpError } from '../app.ts';
import { addDays, roomNightPrice, stayNights } from '../booking/pricing.ts';
import { hashManageToken, newReference } from '../booking/service.ts';
import { decryptSecret } from '../crypto.ts';
import { queueCancellation, queueConfirmation } from '../notify/outbox.ts';
import { adapters } from './adapters.ts';
import type { AriDay, BookingMessage, ConnectionInfo, InboundEvent } from './types.ts';

export const MAX_CHANNEL_ATTEMPTS = 6;
type Connection = typeof schema.channelConnection.$inferSelect;

async function activeConnections(db: Db, propertyId: string) {
  return db
    .select()
    .from(schema.channelConnection)
    .where(and(eq(schema.channelConnection.propertyId, propertyId), eq(schema.channelConnection.isActive, true)));
}

/** Prices or availability changed: tell channel managers that take ARI from Midotel. */
export async function queueAri(db: Db, propertyId: string, roomTypeIds: string[], from: string, to: string) {
  if (!roomTypeIds.length) return;
  for (const c of await activeConnections(db, propertyId)) {
    if (c.master !== 'midotel') continue;
    await db.insert(schema.channelOutbox).values({ tenantId: c.tenantId, connectionId: c.id, kind: 'ari', payload: { roomTypeIds, from, to } });
  }
}

/** A booking made or cancelled in Midotel: every channel manager must hear so OTAs stop selling the room. */
export async function queueBookingPush(db: Db, booking: typeof schema.booking.$inferSelect) {
  for (const c of await activeConnections(db, booking.propertyId)) {
    if (c.id === booking.channelConnectionId) continue; // it came from this channel manager
    await db.insert(schema.channelOutbox).values({ tenantId: c.tenantId, connectionId: c.id, kind: 'booking', payload: { bookingId: booking.id } });
  }
  if (booking.status === 'confirmed' || booking.status === 'cancelled') {
    const rooms = await db.select({ roomTypeId: schema.bookingRoom.roomTypeId }).from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, booking.id));
    await queueAri(db, booking.propertyId, [...new Set(rooms.map((r) => r.roomTypeId))], booking.checkIn, addDays(booking.checkOut, -1));
  }
}

function connectionInfo(c: Connection): ConnectionInfo {
  return {
    id: c.id,
    provider: c.provider,
    hotelCode: c.hotelCode,
    endpointUrl: c.endpointUrl,
    credentials: c.credentialsEnc ? (JSON.parse(decryptSecret(c.credentialsEnc)) as Record<string, string>) : null,
  };
}

/** Current availability, restrictions and prices for mapped rooms, read at send time so retries never send stale data. */
export async function buildAri(db: Db, c: Connection, roomTypeIds: string[], from: string, to: string): Promise<AriDay[]> {
  const roomMaps = await db.select().from(schema.channelRoomMap).where(and(eq(schema.channelRoomMap.connectionId, c.id), inArray(schema.channelRoomMap.roomTypeId, roomTypeIds)));
  if (!roomMaps.length) return [];
  const ids = roomMaps.map((m) => m.roomTypeId);
  const [rooms, rateMaps, plans, rates, inventory] = await Promise.all([
    db.select().from(schema.roomType).where(inArray(schema.roomType.id, ids)),
    db.select().from(schema.channelRateMap).where(and(eq(schema.channelRateMap.connectionId, c.id), inArray(schema.channelRateMap.roomTypeId, ids))),
    db.select().from(schema.ratePlan).where(eq(schema.ratePlan.propertyId, c.propertyId)),
    db.select().from(schema.roomRate).where(and(inArray(schema.roomRate.roomTypeId, ids), gte(schema.roomRate.date, from), lte(schema.roomRate.date, to))),
    db.select().from(schema.inventoryDay).where(and(inArray(schema.inventoryDay.roomTypeId, ids), gte(schema.inventoryDay.date, from), lte(schema.inventoryDay.date, to))),
  ]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const rateIdx = new Map(rates.map((r) => [`${r.roomTypeId}|${r.ratePlanId}|${r.date}`, r]));
  const invIdx = new Map(inventory.map((i) => [`${i.roomTypeId}|${i.date}`, i]));
  const days: AriDay[] = [];
  for (const map of roomMaps) {
    const room = rooms.find((r) => r.id === map.roomTypeId);
    if (!room) continue;
    for (const date of stayNights(from, addDays(to, 1))) {
      const inv = invIdx.get(`${room.id}|${date}`);
      days.push({
        roomCode: map.externalCode,
        date,
        available: inv ? Math.max(inv.total - inv.sold - inv.held, 0) : room.totalUnits,
        closed: inv?.closed ?? false,
        closedToArrival: inv?.closedToArrival ?? false,
        closedToDeparture: inv?.closedToDeparture ?? false,
        minStay: inv?.minStay ?? null,
        maxStay: inv?.maxStay ?? null,
        rates: rateMaps
          .filter((rm) => rm.roomTypeId === room.id)
          .map((rm) => {
            const plan = planById.get(rm.ratePlanId);
            const baseId = plan?.parentId ?? rm.ratePlanId;
            const base = rateIdx.get(`${room.id}|${baseId}|${date}`);
            const derive = plan?.parentId && plan.deriveKind ? { kind: plan.deriveKind, value: plan.deriveValue ?? 0 } : null;
            return {
              rateCode: rm.externalCode,
              price: base ? roomNightPrice(base, room.baseOccupancy, room.baseOccupancy, 0, derive) : null,
              extraAdult: base?.extraAdult ?? null,
              extraChild: base?.extraChild ?? null,
            };
          }),
      });
    }
  }
  return days;
}

async function buildBookingMessage(db: Db, c: Connection, bookingId: string): Promise<BookingMessage | null> {
  const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
  if (!b || (b.status !== 'confirmed' && b.status !== 'cancelled')) return null;
  const rooms = await db.select().from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, b.id));
  const roomMaps = await db.select().from(schema.channelRoomMap).where(eq(schema.channelRoomMap.connectionId, c.id));
  const rateMaps = await db.select().from(schema.channelRateMap).where(eq(schema.channelRateMap.connectionId, c.id));
  const missing = rooms.filter((r) => !roomMaps.some((m) => m.roomTypeId === r.roomTypeId));
  if (missing.length) throw new Error(`Room "${missing[0]!.roomName}" is not mapped to the channel manager`);
  return {
    reference: b.reference,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    currency: b.currency,
    total: b.total,
    paid: b.paid,
    guest: { name: b.guestName, email: b.guestEmail, phone: b.guestPhone },
    specialRequests: b.specialRequests,
    rooms: rooms.map((r) => ({
      roomCode: roomMaps.find((m) => m.roomTypeId === r.roomTypeId)!.externalCode,
      rateCode: rateMaps.find((m) => m.roomTypeId === r.roomTypeId && m.ratePlanId === r.ratePlanId)?.externalCode ?? null,
      adults: r.adults,
      children: r.children,
      amount: r.subtotal + r.tax,
    })),
  };
}

/** Send due channel messages. Several processes can run this safely. */
export async function deliverChannelOutbox(pool: pg.Pool, limit = 20) {
  const { rows } = await pool.query<{ id: string; tenant_id: string; connection_id: string; kind: 'ari' | 'booking'; payload: { roomTypeIds?: string[]; from?: string; to?: string; bookingId?: string } }>(
    'SELECT * FROM claim_channel_outbox($1)',
    [limit],
  );
  let sent = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      await withTenant(pool, m.tenant_id, async (db) => {
        const [c] = await db.select().from(schema.channelConnection).where(eq(schema.channelConnection.id, m.connection_id));
        if (!c) return;
        const adapter = adapters[c.provider];
        const info = connectionInfo(c);
        if (m.kind === 'ari') {
          const days = await buildAri(db, c, m.payload.roomTypeIds ?? [], m.payload.from!, m.payload.to!);
          if (days.length) await adapter.pushAri(info, days);
        } else {
          const msg = await buildBookingMessage(db, c, m.payload.bookingId!);
          if (msg) await adapter.pushBooking(info, msg);
        }
      });
      await pool.query('SELECT settle_channel_outbox($1, true, NULL, $2)', [m.id, MAX_CHANNEL_ATTEMPTS]);
      sent++;
    } catch (err) {
      await pool.query('SELECT settle_channel_outbox($1, false, $2, $3)', [m.id, (err as Error).message, MAX_CHANNEL_ATTEMPTS]);
      failed++;
    }
  }
  return { sent, failed };
}

/** Apply bookings and rate/availability updates received from a channel manager. */
export async function applyInbound(db: Db, client: pg.PoolClient, c: Connection, events: InboundEvent[]): Promise<string[]> {
  const notes: string[] = [];
  const roomMaps = await db.select().from(schema.channelRoomMap).where(eq(schema.channelRoomMap.connectionId, c.id));
  const rateMaps = await db.select().from(schema.channelRateMap).where(eq(schema.channelRateMap.connectionId, c.id));
  const roomFor = (code: string) => roomMaps.find((m) => m.externalCode === code)?.roomTypeId;

  for (const e of events) {
    if (e.type === 'ari') {
      if (c.master !== 'channel_manager') {
        notes.push('ignored rate update: Midotel is the master for rates and availability');
        continue;
      }
      for (const u of e.updates) {
        const roomTypeId = roomFor(u.roomCode);
        if (!roomTypeId) throw new HttpError(422, `Unknown room code ${u.roomCode}`);
        const dates = stayNights(u.from, addDays(u.to, 1));
        if (u.price !== undefined && u.rateCode) {
          const rm = rateMaps.find((m) => m.roomTypeId === roomTypeId && m.externalCode === u.rateCode);
          if (!rm) throw new HttpError(422, `Unknown rate code ${u.rateCode}`);
          const [plan] = await db.select().from(schema.ratePlan).where(eq(schema.ratePlan.id, rm.ratePlanId));
          if (plan?.parentId) {
            notes.push(`ignored price for derived plan ${u.rateCode}`);
          } else {
            await client.query(
              `INSERT INTO room_rate (tenant_id, property_id, room_type_id, rate_plan_id, date, price)
               SELECT $1, $2, $3, $4, d::date, $6 FROM unnest($5::date[]) d
               ON CONFLICT (room_type_id, rate_plan_id, date) DO UPDATE SET price = EXCLUDED.price`,
              [c.tenantId, c.propertyId, roomTypeId, rm.ratePlanId, dates, u.price],
            );
          }
        }
        if (u.available !== undefined || u.closed !== undefined) {
          await client.query(
            `INSERT INTO inventory_day (tenant_id, property_id, room_type_id, date, total)
             SELECT $1, $2, rt.id, d::date, rt.total_units FROM room_type rt, unnest($4::date[]) d WHERE rt.id = $3
             ON CONFLICT (room_type_id, date) DO NOTHING`,
            [c.tenantId, c.propertyId, roomTypeId, dates],
          );
          // The channel manager reports rooms still free to sell; our total = that + what is already sold or held here.
          await client.query(
            `UPDATE inventory_day SET
               total = CASE WHEN $3::int IS NULL THEN total ELSE $3::int + sold + held END,
               closed = coalesce($4, closed)
             WHERE room_type_id = $1 AND date = ANY($2::date[])`,
            [roomTypeId, dates, u.available ?? null, u.closed ?? null],
          );
        }
      }
      notes.push(`applied ${e.updates.length} rate/availability update(s)`);
      continue;
    }

    // Bookings from OTAs.
    const [existing] = await db
      .select()
      .from(schema.booking)
      .where(and(eq(schema.booking.channelConnectionId, c.id), eq(schema.booking.externalReference, e.externalReference)));
    if (e.action === 'cancel') {
      if (!existing) {
        notes.push(`cancel for unknown booking ${e.externalReference} ignored`);
        continue;
      }
      if (existing.status === 'cancelled') {
        notes.push(`booking ${e.externalReference} already cancelled`);
        continue;
      }
      const rooms = await db.select().from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, existing.id));
      for (const r of rooms) {
        await client.query(`UPDATE inventory_day SET sold = greatest(sold - 1, 0) WHERE room_type_id = $1 AND date = ANY($2::date[])`, [
          r.roomTypeId,
          r.nights.map((n) => n.date),
        ]);
      }
      const [cancelled] = await db
        .update(schema.booking)
        .set({ status: 'cancelled', cancelledAt: new Date(), cancelPenalty: 0 })
        .where(eq(schema.booking.id, existing.id))
        .returning();
      await queueCancellation(db, existing.id, 0, false);
      await queueBookingPush(db, cancelled!);
      notes.push(`cancelled ${existing.reference}`);
      continue;
    }
    if (existing) {
      notes.push(e.action === 'modify' ? `modification of ${e.externalReference} needs manual handling` : `duplicate booking ${e.externalReference} ignored`);
      continue;
    }
    const nights = stayNights(e.checkIn, e.checkOut);
    if (!nights.length) throw new HttpError(422, 'Check-out must be after check-in');
    const lines = e.rooms.map((r) => {
      const roomTypeId = roomFor(r.roomCode);
      if (!roomTypeId) throw new HttpError(422, `Unknown room code ${r.roomCode}`);
      const ratePlanId = rateMaps.find((m) => m.roomTypeId === roomTypeId && m.externalCode === r.rateCode)?.ratePlanId ?? rateMaps.find((m) => m.roomTypeId === roomTypeId)?.ratePlanId;
      if (!ratePlanId) throw new HttpError(422, `No rate plan mapped for room ${r.roomCode}`);
      return { ...r, roomTypeId, ratePlanId };
    });
    const [roomRows, planRows] = await Promise.all([
      db.select().from(schema.roomType).where(inArray(schema.roomType.id, lines.map((l) => l.roomTypeId))),
      db.select().from(schema.ratePlan).where(inArray(schema.ratePlan.id, lines.map((l) => l.ratePlanId))),
    ]);
    // The OTA has already sold these rooms, so we record them even if that overbooks; the hotel is warned below.
    let overbooked = false;
    for (const l of lines) {
      await client.query(
        `INSERT INTO inventory_day (tenant_id, property_id, room_type_id, date, total)
         SELECT $1, $2, rt.id, d::date, rt.total_units FROM room_type rt, unnest($4::date[]) d WHERE rt.id = $3
         ON CONFLICT (room_type_id, date) DO NOTHING`,
        [c.tenantId, c.propertyId, l.roomTypeId, nights],
      );
      const { rows } = await client.query<{ over: boolean }>(
        `UPDATE inventory_day SET sold = sold + 1 WHERE room_type_id = $1 AND date = ANY($2::date[]) RETURNING (sold + held > total OR closed) AS over`,
        [l.roomTypeId, nights],
      );
      if (rows.some((r) => r.over)) overbooked = true;
    }
    const share = Math.floor(e.total / lines.length);
    const [b] = await db
      .insert(schema.booking)
      .values({
        tenantId: c.tenantId,
        propertyId: c.propertyId,
        reference: newReference(),
        status: 'confirmed',
        source: 'channel',
        channelConnectionId: c.id,
        channelName: e.channelName,
        externalReference: e.externalReference,
        checkIn: e.checkIn,
        checkOut: e.checkOut,
        guestName: e.guest.name,
        guestEmail: e.guest.email ?? '',
        guestPhone: e.guest.phone ?? '',
        specialRequests: [e.specialRequests, overbooked ? 'WARNING: this booking overbooks the room type.' : null].filter(Boolean).join(' ') || null,
        adults: lines.reduce((s, l) => s + l.adults, 0),
        children: lines.reduce((s, l) => s + l.children, 0),
        currency: e.currency,
        subtotal: e.total, // OTA totals include taxes; the split is not always provided
        tax: 0,
        total: e.total,
        paymentMode: 'pay_at_hotel',
        confirmedAt: new Date(),
        manageTokenHash: hashManageToken(randomBytes(24).toString('base64url')),
      })
      .returning();
    await db.insert(schema.bookingRoom).values(
      lines.map((l, i) => ({
        tenantId: c.tenantId,
        bookingId: b!.id,
        roomTypeId: l.roomTypeId,
        ratePlanId: l.ratePlanId,
        roomName: roomRows.find((r) => r.id === l.roomTypeId)!.name,
        ratePlanName: planRows.find((p) => p.id === l.ratePlanId)!.name,
        adults: l.adults,
        children: l.children,
        nights: nights.map((date) => ({ date, price: 0, tax: 0 })),
        subtotal: i === 0 ? e.total - share * (lines.length - 1) : share,
        tax: 0,
      })),
    );
    await queueConfirmation(db, b!.id, null, { guest: false }); // the OTA emails the guest itself
    await queueBookingPush(db, b!);
    notes.push(`created ${b!.reference} from ${e.channelName ?? 'channel'} ${e.externalReference}${overbooked ? ' (OVERBOOKED)' : ''}`);
  }
  return notes;
}

