'use client';
import { useState } from 'react';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Dates and guests, handed to the booking engine as query parameters. */
export function BookingBar({ bookingUrl }: { bookingUrl: string }) {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 864e5);
  const [checkIn, setCheckIn] = useState(iso(today));
  const [checkOut, setCheckOut] = useState(iso(tomorrow));
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);

  function go(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams({ checkIn, checkOut, adults: String(adults), children: String(children) });
    window.location.href = `${bookingUrl}${bookingUrl.includes('?') ? '&' : '?'}${q}`;
  }

  return (
    <form className="a-bookbar" onSubmit={go} id="book">
      <label>
        Check-in
        <input type="date" value={checkIn} min={iso(today)} onChange={(e) => setCheckIn(e.target.value)} required />
      </label>
      <label>
        Check-out
        <input type="date" value={checkOut} min={checkIn} onChange={(e) => setCheckOut(e.target.value)} required />
      </label>
      <label>
        Adults
        <input type="number" min={1} max={20} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
      </label>
      <label>
        Children
        <input type="number" min={0} max={10} value={children} onChange={(e) => setChildren(Number(e.target.value))} />
      </label>
      <button className="a-btn a-btn-accent">Check rates</button>
    </form>
  );
}
