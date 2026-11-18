// Email content for booking events. Plain, mobile-friendly HTML with a text version. All values are escaped.
interface NightPrice {
  date: string;
  price: number;
  tax: number;
}

export interface EmailBooking {
  reference: string;
  status: string;
  checkIn: string;
  checkOut: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  specialRequests: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  paymentMode: 'pay_now' | 'pay_at_hotel';
  cancelPenalty: number | null;
  rooms: { roomName: string; ratePlanName: string; adults: number; children: number; nights: NightPrice[] }[];
}

export interface EmailHotel {
  name: string;
  phone: string | null;
  email: string | null;
  address: string;
  checkInTime: string;
  checkOutTime: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const money = (paise: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const nights = (b: EmailBooking) => Math.round((Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 864e5);
const guests = (r: EmailBooking['rooms'][number]) => `${r.adults} adult${r.adults === 1 ? '' : 's'}${r.children ? `, ${r.children} child${r.children === 1 ? '' : 'ren'}` : ''}`;

function layout(hotel: EmailHotel, title: string, inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f3;font-family:Arial,Helvetica,sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f3;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#1f4e5f;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:bold">${esc(hotel.name)}</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>${inner}</td></tr>
<tr><td style="padding:16px 24px;background:#fafaf8;color:#626a73;font-size:12px;line-height:1.5">
${esc(hotel.name)}${hotel.address ? `<br>${esc(hotel.address)}` : ''}${hotel.phone ? `<br>Phone: ${esc(hotel.phone)}` : ''}${hotel.email ? `<br>Email: ${esc(hotel.email)}` : ''}
</td></tr></table></td></tr></table></body></html>`;
}

function row(label: string, value: string, strong = false) {
  return `<tr><td style="padding:6px 0;color:#626a73;font-size:14px">${esc(label)}</td><td style="padding:6px 0;text-align:right;font-size:14px${strong ? ';font-weight:bold' : ''}">${esc(value)}</td></tr>`;
}

function summary(b: EmailBooking, hotel: EmailHotel) {
  const lines = [
    row('Booking reference', b.reference, true),
    row('Check-in', `${day(b.checkIn)} from ${hotel.checkInTime}`),
    row('Check-out', `${day(b.checkOut)} by ${hotel.checkOutTime}`),
    row('Nights', String(nights(b))),
    ...b.rooms.map((r) => row(`${r.roomName} · ${r.ratePlanName}`, guests(r))),
    row('Room charges', money(b.subtotal, b.currency)),
    row('Taxes (GST)', money(b.tax, b.currency)),
    row('Total', money(b.total, b.currency), true),
    row('Paid', money(b.paid, b.currency)),
  ];
  if (b.status === 'confirmed' && b.total > b.paid) lines.push(row('To pay at the hotel', money(b.total - b.paid, b.currency), true));
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e5e9;border-bottom:1px solid #e2e5e9;margin:12px 0">${lines.join('')}</table>`;
  const text = [
    `Booking reference: ${b.reference}`,
    `Check-in: ${day(b.checkIn)} from ${hotel.checkInTime}`,
    `Check-out: ${day(b.checkOut)} by ${hotel.checkOutTime}`,
    ...b.rooms.map((r) => `${r.roomName} (${r.ratePlanName}): ${guests(r)}`),
    `Total: ${money(b.total, b.currency)} (incl. GST ${money(b.tax, b.currency)})`,
    `Paid: ${money(b.paid, b.currency)}`,
    ...(b.status === 'confirmed' && b.total > b.paid ? [`To pay at the hotel: ${money(b.total - b.paid, b.currency)}`] : []),
  ].join('\n');
  return { html, text };
}

const button = (href: string, label: string) =>
  `<p style="margin:20px 0"><a href="${esc(href)}" style="background:#c8873a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;

export function guestConfirmation(b: EmailBooking, hotel: EmailHotel, opts: { manageUrl: string | null; policyText: string }): Rendered {
  const s = summary(b, hotel);
  const first = b.guestName.split(' ')[0] ?? b.guestName;
  const inner = `<p style="font-size:15px;line-height:1.5">Dear ${esc(first)}, thank you for booking directly with us. We look forward to welcoming you.</p>
${s.html}
<p style="font-size:13px;color:#626a73;line-height:1.5"><strong>Cancellation policy:</strong> ${esc(opts.policyText)}</p>
${opts.manageUrl ? button(opts.manageUrl, 'View or cancel your booking') : ''}
${b.specialRequests ? `<p style="font-size:13px;color:#626a73">Your requests: ${esc(b.specialRequests)}</p>` : ''}`;
  return {
    subject: `Booking confirmed: ${hotel.name}, ${day(b.checkIn)} (${b.reference})`,
    html: layout(hotel, 'Your booking is confirmed', inner),
    text: `Dear ${first}, your booking at ${hotel.name} is confirmed.\n\n${s.text}\n\nCancellation policy: ${opts.policyText}\n${opts.manageUrl ? `\nView or cancel your booking: ${opts.manageUrl}\n` : ''}`,
  };
}

export function guestCancellation(b: EmailBooking, hotel: EmailHotel, opts: { refunded: number }): Rendered {
  const s = summary(b, hotel);
  const charge = b.cancelPenalty ?? 0;
  const money2 = (p: number) => money(p, b.currency);
  const outcome = `Cancellation charge: ${money2(charge)}.${opts.refunded ? ` A refund of ${money2(opts.refunded)} has been issued to your original payment method; banks usually take 5 to 7 working days.` : ''}`;
  return {
    subject: `Booking cancelled: ${hotel.name} (${b.reference})`,
    html: layout(hotel, 'Your booking has been cancelled', `<p style="font-size:15px;line-height:1.5">${esc(outcome)}</p>${s.html}<p style="font-size:13px;color:#626a73">We hope to welcome you another time.</p>`),
    text: `Your booking ${b.reference} at ${hotel.name} has been cancelled.\n${outcome}\n\n${s.text}\n`,
  };
}

export function hotelAlert(b: EmailBooking, hotel: EmailHotel, kind: 'new' | 'cancelled', opts: { adminUrl: string | null }): Rendered {
  const s = summary(b, hotel);
  const what = kind === 'new' ? 'New booking' : 'Booking cancelled';
  const payment = b.paymentMode === 'pay_at_hotel' ? 'Pay at hotel' : `Paid online ${money(b.paid, b.currency)}`;
  const inner = `<p style="font-size:15px">${esc(b.guestName)} · ${esc(b.guestPhone)} · ${esc(b.guestEmail)}</p>
<p style="font-size:14px;color:#626a73">${esc(payment)}${kind === 'cancelled' && b.cancelPenalty !== null ? ` · Charge kept ${esc(money(b.cancelPenalty, b.currency))}` : ''}</p>
${s.html}
${b.specialRequests ? `<p style="font-size:14px"><strong>Guest requests:</strong> ${esc(b.specialRequests)}</p>` : ''}
${opts.adminUrl ? button(opts.adminUrl, 'Open in Midotel') : ''}`;
  return {
    subject: `${what}: ${b.guestName}, ${day(b.checkIn)}, ${money(b.total, b.currency)} (${b.reference})`,
    html: layout(hotel, what, inner),
    text: `${what}\n${b.guestName} · ${b.guestPhone} · ${b.guestEmail}\n${payment}\n\n${s.text}\n${b.specialRequests ? `\nGuest requests: ${b.specialRequests}\n` : ''}`,
  };
}
