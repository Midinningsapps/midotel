// Queue booking emails in the same transaction as the booking change, then deliver them in the background.
import type pg from 'pg';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@midotel/db';
import { describePolicy } from '../booking/pricing.ts';
import type { MailSender } from './senders.ts';
import { cleanParam, renderTemplate, toWhatsAppNumber, type TemplateName, type WhatsAppSender } from './whatsapp.ts';
import { money } from './templates.ts';
import { guestCancellation, guestConfirmation, hotelAlert, type EmailBooking, type EmailHotel } from './templates.ts';

export const MAX_ATTEMPTS = 5;
const bookingBase = () => process.env.BOOKING_PUBLIC_URL ?? 'http://localhost:3002';
const adminBase = () => process.env.ADMIN_PUBLIC_URL ?? 'http://localhost:3000';

type BookingRow = typeof schema.booking.$inferSelect;

async function context(db: Db, bookingId: string) {
  const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
  if (!b) throw new Error('booking not found');
  const [p] = await db.select().from(schema.property).where(eq(schema.property.id, b.propertyId));
  const rooms = await db.select().from(schema.bookingRoom).where(eq(schema.bookingRoom.bookingId, b.id));
  const booking: EmailBooking = { ...b, rooms };
  const hotel: EmailHotel = {
    name: p!.name,
    phone: p!.phone,
    email: p!.email,
    address: [p!.addressLine, p!.city, p!.state, p!.postalCode].filter(Boolean).join(', '),
    checkInTime: p!.checkInTime.slice(0, 5),
    checkOutTime: p!.checkOutTime.slice(0, 5),
  };
  return { b, p: p!, booking, hotel };
}

async function enqueue(db: Db, b: BookingRow, from: string, replyTo: string | null, template: string, to: string, r: { subject: string; html: string; text: string }) {
  await db.insert(schema.messageOutbox).values({
    tenantId: b.tenantId,
    propertyId: b.propertyId,
    bookingId: b.id,
    template,
    recipient: to,
    replyTo,
    fromName: from,
    subject: r.subject,
    bodyHtml: r.html,
    bodyText: r.text,
  });
}

/** WhatsApp is only queued when the guest opted in, the number is usable, and a sender exists. */
export const whatsappEnabled = { value: true };

async function enqueueWhatsApp(db: Db, b: BookingRow, fromName: string, template: TemplateName, params: string[]) {
  if (!whatsappEnabled.value || !b.whatsappOptIn) return;
  const to = toWhatsAppNumber(b.guestPhone);
  if (!to) return;
  const clean = params.map(cleanParam);
  const text = renderTemplate(template, clean);
  await db.insert(schema.messageOutbox).values({
    tenantId: b.tenantId,
    propertyId: b.propertyId,
    bookingId: b.id,
    channel: 'whatsapp',
    template: `whatsapp_${template}`,
    recipient: to,
    replyTo: null,
    fromName,
    subject: `WhatsApp: ${template === 'booking_confirmed' ? 'booking confirmed' : 'booking cancelled'} (${b.reference})`,
    bodyHtml: `<pre style="white-space:pre-wrap;font-family:inherit">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`,
    bodyText: text,
    payload: { template, language: 'en', params: clean },
  });
}

const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Booking confirmed (pay at hotel, or payment received): email the guest and alert the hotel. */
export async function queueConfirmation(db: Db, bookingId: string, manageToken: string | null) {
  const { b, p, booking, hotel } = await context(db, bookingId);
  const manageUrl = manageToken ? `${bookingBase()}/booking/${b.reference}?token=${encodeURIComponent(manageToken)}` : null;
  await enqueue(db, b, p.name, p.email, 'guest_confirmation', b.guestEmail, guestConfirmation(booking, hotel, { manageUrl, policyText: describePolicy(b.cancellationPolicy) }));
  const nights = Math.round((Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 864e5);
  await enqueueWhatsApp(db, b, p.name, 'booking_confirmed', [
    firstName(b.guestName),
    p.name,
    `${shortDay(b.checkIn)}, from ${hotel.checkInTime}`,
    String(nights),
    b.reference,
    b.total > b.paid ? `${money(b.total, b.currency)} (${money(b.total - b.paid, b.currency)} to pay at the hotel)` : `${money(b.total, b.currency)}, paid`,
    manageUrl ?? (p.phone ? `call ${p.phone}` : '-'),
  ]);
  for (const to of p.notificationEmails) {
    await enqueue(db, b, 'Midotel', b.guestEmail, 'hotel_new_booking', to, hotelAlert(booking, hotel, 'new', { adminUrl: `${adminBase()}/properties/${p.id}` }));
  }
}

export async function queueCancellation(db: Db, bookingId: string, refunded: number, notifyGuest = true) {
  const { b, p, booking, hotel } = await context(db, bookingId);
  if (notifyGuest) {
    await enqueue(db, b, p.name, p.email, 'guest_cancellation', b.guestEmail, guestCancellation(booking, hotel, { refunded }));
    await enqueueWhatsApp(db, b, p.name, 'booking_cancelled', [
      firstName(b.guestName),
      p.name,
      b.reference,
      refunded ? `A refund of ${money(refunded, b.currency)} is on its way to your original payment method.` : (b.cancelPenalty ? `Cancellation charge: ${money(b.cancelPenalty, b.currency)}.` : 'There is no cancellation charge.'),
    ]);
  }
  for (const to of p.notificationEmails) {
    await enqueue(db, b, 'Midotel', b.guestEmail, 'hotel_cancellation', to, hotelAlert(booking, hotel, 'cancelled', { adminUrl: `${adminBase()}/properties/${p.id}` }));
  }
}

/** Send due messages. Safe to run from several processes at once (rows are claimed with SKIP LOCKED). */
export async function deliverOutbox(pool: pg.Pool, sender: MailSender, limit = 20, whatsapp: WhatsAppSender | null = null): Promise<{ sent: number; failed: number }> {
  const { rows } = await pool.query<{
    id: string;
    recipient: string;
    from_name: string;
    reply_to: string | null;
    subject: string;
    body_html: string;
    body_text: string;
    channel: string;
    payload: { template: string; language: string; params: string[] } | null;
  }>('SELECT * FROM claim_outbox_messages($1)', [limit]);
  let sent = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      let r: { providerId: string };
      if (m.channel === 'email') {
        r = await sender.send({ to: m.recipient, fromName: m.from_name, replyTo: m.reply_to, subject: m.subject, html: m.body_html, text: m.body_text, messageId: m.id });
      } else if (m.channel === 'whatsapp' && whatsapp && m.payload) {
        r = await whatsapp.send({ to: m.recipient, payload: m.payload, text: m.body_text, messageId: m.id });
      } else {
        throw new Error(`No sender configured for ${m.channel}`);
      }
      await pool.query('SELECT settle_outbox_message($1, true, NULL, $2, $3)', [m.id, r.providerId, MAX_ATTEMPTS]);
      sent++;
    } catch (err) {
      await pool.query('SELECT settle_outbox_message($1, false, $2, NULL, $3)', [m.id, (err as Error).message, MAX_ATTEMPTS]);
      failed++;
    }
  }
  return { sent, failed };
}
