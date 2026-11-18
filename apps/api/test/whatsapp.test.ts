import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../src/booking/pricing.ts';
import { deliverOutbox } from '../src/notify/outbox.ts';
import type { MailSender } from '../src/notify/senders.ts';
import { cleanParam, renderTemplate, toWhatsAppNumber, type WhatsAppMessage, type WhatsAppSender } from '../src/notify/whatsapp.ts';
import { makeApp, signUp, type Owner } from './helpers.ts';

describe('WhatsApp phone numbers', () => {
  it('turns Indian mobiles into international numbers', () => {
    expect(toWhatsAppNumber('98765 43210')).toBe('919876543210');
    expect(toWhatsAppNumber('098765-43210')).toBe('919876543210');
    expect(toWhatsAppNumber('+91 98765 43210')).toBe('919876543210');
    expect(toWhatsAppNumber('+44 7700 900123')).toBe('447700900123');
    expect(toWhatsAppNumber('0044 7700 900123')).toBe('447700900123');
  });
  it('rejects numbers WhatsApp cannot use', () => {
    expect(toWhatsAppNumber('12345')).toBeNull();
    expect(toWhatsAppNumber('0294 2345678')).toBeNull(); // Indian landline without country code
  });
  it('cleans template parameters', () => {
    expect(cleanParam('line one\nline two\t  x')).toBe('line one line two x');
    expect(cleanParam('   ')).toBe('-');
    expect(renderTemplate('booking_cancelled', ['Asha', 'Lake Hotel', 'MD123', 'No charge.'])).toBe('Hello Asha, your booking MD123 at Lake Hotel has been cancelled. No charge.');
  });
});

const ctx = await makeApp();
const { app, pool } = ctx;
afterAll(async () => {
  await app.close();
  await pool.end();
});

const d = (n: number) => addDays(todayIn('Asia/Kolkata'), n);
const noEmail: MailSender = { name: 'none', send: async () => ({ providerId: 'x' }) };
function memoryWhatsApp(): WhatsAppSender & { sent: WhatsAppMessage[] } {
  const sent: WhatsAppMessage[] = [];
  return { name: 'memory', sent, send: async (m) => (sent.push(m), { providerId: `wa-${sent.length}` }) };
}

describe('WhatsApp booking messages', () => {
  let owner: Owner;
  let roomId: string;
  let planId: string;
  beforeAll(async () => {
    owner = await signUp(app, 'Whats');
    const api = (method: 'POST' | 'PUT', url: string, payload: object) => app.inject({ method, url, payload, headers: { cookie: owner.cookie } });
    roomId = (await api('POST', `/properties/${owner.propertyId}/room-types`, { name: 'Tent', code: 'TNT', totalUnits: 5 })).json().id;
    planId = (await api('POST', `/properties/${owner.propertyId}/rate-plans`, { name: 'Room only', code: 'RO' })).json().id;
    await api('PUT', `/properties/${owner.propertyId}/calendar`, { roomTypeIds: [roomId], ratePlanId: planId, from: d(0), to: d(30), price: 300000 });
  });

  const book = (optIn: boolean, phone = '98765 43210') =>
    app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        propertyId: owner.propertyId,
        checkIn: d(5),
        checkOut: d(7),
        adults: 2,
        children: 0,
        selections: [{ roomTypeId: roomId, ratePlanId: planId, quantity: 1 }],
        guest: { name: 'Rohan  Verma', email: 'rohan@wa-guest.example', phone },
        paymentMode: 'pay_at_hotel',
        whatsappOptIn: optIn,
      },
    });

  async function drain(wa: WhatsAppSender) {
    for (let i = 0; i < 10; i++) {
      const r = await deliverOutbox(pool, noEmail, 100, wa);
      if (!r.sent && !r.failed) break;
    }
  }

  it('sends a confirmation template to guests who opted in', async () => {
    const { reference, manageToken } = (await book(true)).json();
    const wa = memoryWhatsApp();
    await drain(wa);
    const mine = wa.sent.filter((m) => m.payload.params.includes(reference));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe('919876543210');
    expect(mine[0]!.payload.template).toBe('booking_confirmed');
    expect(mine[0]!.payload.params[0]).toBe('Rohan');
    expect(mine[0]!.payload.params[3]).toBe('2');
    expect(mine[0]!.text).toContain(`token=${encodeURIComponent(manageToken)}`);
    expect(mine[0]!.text).toContain('to pay at the hotel');

    await app.inject({ method: 'POST', url: `/public/bookings/${reference}/cancel`, payload: { token: manageToken } });
    const wa2 = memoryWhatsApp();
    await drain(wa2);
    const cancel = wa2.sent.find((m) => m.payload.params.includes(reference))!;
    expect(cancel.payload.template).toBe('booking_cancelled');
    expect(cancel.text).toContain('no cancellation charge');
  });

  it('sends nothing on WhatsApp without opt-in or with an unusable number', async () => {
    const a = (await book(false)).json();
    const b = (await book(true, '0294 2345678')).json();
    const wa = memoryWhatsApp();
    await drain(wa);
    expect(wa.sent.filter((m) => m.payload.params.includes(a.reference) || m.payload.params.includes(b.reference))).toHaveLength(0);
  });
});
