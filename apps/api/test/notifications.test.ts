import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import pg from 'pg';
import { addDays, todayIn } from '../src/booking/pricing.ts';
import { deliverOutbox, MAX_ATTEMPTS } from '../src/notify/outbox.ts';
import type { MailSender, OutgoingEmail } from '../src/notify/senders.ts';
import { makeApp, signUp, type Owner } from './helpers.ts';

const ctx = await makeApp();
const { app, pool } = ctx;
afterAll(async () => {
  await app.close();
  await pool.end();
});

const d = (n: number) => addDays(todayIn('Asia/Kolkata'), n);

function memorySender(fail = false): MailSender & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    name: 'memory',
    sent,
    async send(m) {
      if (fail) throw new Error('mail server down');
      sent.push(m);
      return { providerId: `mem-${sent.length}` };
    },
  };
}

async function drain(sender: MailSender) {
  // Other test files share the database; deliver until nothing is due.
  for (let i = 0; i < 10; i++) {
    const r = await deliverOutbox(pool, sender, 100);
    if (!r.sent && !r.failed) break;
  }
}

describe('booking emails', () => {
  let owner: Owner;
  let roomId: string;
  let planId: string;
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: owner.cookie } });

  beforeAll(async () => {
    owner = await signUp(app, 'Mail');
    await api('PATCH', `/properties/${owner.propertyId}`, { notificationEmails: ['frontdesk@mail-hotel.example'], email: 'stay@mail-hotel.example' });
    roomId = (await api('POST', `/properties/${owner.propertyId}/room-types`, { name: 'Garden Room', code: 'GDN', totalUnits: 3 })).json().id;
    planId = (await api('POST', `/properties/${owner.propertyId}/rate-plans`, { name: 'Room only', code: 'RO' })).json().id;
    await api('PUT', `/properties/${owner.propertyId}/calendar`, { roomTypeIds: [roomId], ratePlanId: planId, from: d(0), to: d(40), price: 400000 });
  });

  const book = (name: string, paymentMode: 'pay_now' | 'pay_at_hotel') =>
    app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        propertyId: owner.propertyId,
        checkIn: d(10),
        checkOut: d(12),
        adults: 2,
        children: 0,
        selections: [{ roomTypeId: roomId, ratePlanId: planId, quantity: 1 }],
        guest: { name, email: 'guest@mail-guest.example', phone: '+91 99999 11111', specialRequests: 'Late arrival <b>please</b>' },
        paymentMode,
      },
    });

  it('queues a guest confirmation and a hotel alert for pay-at-hotel bookings, and sends them', async () => {
    const res = await book('Meera <script>alert(1)</script> Iyer', 'pay_at_hotel');
    const { reference, manageToken } = res.json();
    const sender = memorySender();
    await drain(sender);
    const mine = sender.sent.filter((m) => m.subject.includes(reference));
    expect(mine.map((m) => m.to).sort()).toEqual(['frontdesk@mail-hotel.example', 'guest@mail-guest.example']);
    const guest = mine.find((m) => m.to === 'guest@mail-guest.example')!;
    expect(guest.subject).toMatch(/^Booking confirmed/);
    expect(guest.replyTo).toBe('stay@mail-hotel.example');
    expect(guest.html).toContain(`/booking/${reference}?token=${encodeURIComponent(manageToken)}`);
    expect(guest.html).toContain('₹8,400'); // 2 nights x Rs 4,000 + 5% GST
    // Guest-typed text is escaped, never injected as HTML.
    const alert = mine.find((m) => m.to === 'frontdesk@mail-hotel.example')!;
    expect(alert.html).not.toContain('<script>');
    expect(alert.html).toContain('&lt;script&gt;');
    expect(alert.html).toContain('Late arrival &lt;b&gt;please&lt;/b&gt;');
  });

  it('sends nothing while a pay-now booking waits for payment, then confirms after payment', async () => {
    const res = await book('Kabir Shah', 'pay_now');
    const { reference, manageToken, payment } = res.json();
    const before = memorySender();
    await drain(before);
    expect(before.sent.filter((m) => m.subject.includes(reference))).toHaveLength(0);

    const sig = (await app.inject({ method: 'POST', url: `/public/bookings/${reference}/demo-checkout`, payload: { token: manageToken, orderId: payment.orderId } })).json();
    await app.inject({ method: 'POST', url: `/public/bookings/${reference}/payment`, payload: { token: manageToken, ...sig } });
    // A repeated payment callback must not send a second confirmation.
    await app.inject({ method: 'POST', url: `/public/bookings/${reference}/payment`, payload: { token: manageToken, ...sig } });
    const after = memorySender();
    await drain(after);
    expect(after.sent.filter((m) => m.subject.includes(reference)).map((m) => m.to).sort()).toEqual(['frontdesk@mail-hotel.example', 'guest@mail-guest.example']);

    await app.inject({ method: 'POST', url: `/public/bookings/${reference}/cancel`, payload: { token: manageToken } });
    const cancel = memorySender();
    await drain(cancel);
    const g = cancel.sent.find((m) => m.subject.includes(reference) && m.to === 'guest@mail-guest.example')!;
    expect(g.subject).toMatch(/^Booking cancelled/);
    expect(g.text).toContain('refund');
  });

  it('retries a failed send and gives up after the last attempt', async () => {
    const res = await book('Retry Guest', 'pay_at_hotel');
    const { reference } = res.json();
    const down = memorySender(true);
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await deliverOutbox(pool, down, 100);
      // Skip the back-off wait in the test.
      await admin.query(`UPDATE message_outbox SET send_after = now() WHERE subject LIKE $1 AND status = 'pending'`, [`%${reference}%`]);
    }
    const { rows } = await admin.query(`SELECT status, attempts, last_error FROM message_outbox WHERE subject LIKE $1`, [`%${reference}%`]);
    await admin.end();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.status).toBe('failed');
      expect(r.attempts).toBe(MAX_ATTEMPTS);
      expect(r.last_error).toContain('mail server down');
    }
    // Staff can see and retry it.
    const list = (await api('GET', `/properties/${owner.propertyId}/messages`)).json();
    const failed = list.find((m: { status: string; subject: string }) => m.status === 'failed' && m.subject.includes(reference));
    expect((await api('POST', `/messages/${failed.id}/retry`)).statusCode).toBe(200);
    const ok = memorySender();
    await drain(ok);
    expect(ok.sent.some((m) => m.subject.includes(reference))).toBe(true);
  });

  it("does not show one hotel's emails to another", async () => {
    const other = await signUp(app, 'Nosy');
    const list = (await api('GET', `/properties/${owner.propertyId}/messages`)).json();
    expect(list.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: `/messages/${list[0].id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/properties/${owner.propertyId}/messages`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
  });
});
