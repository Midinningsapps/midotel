import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../src/booking/pricing.ts';
import { adapters } from '../src/channel/adapters.ts';
import { availNotif, resNotif } from '../src/channel/ota-xml.ts';
import { deliverChannelOutbox } from '../src/channel/sync.ts';
import type { AriDay, BookingMessage, ChannelAdapter } from '../src/channel/types.ts';
import { makeApp, signUp, type Owner } from './helpers.ts';

const ctx = await makeApp();
const { app, pool } = ctx;

// Capture what would be sent to the channel manager.
const pushed: { ari: AriDay[][]; bookings: BookingMessage[] } = { ari: [], bookings: [] };
const original = adapters.simulator;
const capture: ChannelAdapter = {
  ...original,
  pushAri: async (_c, days) => void pushed.ari.push(days),
  pushBooking: async (_c, b) => void pushed.bookings.push(b),
};
adapters.simulator = capture;
afterAll(async () => {
  adapters.simulator = original;
  await app.close();
  await pool.end();
});

const d = (n: number) => addDays(todayIn('Asia/Kolkata'), n);
async function drain() {
  for (let i = 0; i < 10; i++) {
    const r = await deliverChannelOutbox(pool, 100);
    if (!r.sent && !r.failed) break;
  }
}

describe('channel manager sync', () => {
  let owner: Owner;
  let roomId: string;
  let planId: string;
  let nrId: string;
  let conn: { id: string; inboundToken: string; webhookUrl: string };
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: owner.cookie } });
  const inbound = (body: object, token = conn.inboundToken) =>
    app.inject({ method: 'POST', url: `/channels/${conn.id}/inbound`, payload: body, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    owner = await signUp(app, 'Channel');
    roomId = (await api('POST', `/properties/${owner.propertyId}/room-types`, { name: 'Deluxe', code: 'DLX', totalUnits: 4 })).json().id;
    planId = (await api('POST', `/properties/${owner.propertyId}/rate-plans`, { name: 'Breakfast', code: 'CP', mealPlan: 'CP' })).json().id;
    nrId = (await api('POST', `/properties/${owner.propertyId}/rate-plans`, { name: 'Non-refundable', code: 'NR', parentId: planId, deriveKind: 'percent', deriveValue: -10 })).json().id;
    await api('PUT', `/properties/${owner.propertyId}/calendar`, { roomTypeIds: [roomId], ratePlanId: planId, from: d(0), to: d(60), price: 500000 });
    const res = await api('POST', `/properties/${owner.propertyId}/channels`, { provider: 'simulator', hotelCode: 'H-777', master: 'midotel' });
    expect(res.statusCode).toBe(201);
    conn = res.json();
  });

  it('needs room mappings before the connection can be switched on', async () => {
    expect((await api('PATCH', `/channels/${conn.id}`, { isActive: true })).statusCode).toBe(400);
    const map = await api('PUT', `/channels/${conn.id}/mappings`, {
      rooms: [{ roomTypeId: roomId, externalCode: 'CM-DLX' }],
      rates: [
        { roomTypeId: roomId, ratePlanId: planId, externalCode: 'CM-CP' },
        { roomTypeId: roomId, ratePlanId: nrId, externalCode: 'CM-NR' },
      ],
    });
    expect(map.statusCode).toBe(200);
    expect((await api('PATCH', `/channels/${conn.id}`, { isActive: true })).statusCode).toBe(200);
  });

  it('pushes prices and availability when the hotel changes rates (Midotel is master)', async () => {
    pushed.ari.length = 0;
    await api('PUT', `/properties/${owner.propertyId}/calendar`, { roomTypeIds: [roomId], ratePlanId: planId, from: d(10), to: d(11), price: 650000 });
    await drain();
    const days = pushed.ari.flat();
    expect(days.map((x) => x.date)).toEqual([d(10), d(11)]);
    expect(days[0]!.roomCode).toBe('CM-DLX');
    expect(days[0]!.available).toBe(4);
    expect(days[0]!.rates).toEqual([
      { rateCode: 'CM-CP', price: 650000, extraAdult: 0, extraChild: 0 },
      { rateCode: 'CM-NR', price: 585000, extraAdult: 0, extraChild: 0 },
    ]);
  });

  it('pushes a website booking and the reduced availability', async () => {
    pushed.ari.length = 0;
    pushed.bookings.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        propertyId: owner.propertyId,
        checkIn: d(20),
        checkOut: d(22),
        adults: 2,
        children: 0,
        selections: [{ roomTypeId: roomId, ratePlanId: planId, quantity: 1 }],
        guest: { name: 'Web Guest', email: 'web@guest.example', phone: '+91 90000 00001' },
        paymentMode: 'pay_at_hotel',
      },
    });
    expect(res.statusCode).toBe(201);
    await drain();
    expect(pushed.bookings).toHaveLength(1);
    expect(pushed.bookings[0]!).toMatchObject({ status: 'confirmed', rooms: [{ roomCode: 'CM-DLX', rateCode: 'CM-CP', adults: 2 }] });
    const after = pushed.ari.flat().filter((x) => x.date === d(20));
    expect(after[0]!.available).toBe(3);
  });

  it('records an OTA booking from the channel manager and blocks the room on the website', async () => {
    const body = {
      type: 'booking',
      action: 'new',
      externalReference: 'BDC-123456',
      channelName: 'Booking.com',
      checkIn: d(30),
      checkOut: d(31),
      total: 787500,
      guest: { name: 'Lena Fischer', email: null, phone: null },
      rooms: [
        { roomCode: 'CM-DLX', rateCode: 'CM-CP', adults: 2 },
        { roomCode: 'CM-DLX', rateCode: 'CM-CP', adults: 2 },
        { roomCode: 'CM-DLX', rateCode: 'CM-CP', adults: 2 },
        { roomCode: 'CM-DLX', rateCode: 'CM-CP', adults: 2 },
      ],
    };
    expect((await inbound(body, 'wrong-token-wrong-token')).statusCode).toBe(401);
    const res = await inbound(body);
    expect(res.statusCode).toBe(200);
    expect(res.json().notes[0]).toMatch(/created MD\w+ from Booking.com BDC-123456/);

    // Sending the same booking again does not create a duplicate.
    const again = await inbound(body);
    expect(again.json().notes[0]).toMatch(/duplicate/);

    const search = await app.inject({ method: 'POST', url: '/public/availability', payload: { propertyId: owner.propertyId, checkIn: d(30), checkOut: d(31), adults: 2, children: 0 } });
    expect(search.json().offers[0].available).toBe(0);

    const list = (await api('GET', `/properties/${owner.propertyId}/bookings`)).json();
    const ota = list.find((b: { externalReference: string }) => b.externalReference === 'BDC-123456');
    expect(ota).toMatchObject({ source: 'channel', channelName: 'Booking.com', status: 'confirmed', total: 787500 });

    // Cancel from the OTA frees the rooms again.
    const cancel = await inbound({ ...body, action: 'cancel' });
    expect(cancel.json().notes[0]).toMatch(/cancelled/);
    const search2 = await app.inject({ method: 'POST', url: '/public/availability', payload: { propertyId: owner.propertyId, checkIn: d(30), checkOut: d(31), adults: 2, children: 0 } });
    expect(search2.json().offers[0].available).toBe(4);
  });

  it('rejects unknown room codes and logs every inbound message', async () => {
    const res = await inbound({ type: 'booking', action: 'new', externalReference: 'X1', checkIn: d(40), checkOut: d(41), total: 1000, guest: { name: 'A' }, rooms: [{ roomCode: 'NOPE', adults: 1 }] });
    expect(res.statusCode).toBe(422);
    const chans = (await api('GET', `/properties/${owner.propertyId}/channels`)).json();
    const outcomes = chans[0].inbound.map((i: { outcome: string }) => i.outcome);
    expect(outcomes).toContain('error');
    expect(outcomes).toContain('applied');
    expect(JSON.stringify(chans)).not.toContain(conn.inboundToken);
  });

  it('when the channel manager is master, applies its rates and availability', async () => {
    await api('PATCH', `/channels/${conn.id}`, { master: 'channel_manager' });
    const res = await inbound({ type: 'ari', updates: [{ roomCode: 'CM-DLX', rateCode: 'CM-CP', from: d(45), to: d(46), price: 720000, available: 2 }] });
    expect(res.statusCode).toBe(200);
    const search = await app.inject({ method: 'POST', url: '/public/availability', payload: { propertyId: owner.propertyId, checkIn: d(45), checkOut: d(46), adults: 2, children: 0 } });
    const offer = search.json().offers[0];
    expect(offer.available).toBe(2);
    expect(offer.rates.find((r: { ratePlanId: string }) => r.ratePlanId === planId).subtotal).toBe(720000);
  });

  it("keeps one hotel's connections private", async () => {
    const other = await signUp(app, 'Spy');
    expect((await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/channels`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/channels/${conn.id}`, payload: { isActive: false }, headers: { cookie: other.cookie } })).statusCode).toBe(404);
  });
});

describe('OTA XML drafts', () => {
  it('escapes values and builds the expected elements', () => {
    const xml = availNotif('H&1', [{ roomCode: 'R<1>', date: '2026-12-01', available: 3, closed: false, closedToArrival: true, closedToDeparture: false, minStay: 2, maxStay: null, rates: [] }], 'e1');
    expect(xml).toContain('<OTA_HotelAvailNotifRQ');
    expect(xml).toContain('HotelCode="H&amp;1"');
    expect(xml).toContain('InvTypeCode="R&lt;1&gt;"');
    expect(xml).toContain('BookingLimit="3"');
    expect(xml).toContain('Restriction="Arrival" Status="Close"');
    expect(xml).toContain('SetMinLOS" Time="2"');
    const res = resNotif('H1', { reference: 'MD1', status: 'cancelled', createdAt: '2026-11-18T00:00:00Z', checkIn: '2026-12-01', checkOut: '2026-12-02', currency: 'INR', total: 525000, paid: 0, guest: { name: 'Asha Rao', email: 'a@b.c', phone: null }, specialRequests: null, rooms: [{ roomCode: 'DLX', rateCode: 'CP', adults: 2, children: 0, amount: 525000 }] }, 'e2');
    expect(res).toContain('ResStatus="Cancel"');
    expect(res).toContain('AmountAfterTax="5250.00"');
    expect(res).toContain('<GivenName>Asha</GivenName><Surname>Rao</Surname>');
  });
});
