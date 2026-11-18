import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import pg from 'pg';
import { addDays, todayIn } from '../src/booking/pricing.ts';
import { expireHolds } from '../src/booking/service.ts';
import { makeApp, signUp, type Owner } from './helpers.ts';

const ctx = await makeApp();
const { app, pool } = ctx;
afterAll(async () => {
  await app.close();
  await pool.end();
});

const today = todayIn('Asia/Kolkata');
const d = (n: number) => addDays(today, n);

describe('booking engine', () => {
  let owner: Owner;
  let roomId: string;
  let baseId: string;
  let nrId: string;
  const as = () => ({ cookie: owner.cookie });
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: as() });
  const search = (checkIn: string, checkOut: string, adults = 2, children = 0) =>
    app.inject({ method: 'POST', url: '/public/availability', payload: { propertyId: owner.propertyId, checkIn, checkOut, adults, children } });
  const book = (checkIn: string, checkOut: string, paymentMode: 'pay_now' | 'pay_at_hotel', ratePlanId = baseId, quantity = 1) =>
    app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        propertyId: owner.propertyId,
        checkIn,
        checkOut,
        adults: 2,
        children: 0,
        selections: [{ roomTypeId: roomId, ratePlanId, quantity }],
        guest: { name: 'Asha Rao', email: 'asha@example.com', phone: '+91 98765 43210' },
        paymentMode,
      },
    });

  beforeAll(async () => {
    owner = await signUp(app, 'Booking');
    roomId = (await api('POST', `/properties/${owner.propertyId}/room-types`, { name: 'Courtyard Room', code: 'CRT', totalUnits: 2, maxAdults: 3, maxChildren: 1, maxOccupancy: 3 })).json().id;
    const standard = (await api('POST', `/properties/${owner.propertyId}/cancellation-policies`, {
      name: 'Standard',
      rules: [
        { daysBefore: 3, penaltyType: 'nights', value: 1 },
        { daysBefore: 0, penaltyType: 'percent', value: 100 },
      ],
    })).json();
    const nr = (await api('POST', `/properties/${owner.propertyId}/cancellation-policies`, { name: 'Non-refundable', isNonRefundable: true })).json();
    baseId = (await api('POST', `/properties/${owner.propertyId}/rate-plans`, { name: 'Bed and breakfast', code: 'BB', mealPlan: 'CP', cancellationPolicyId: standard.id })).json().id;
    nrId = (
      await api('POST', `/properties/${owner.propertyId}/rate-plans`, {
        name: 'Save 15%, non-refundable',
        code: 'NR',
        cancellationPolicyId: nr.id,
        parentId: baseId,
        deriveKind: 'percent',
        deriveValue: -15,
      })
    ).json().id;
    const res = await api('PUT', `/properties/${owner.propertyId}/calendar`, {
      roomTypeIds: [roomId],
      ratePlanId: baseId,
      from: d(0),
      to: d(60),
      price: 600000,
      extraAdult: 150000,
      extraChild: 50000,
    });
    expect(res.statusCode).toBe(200);
  });

  it('quotes base and derived plans with GST', async () => {
    const res = await search(d(10), d(12));
    expect(res.statusCode).toBe(200);
    const [room] = res.json().offers;
    expect(room.available).toBe(2);
    const bb = room.rates.find((r: { ratePlanId: string }) => r.ratePlanId === baseId);
    const nr = room.rates.find((r: { ratePlanId: string }) => r.ratePlanId === nrId);
    expect(bb.subtotal).toBe(1200000);
    expect(bb.tax).toBe(60000); // 5% on Rs 6,000 per night
    expect(nr.subtotal).toBe(1020000); // 15% off
    expect(nr.refundable).toBe(false);
    // A third adult adds the extra-adult supplement and moves the night above Rs 7,500, so GST becomes 18%.
    const three = (await search(d(10), d(11), 3)).json().offers[0].rates.find((r: { ratePlanId: string }) => r.ratePlanId === baseId);
    expect(three.subtotal).toBe(750000);
    expect(three.tax).toBe(37500);
  });

  it('rejects past dates, reversed dates and rooms too small for the party', async () => {
    expect((await search(d(-1), d(1))).statusCode).toBe(400);
    expect((await search(d(5), d(5))).statusCode).toBe(400);
    expect((await search(d(5), d(6), 4)).json().offers).toHaveLength(0);
  });

  it('confirms a pay-at-hotel booking and takes the room off sale', async () => {
    const res = await book(d(20), d(22), 'pay_at_hotel');
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('confirmed');
    expect((await search(d(20), d(22))).json().offers[0].available).toBe(1);
    expect((await search(d(22), d(23))).json().offers[0].available).toBe(2); // check-out night is free
  });

  it('never sells the last room twice when two guests book at the same moment', async () => {
    const [a, b] = await Promise.all([book(d(30), d(31), 'pay_at_hotel', baseId, 2), book(d(30), d(31), 'pay_at_hotel', baseId, 2)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((await search(d(30), d(31))).json().offers[0].available).toBe(0);
  });

  it('pay now: holds the room, confirms after a verified payment, ignores forged signatures', async () => {
    const res = await book(d(40), d(41), 'pay_now');
    expect(res.statusCode).toBe(201);
    const { reference, manageToken, payment } = res.json();
    expect(payment.provider).toBe('demo');
    expect((await search(d(40), d(41))).json().offers[0].available).toBe(1); // held

    const forged = await app.inject({ method: 'POST', url: `/public/bookings/${reference}/payment`, payload: { token: manageToken, orderId: payment.orderId, paymentId: 'demo_pay_x', signature: 'f'.repeat(64) } });
    expect(forged.statusCode).toBe(400);

    const sig = (await app.inject({ method: 'POST', url: `/public/bookings/${reference}/demo-checkout`, payload: { token: manageToken, orderId: payment.orderId } })).json();
    const paid = await app.inject({ method: 'POST', url: `/public/bookings/${reference}/payment`, payload: { token: manageToken, ...sig } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().status).toBe('confirmed');
    expect(paid.json().paid).toBe(paid.json().total);

    // The same callback again does not charge or confirm twice.
    const again = await app.inject({ method: 'POST', url: `/public/bookings/${reference}/payment`, payload: { token: manageToken, ...sig } });
    expect(again.json().paid).toBe(paid.json().total);
    expect((await search(d(40), d(41))).json().offers[0].available).toBe(1);
  });

  it('releases rooms when an unpaid hold expires', async () => {
    const res = await book(d(45), d(46), 'pay_now');
    const { reference } = res.json();
    expect((await search(d(45), d(46))).json().offers[0].available).toBe(1);
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await admin.query(`UPDATE booking SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1`, [reference]);
    await admin.end();
    expect(await expireHolds(pool)).toBeGreaterThanOrEqual(1);
    expect((await search(d(45), d(46))).json().offers[0].available).toBe(2);
  });

  it('cancels with the right charge and refunds the rest', async () => {
    // Paid booking more than 3 days out: free cancellation, full refund.
    const res = await book(d(50), d(52), 'pay_now');
    const { reference, manageToken, payment } = res.json();
    const sig = (await app.inject({ method: 'POST', url: `/public/bookings/${reference}/demo-checkout`, payload: { token: manageToken, orderId: payment.orderId } })).json();
    await app.inject({ method: 'POST', url: `/public/bookings/${reference}/payment`, payload: { token: manageToken, ...sig } });
    const cancelled = await app.inject({ method: 'POST', url: `/public/bookings/${reference}/cancel`, payload: { token: manageToken } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(cancelled.json().cancelPenalty).toBe(0);
    expect(cancelled.json().refunded).toBe(payment.amount);
    expect((await search(d(50), d(52))).json().offers[0].available).toBe(2);

    // Non-refundable: the whole amount is kept.
    const nr = await book(d(53), d(54), 'pay_now', nrId);
    const n = nr.json();
    const s2 = (await app.inject({ method: 'POST', url: `/public/bookings/${n.reference}/demo-checkout`, payload: { token: n.manageToken, orderId: n.payment.orderId } })).json();
    await app.inject({ method: 'POST', url: `/public/bookings/${n.reference}/payment`, payload: { token: n.manageToken, ...s2 } });
    const c2 = await app.inject({ method: 'POST', url: `/public/bookings/${n.reference}/cancel`, payload: { token: n.manageToken } });
    expect(c2.json().cancelPenalty).toBe(n.total);
    expect(c2.json().refunded).toBe(0);
  });

  it('applies closures, minimum stay and closed-to-arrival', async () => {
    await api('PUT', `/properties/${owner.propertyId}/calendar`, { roomTypeIds: [roomId], from: d(55), to: d(55), minStay: 2 });
    const one = (await search(d(55), d(56))).json().offers[0];
    expect(one.available).toBe(0);
    expect(one.unavailableReason).toMatch(/Minimum stay is 2/);
    expect((await search(d(55), d(57))).json().offers[0].available).toBe(2);

    await api('PUT', `/properties/${owner.propertyId}/calendar`, { roomTypeIds: [roomId], from: d(58), to: d(58), closed: true });
    expect((await search(d(57), d(59))).json().offers[0].available).toBe(0);
    expect((await book(d(57), d(59), 'pay_at_hotel')).statusCode).toBe(409);
  });

  it('needs the manage token to view a booking, and hides it from other hotels', async () => {
    const res = await book(d(25), d(26), 'pay_at_hotel');
    const { reference, manageToken } = res.json();
    expect((await app.inject({ method: 'GET', url: `/public/bookings/${reference}?token=${manageToken}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/public/bookings/${reference}?token=${'x'.repeat(32)}` })).statusCode).toBe(404);

    const list = await api('GET', `/properties/${owner.propertyId}/bookings`);
    expect(list.json().some((b: { reference: string }) => b.reference === reference)).toBe(true);
    expect(list.json()[0].manageTokenHash).toBeUndefined();

    const other = await signUp(app, 'Rival');
    const theirs = await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/bookings`, headers: { cookie: other.cookie } });
    expect(theirs.statusCode).toBe(404);
    const bookingId = list.json()[0].id;
    expect((await app.inject({ method: 'GET', url: `/bookings/${bookingId}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
  });

  it('stores gateway secrets encrypted and never returns them', async () => {
    const res = await api('PUT', `/properties/${owner.propertyId}/gateway`, { provider: 'razorpay', keyId: 'rzp_test_ABCDEF123456', keySecret: 'super-secret-value', payAtHotel: false });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('super-secret-value');
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    const { rows } = await admin.query('SELECT key_secret_enc FROM gateway_account WHERE property_id = $1', [owner.propertyId]);
    await admin.end();
    expect(rows[0].key_secret_enc).toMatch(/^v1:/);
    expect(rows[0].key_secret_enc).not.toContain('super-secret');
    // Pay at hotel is now switched off.
    expect((await book(d(35), d(36), 'pay_at_hotel')).statusCode).toBe(400);
    // Put the demo gateway back for other tests.
    await api('PUT', `/properties/${owner.propertyId}/gateway`, { provider: 'demo', payAtHotel: true });
  });
});
