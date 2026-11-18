'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { call, MEAL_PLANS, money, niceDate, type EngineInfo, type RoomOffer } from '@/lib/api';

type Cart = Record<string, number>; // `${roomTypeId}|${ratePlanId}` -> quantity

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: unknown) => void) => void };
  }
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

interface Created {
  reference: string;
  manageToken: string;
  status: string;
  total: number;
  payment: { provider: 'razorpay' | 'demo'; keyId: string | null; orderId: string; amount: number; currency: string } | null;
}

export function BookingEngine() {
  const params = useSearchParams();
  const router = useRouter();
  const propertyId = params.get('property') ?? '';
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [error, setError] = useState('');
  const [stay, setStay] = useState({ checkIn: params.get('checkIn') ?? '', checkOut: params.get('checkOut') ?? '', adults: Number(params.get('adults') ?? 2), children: Number(params.get('children') ?? 0) });
  const [offers, setOffers] = useState<RoomOffer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<Cart>({});
  const [step, setStep] = useState<'rooms' | 'details' | 'pay'>('rooms');
  const [guest, setGuest] = useState({ name: '', email: '', phone: '', gstin: '', specialRequests: '' });
  const [mode, setMode] = useState<'pay_now' | 'pay_at_hotel'>('pay_now');
  const [whatsapp, setWhatsapp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    if (!propertyId) {
      setError('This booking link is missing the hotel. Please use the Book button on the hotel website.');
      return;
    }
    call<EngineInfo>(`/booking-engine/${propertyId}`)
      .then((i) => {
        setInfo(i);
        setStay((s) => {
          const checkIn = s.checkIn && s.checkIn >= i.today ? s.checkIn : i.today;
          const checkOut = s.checkOut && s.checkOut > checkIn ? s.checkOut : addDays(checkIn, 1);
          return { ...s, checkIn, checkOut };
        });
        if (!i.payment.payAtHotel) setMode('pay_now');
      })
      .catch((e) => setError(e.message));
  }, [propertyId]);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    setSearching(true);
    setError('');
    setCart({});
    setStep('rooms');
    try {
      const r = await call<{ offers: RoomOffer[] }>('/availability', { propertyId, ...stay });
      setOffers(r.offers);
    } catch (err) {
      setError((err as Error).message);
      setOffers(null);
    } finally {
      setSearching(false);
    }
  }
  // Search straight away when arriving from the hotel website with dates.
  useEffect(() => {
    if (info && stay.checkIn && stay.checkOut && offers === null && !searching) search();
  }, [info]);

  const lines = useMemo(() => {
    if (!offers) return [];
    return Object.entries(cart)
      .filter(([, q]) => q > 0)
      .map(([key, quantity]) => {
        const [roomTypeId, ratePlanId] = key.split('|');
        const room = offers.find((o) => o.roomTypeId === roomTypeId)!;
        const rate = room.rates.find((r) => r.ratePlanId === ratePlanId)!;
        return { roomTypeId: roomTypeId!, ratePlanId: ratePlanId!, quantity, room, rate };
      });
  }, [cart, offers]);
  const totals = lines.reduce((t, l) => ({ subtotal: t.subtotal + l.rate.subtotal * l.quantity, tax: t.tax + l.rate.tax * l.quantity }), { subtotal: 0, tax: 0 });
  const roomsChosen = lines.reduce((s, l) => s + l.quantity, 0);
  const currency = info?.property.currency ?? 'INR';
  const nights = stay.checkIn && stay.checkOut ? nightsBetween(stay.checkIn, stay.checkOut) : 0;

  function setQty(roomTypeId: string, ratePlanId: string, delta: number, available: number) {
    setCart((c) => {
      const key = `${roomTypeId}|${ratePlanId}`;
      const usedForRoom = Object.entries(c).filter(([k]) => k.startsWith(roomTypeId + '|') && k !== key).reduce((s, [, q]) => s + q, 0);
      const next = Math.max(0, Math.min((c[key] ?? 0) + delta, available - usedForRoom));
      return { ...c, [key]: next };
    });
  }

  async function placeBooking(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await call<Created>('/bookings', {
        propertyId,
        ...stay,
        selections: lines.map((l) => ({ roomTypeId: l.roomTypeId, ratePlanId: l.ratePlanId, quantity: l.quantity })),
        guest: { ...guest, gstin: guest.gstin.trim() || null, specialRequests: guest.specialRequests.trim() || null },
        paymentMode: mode,
        whatsappOptIn: whatsapp,
      });
      if (!res.payment) {
        router.push(`/booking/${res.reference}?token=${encodeURIComponent(res.manageToken)}`);
        return;
      }
      setCreated(res);
      setStep('pay');
      if (res.payment.provider === 'razorpay') openRazorpay(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPayment(c: Created, p: { orderId: string; paymentId: string; signature: string }) {
    await call(`/bookings/${c.reference}/payment`, { token: c.manageToken, ...p });
    router.push(`/booking/${c.reference}?token=${encodeURIComponent(c.manageToken)}`);
  }

  function openRazorpay(c: Created) {
    const start = () => {
      const rz = new window.Razorpay!({
        key: c.payment!.keyId,
        order_id: c.payment!.orderId,
        amount: c.payment!.amount,
        currency: c.payment!.currency,
        name: info?.property.name,
        description: `Booking ${c.reference}`,
        prefill: { name: guest.name, email: guest.email, contact: guest.phone },
        handler: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
          confirmPayment(c, { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }).catch((err) => setError(err.message)),
      });
      rz.open();
    };
    if (window.Razorpay) return start();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = start;
    s.onerror = () => setError('Could not load the payment window. Check your connection and try again.');
    document.body.appendChild(s);
  }

  async function payDemo() {
    if (!created?.payment) return;
    setBusy(true);
    try {
      const sig = await call<{ orderId: string; paymentId: string; signature: string }>(`/bookings/${created.reference}/demo-checkout`, { token: created.manageToken, orderId: created.payment.orderId });
      await confirmPayment(created, sig);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!info) return <div className="wrap">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</div>;
  const roomInfo = (id: string) => info.rooms.find((r) => r.id === id);

  return (
    <>
      <header className="top">
        <h1>{info.property.name}</h1>
        <p>Book direct for the best rate · Check-in {info.property.checkInTime} · Check-out {info.property.checkOutTime}</p>
      </header>
      <div className="wrap">
        <form className="card search" onSubmit={search}>
          <label>
            Check-in
            <input type="date" min={info.today} value={stay.checkIn} onChange={(e) => setStay({ ...stay, checkIn: e.target.value, checkOut: stay.checkOut > e.target.value ? stay.checkOut : addDays(e.target.value, 1) })} required />
          </label>
          <label>
            Check-out
            <input type="date" min={addDays(stay.checkIn || info.today, 1)} value={stay.checkOut} onChange={(e) => setStay({ ...stay, checkOut: e.target.value })} required />
          </label>
          <label>
            Adults per room
            <select value={stay.adults} onChange={(e) => setStay({ ...stay, adults: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            Children per room
            <select value={stay.children} onChange={(e) => setStay({ ...stay, children: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" disabled={searching}>
            {searching ? 'Searching…' : 'Check availability'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        <div className="layout">
          <div>
            {step === 'rooms' && offers && offers.length === 0 && (
              <div className="card">No rooms fit {stay.adults} adults and {stay.children} children in one room. Try fewer guests per room and book more rooms.</div>
            )}
            {step === 'rooms' &&
              offers?.map((o) => {
                const r = roomInfo(o.roomTypeId);
                return (
                  <article className="card room" key={o.roomTypeId}>
                    {r?.images[0] ? <img src={r.images[0]} alt={o.name} /> : <div className="ph" />}
                    <div>
                      <h2>{o.name}</h2>
                      {r?.shortDescription && <p className="muted">{r.shortDescription}</p>}
                      <div className="facts">
                        {r && <span>Up to {r.maxOccupancy} guests</span>}
                        {r?.bedType && <span>{r.bedType} bed</span>}
                        {r?.sizeSqft && <span>{r.sizeSqft} sq ft</span>}
                        {o.available > 0 && o.available <= 3 && <span className="tag warn">Only {o.available} left</span>}
                      </div>
                      {o.available === 0 && <p className="soldout">{o.unavailableReason}</p>}
                    </div>
                    <div className="rates">
                      {o.available > 0 &&
                        o.rates.map((rate) => {
                          const q = cart[`${o.roomTypeId}|${rate.ratePlanId}`] ?? 0;
                          return (
                            <div className="rate" key={rate.ratePlanId}>
                              <div>
                                <span className="name">{rate.name}</span>
                                <small>
                                  {MEAL_PLANS[rate.mealPlan]} · {rate.refundable ? <span className="success">{rate.policyText}</span> : rate.policyText}
                                </small>
                              </div>
                              <div className="price">
                                <strong>{money(rate.subtotal / nights, currency)}</strong>
                                <small>per night · {money(rate.total, currency)} total incl. taxes</small>
                              </div>
                              <div className="qty">
                                <button type="button" aria-label="Remove room" onClick={() => setQty(o.roomTypeId, rate.ratePlanId, -1, o.available)}>
                                  −
                                </button>
                                <span>{q}</span>
                                <button type="button" aria-label="Add room" onClick={() => setQty(o.roomTypeId, rate.ratePlanId, 1, o.available)}>
                                  +
                                </button>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </article>
                );
              })}

            {step === 'details' && (
              <form className="card" onSubmit={placeBooking} id="details">
                <h2 style={{ marginTop: 0 }}>Your details</h2>
                <div className="grid2">
                  <label>
                    Full name
                    <input value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} required minLength={2} autoComplete="name" />
                  </label>
                  <label>
                    Mobile number
                    <input type="tel" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} required autoComplete="tel" placeholder="+91" />
                  </label>
                  <label className="full whatsapp-opt">
                    <input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} />
                    <span>Send my booking confirmation and updates on WhatsApp to this number</span>
                  </label>
                  <label className="full">
                    Email
                    <input type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} required autoComplete="email" />
                  </label>
                  <label>
                    GSTIN for business invoice (optional)
                    <input value={guest.gstin} onChange={(e) => setGuest({ ...guest, gstin: e.target.value })} maxLength={15} />
                  </label>
                  <label className="full">
                    Special requests (optional)
                    <textarea value={guest.specialRequests} onChange={(e) => setGuest({ ...guest, specialRequests: e.target.value })} maxLength={1000} />
                  </label>
                </div>
                <h3>How would you like to pay?</h3>
                <div className="pay-options">
                  <label className={`pay-option ${mode === 'pay_now' ? 'on' : ''}`}>
                    <input type="radio" checked={mode === 'pay_now'} onChange={() => setMode('pay_now')} />
                    <span>
                      <strong>Pay now</strong> · UPI, cards, net banking. Your room is confirmed instantly.
                    </span>
                  </label>
                  {info.payment.payAtHotel && (
                    <label className={`pay-option ${mode === 'pay_at_hotel' ? 'on' : ''}`}>
                      <input type="radio" checked={mode === 'pay_at_hotel'} onChange={() => setMode('pay_at_hotel')} />
                      <span>
                        <strong>Pay at the hotel</strong> · Nothing to pay today.
                      </span>
                    </label>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" className="btn" onClick={() => setStep('rooms')}>
                    Back
                  </button>
                  <button className="btn btn-primary" disabled={busy} style={{ flex: 1 }}>
                    {busy ? 'Reserving your room…' : mode === 'pay_now' ? `Continue to payment · ${money(totals.subtotal + totals.tax, currency)}` : 'Confirm booking'}
                  </button>
                </div>
              </form>
            )}

            {step === 'pay' && created?.payment && (
              <div className="card">
                <h2 style={{ marginTop: 0 }}>Payment</h2>
                <p className="muted">Your rooms are held for 15 minutes while you pay. Booking reference {created.reference}.</p>
                {created.payment.provider === 'demo' ? (
                  <div className="demo-pay">
                    <p>
                      <strong>Demo payment.</strong> This hotel has not connected its payment gateway yet, so no money moves.
                    </p>
                    <button className="btn btn-primary btn-block" disabled={busy} onClick={payDemo}>
                      {busy ? 'Processing…' : `Pay ${money(created.payment.amount, currency)} (demo)`}
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-primary btn-block" onClick={() => openRazorpay(created)}>
                    Pay {money(created.payment.amount, currency)}
                  </button>
                )}
              </div>
            )}
          </div>

          <aside className="card summary">
            <h3>Your stay</h3>
            {stay.checkIn && stay.checkOut && (
              <p className="muted">
                {niceDate(stay.checkIn)} to {niceDate(stay.checkOut)} · {nights} night{nights === 1 ? '' : 's'}
              </p>
            )}
            {lines.length === 0 && <p className="muted">Choose a room and rate to continue.</p>}
            {lines.map((l) => (
              <div className="line" key={`${l.roomTypeId}|${l.ratePlanId}`}>
                <span>
                  {l.quantity} × {l.room.name}
                  <br />
                  <small className="muted">{l.rate.name}</small>
                </span>
                <span>{money(l.rate.subtotal * l.quantity, currency)}</span>
              </div>
            ))}
            {lines.length > 0 && (
              <>
                <div className="line">
                  <span>Taxes (GST)</span>
                  <span>{money(totals.tax, currency)}</span>
                </div>
                <div className="line total">
                  <span>Total</span>
                  <span>{money(totals.subtotal + totals.tax, currency)}</span>
                </div>
              </>
            )}
            {step === 'rooms' && (
              <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} disabled={!roomsChosen} onClick={() => setStep('details')}>
                {roomsChosen ? `Book ${roomsChosen} room${roomsChosen === 1 ? '' : 's'}` : 'Select rooms'}
              </button>
            )}
            {info.property.phone && <p className="muted">Questions? Call {info.property.phone}</p>}
          </aside>
        </div>
      </div>
    </>
  );
}
