'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { rupees, shortDate } from './money';

interface Booking {
  id: string;
  reference: string;
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
  checkIn: string;
  checkOut: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  guestGstin: string | null;
  specialRequests: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  paymentMode: 'pay_now' | 'pay_at_hotel';
  cancelPenalty: number | null;
  createdAt: string;
  rooms: { roomName: string; ratePlanName: string; adults: number; children: number }[];
}
interface Detail extends Booking {
  payments: { id: string; provider: string; kind: string; amount: number; status: string; providerPaymentId: string | null; createdAt: string }[];
}
interface Summary {
  confirmedBookings: number;
  confirmedRevenue: number;
  collected: number;
  awaitingPayment: number;
}

const LABEL: Record<Booking['status'], string> = { confirmed: 'Confirmed', pending_payment: 'Awaiting payment', cancelled: 'Cancelled', expired: 'Expired' };

export function Reservations({ propertyId }: { propertyId: string }) {
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    const [b, s] = await Promise.all([
      api<Booking[]>(`/properties/${propertyId}/bookings${status ? `?status=${status}` : ''}`),
      api<Summary>(`/properties/${propertyId}/bookings-summary`),
    ]);
    setRows(b);
    setSummary(s);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [propertyId, status]);

  async function show(id: string) {
    setOpen(await api<Detail>(`/bookings/${id}`));
  }

  async function cancel(b: Detail, waivePenalty: boolean) {
    if (!confirm(waivePenalty ? 'Cancel and waive any cancellation charge? The guest gets a full refund.' : "Cancel under the booking's cancellation policy?")) return;
    try {
      const r = await api<{ penalty: number; refunded: number }>(`/bookings/${b.id}/cancel`, { method: 'POST', body: { waivePenalty } });
      alert(`Cancelled. Charge kept: ${rupees(r.penalty)}. Refunded: ${rupees(r.refunded)}.`);
      await show(b.id);
      await load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const csv = () => {
    if (!rows) return;
    const head = ['Reference', 'Status', 'Guest', 'Phone', 'Email', 'Check-in', 'Check-out', 'Rooms', 'Total (INR)', 'Paid (INR)', 'Booked on'];
    const lines = rows.map((b) =>
      [b.reference, LABEL[b.status], b.guestName, b.guestPhone, b.guestEmail, b.checkIn, b.checkOut, b.rooms.map((r) => r.roomName).join(' + '), (b.total / 100).toFixed(2), (b.paid / 100).toFixed(2), b.createdAt.slice(0, 10)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const url = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'reservations.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {summary && (
        <div className="stats">
          <div className="card stat">
            <span className="muted">Confirmed bookings</span>
            <strong>{summary.confirmedBookings}</strong>
          </div>
          <div className="card stat">
            <span className="muted">Booking value</span>
            <strong>{rupees(summary.confirmedRevenue)}</strong>
          </div>
          <div className="card stat">
            <span className="muted">Collected online</span>
            <strong>{rupees(summary.collected)}</strong>
          </div>
          <div className="card stat">
            <span className="muted">Awaiting payment</span>
            <strong>{summary.awaitingPayment}</strong>
          </div>
        </div>
      )}
      <div className="card">
        <div className="actions" style={{ marginTop: 0 }}>
          <h2 style={{ margin: 0 }}>Reservations</h2>
          <span className="spacer" />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button onClick={csv}>Export CSV</button>
        </div>
        {error && <p className="error">{error}</p>}
        {rows === null ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No reservations yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Guest</th>
                <th>Stay</th>
                <th>Rooms</th>
                <th>Total</th>
                <th>Payment</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => show(b.id)}>
                  <td>{b.reference}</td>
                  <td>{b.guestName}</td>
                  <td>
                    {shortDate(b.checkIn)} to {shortDate(b.checkOut)}
                  </td>
                  <td>{b.rooms.map((r) => r.roomName).join(', ')}</td>
                  <td>{rupees(b.total)}</td>
                  <td>{b.paymentMode === 'pay_at_hotel' ? 'At hotel' : b.paid >= b.total ? 'Paid' : 'Online, unpaid'}</td>
                  <td>
                    <span className={`badge ${b.status === 'confirmed' ? 'live' : ''}`}>{LABEL[b.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <div className="modal-back" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="actions" style={{ marginTop: 0 }}>
              <h2 style={{ margin: 0 }}>Booking {open.reference}</h2>
              <span className={`badge ${open.status === 'confirmed' ? 'live' : ''}`}>{LABEL[open.status]}</span>
              <span className="spacer" />
              <button onClick={() => setOpen(null)}>Close</button>
            </div>
            <div className="grid" style={{ marginTop: 12 }}>
              <div>
                <p className="muted">Guest</p>
                <p>
                  {open.guestName}
                  <br />
                  {open.guestPhone}
                  <br />
                  {open.guestEmail}
                  {open.guestGstin && (
                    <>
                      <br />
                      GSTIN {open.guestGstin}
                    </>
                  )}
                </p>
              </div>
              <div>
                <p className="muted">Stay</p>
                <p>
                  {shortDate(open.checkIn)} to {shortDate(open.checkOut)}
                </p>
                {open.rooms.map((r, i) => (
                  <p key={i}>
                    {r.roomName}, {r.ratePlanName} · {r.adults} adults
                    {r.children ? `, ${r.children} children` : ''}
                  </p>
                ))}
              </div>
              <div>
                <p className="muted">Amounts</p>
                <p>
                  Rooms {rupees(open.subtotal)} + GST {rupees(open.tax)} = <strong>{rupees(open.total)}</strong>
                  <br />
                  Paid online: {rupees(open.paid)}
                  {open.status === 'confirmed' && open.total > open.paid && (
                    <>
                      <br />
                      To collect at hotel: <strong>{rupees(open.total - open.paid)}</strong>
                    </>
                  )}
                  {open.cancelPenalty !== null && (
                    <>
                      <br />
                      Cancellation charge: {rupees(open.cancelPenalty)}
                    </>
                  )}
                </p>
              </div>
            </div>
            {open.specialRequests && (
              <p>
                <span className="muted">Special requests:</span> {open.specialRequests}
              </p>
            )}
            {open.payments.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Gateway reference</th>
                  </tr>
                </thead>
                <tbody>
                  {open.payments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.kind === 'refund' ? 'Refund' : 'Charge'} ({p.provider})
                      </td>
                      <td>{rupees(p.amount)}</td>
                      <td>{p.status}</td>
                      <td className="muted">{p.providerPaymentId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(open.status === 'confirmed' || open.status === 'pending_payment') && (
              <div className="actions">
                <button className="danger" onClick={() => cancel(open, false)}>
                  Cancel booking
                </button>
                <button onClick={() => cancel(open, true)}>Cancel and waive charges</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
