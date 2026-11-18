'use client';
import { Suspense, use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { call, money, niceDate, type BookingView } from '@/lib/api';

const STATUS: Record<BookingView['status'], string> = {
  confirmed: 'Confirmed',
  pending_payment: 'Awaiting payment',
  cancelled: 'Cancelled',
  expired: 'Expired (not paid in time)',
};

function Manage({ reference }: { reference: string }) {
  const token = useSearchParams().get('token') ?? '';
  const [b, setB] = useState<BookingView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<BookingView>(`/bookings/${reference}?token=${encodeURIComponent(token)}`).then(setB).catch((e) => setError(e.message));
  }, [reference, token]);

  async function cancel() {
    const charge = b!.cancellationChargeIfCancelledToday;
    const msg = charge
      ? `Cancelling now costs ${money(charge, b!.currency)}. Cancel anyway?`
      : 'Cancel this booking? There is no charge.';
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      setB(await call<BookingView>(`/bookings/${reference}/cancel`, { token }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="wrap"><p className="error">{error}</p></div>;
  if (!b) return <div className="wrap muted">Loading…</div>;
  const balance = b.status === 'confirmed' ? b.total - b.paid : 0;
  return (
    <>
      <header className="top">
        <h1>{b.hotel.name}</h1>
        <p>Booking {b.reference}</p>
      </header>
      <div className="wrap" style={{ maxWidth: 720 }}>
        <div className="card">
          <span className={`status ${b.status}`}>{STATUS[b.status]}</span>
          {b.status === 'confirmed' && <h2>Thank you, {b.guestName.split(' ')[0]}. Your stay is booked.</h2>}
          <p className="muted">
            Bookmark this page: its link lets you view or cancel your booking.
          </p>
          <div className="line">
            <span>Check-in</span>
            <span>
              {niceDate(b.checkIn)} from {b.hotel.checkInTime}
            </span>
          </div>
          <div className="line">
            <span>Check-out</span>
            <span>
              {niceDate(b.checkOut)} by {b.hotel.checkOutTime}
            </span>
          </div>
          {b.rooms.map((r, i) => (
            <div className="line" key={i}>
              <span>
                {r.roomName} · {r.ratePlanName}
              </span>
              <span>
                {r.adults} adult{r.adults === 1 ? '' : 's'}
                {r.children ? `, ${r.children} child${r.children === 1 ? '' : 'ren'}` : ''}
              </span>
            </div>
          ))}
          <div className="line">
            <span>Room charges</span>
            <span>{money(b.subtotal, b.currency)}</span>
          </div>
          <div className="line">
            <span>Taxes (GST)</span>
            <span>{money(b.tax, b.currency)}</span>
          </div>
          <div className="line total">
            <span>Total</span>
            <span>{money(b.total, b.currency)}</span>
          </div>
          <div className="line">
            <span>Paid</span>
            <span>{money(b.paid, b.currency)}</span>
          </div>
          {balance > 0 && (
            <div className="line">
              <span>To pay at the hotel</span>
              <strong>{money(balance, b.currency)}</strong>
            </div>
          )}
          {b.status === 'cancelled' && (
            <p className="muted">
              Cancellation charge: {money(b.cancelPenalty ?? 0, b.currency)}
              {b.refunded ? `. Refund of ${money(b.refunded, b.currency)} issued to your original payment method.` : ''}
            </p>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Cancellation policy</h3>
          <p className="muted">{b.policyText}</p>
          {b.status === 'confirmed' && (
            <button className="btn" disabled={busy} onClick={cancel}>
              {busy ? 'Cancelling…' : 'Cancel booking'}
            </button>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Hotel contact</h3>
          {b.hotel.address && <p className="muted">{b.hotel.address}</p>}
          {b.hotel.phone && <p className="muted">Phone: {b.hotel.phone}</p>}
          {b.hotel.email && <p className="muted">Email: {b.hotel.email}</p>}
        </div>
      </div>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = use(params);
  return (
    <Suspense fallback={<div className="wrap muted">Loading…</div>}>
      <Manage reference={reference} />
    </Suspense>
  );
}
