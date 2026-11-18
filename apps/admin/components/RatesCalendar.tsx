'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { addDays, rupees, shortDate, toPaise, todayLocal } from './money';

interface Calendar {
  dates: string[];
  rooms: { id: string; name: string; totalUnits: number }[];
  basePlans: { id: string; name: string; code: string }[];
  rates: { roomTypeId: string; ratePlanId: string; date: string; price: number }[];
  inventory: { roomTypeId: string; date: string; total: number; sold: number; held: number; closed: boolean; minStay: number | null; closedToArrival: boolean }[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function RatesCalendar({ propertyId }: { propertyId: string }) {
  const [from, setFrom] = useState(todayLocal());
  const [cal, setCal] = useState<Calendar | null>(null);
  const [planId, setPlanId] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      const c = await api<Calendar>(`/properties/${propertyId}/calendar?from=${from}&to=${addDays(from, 13)}`);
      setCal(c);
      setPlanId((p) => p || c.basePlans[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, [propertyId, from]);

  async function update(body: Record<string, unknown>, note: string) {
    setError('');
    try {
      await api(`/properties/${propertyId}/calendar`, { method: 'PUT', body });
      setMsg(note);
      setTimeout(() => setMsg(''), 2500);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!cal) return <p className="muted">{error || 'Loading…'}</p>;
  if (!cal.rooms.length) return <div className="card">Add room types first (Rooms tab).</div>;
  if (!cal.basePlans.length) return <div className="card">Create a rate plan first (Rate plans tab).</div>;

  const inv = (rt: string, d: string) => cal.inventory.find((i) => i.roomTypeId === rt && i.date === d);
  const price = (rt: string, d: string) => cal.rates.find((r) => r.roomTypeId === rt && r.ratePlanId === planId && r.date === d)?.price;

  return (
    <>
      <div className="card actions" style={{ marginTop: 0, flexWrap: 'wrap' }}>
        <button onClick={() => setFrom(addDays(from, -14))}>← Earlier</button>
        <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} style={{ width: 160 }} />
        <button onClick={() => setFrom(addDays(from, 14))}>Later →</button>
        <span className="spacer" />
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          Prices for
          <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {cal.basePlans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {msg && <p className="success">{msg}</p>}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="calendar">
          <thead>
            <tr>
              <th />
              {cal.dates.map((d) => (
                <th key={d} className={[0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? 'weekend' : ''}>
                  {shortDate(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cal.rooms.map((r) => (
              <RoomRows key={r.id} room={r} dates={cal.dates} inv={inv} price={price} planId={planId} update={update} />
            ))}
          </tbody>
        </table>
        <p className="muted">
          Click a price to change one night. Click "open" or "closed" to close or reopen a night. Derived plans (like non-refundable) follow these prices automatically.
        </p>
      </div>
      <BulkUpdate rooms={cal.rooms} planId={planId} from={from} update={update} />
    </>
  );
}

function RoomRows({
  room,
  dates,
  inv,
  price,
  planId,
  update,
}: {
  room: Calendar['rooms'][number];
  dates: string[];
  inv: (rt: string, d: string) => Calendar['inventory'][number] | undefined;
  price: (rt: string, d: string) => number | undefined;
  planId: string;
  update: (body: Record<string, unknown>, note: string) => Promise<void>;
}) {
  return (
    <>
      <tr className="room-head">
        <th colSpan={dates.length + 1}>{room.name}</th>
      </tr>
      <tr>
        <td className="label">Rooms left</td>
        {dates.map((d) => {
          const i = inv(room.id, d);
          const total = i?.total ?? room.totalUnits;
          const left = total - (i?.sold ?? 0) - (i?.held ?? 0);
          return (
            <td key={d} className={i?.closed ? 'closed' : left <= 0 ? 'full' : ''}>
              <strong>{i?.closed ? 0 : Math.max(left, 0)}</strong>
              <span className="muted">/{total}</span>
              {i?.minStay ? <div className="mini">min {i.minStay}</div> : null}
            </td>
          );
        })}
      </tr>
      <tr>
        <td className="label">Price</td>
        {dates.map((d) => (
          <PriceCell key={d} value={price(room.id, d)} onSave={(p) => update({ roomTypeIds: [room.id], ratePlanId: planId, from: d, to: d, price: p }, `Price updated for ${shortDate(d)}`)} />
        ))}
      </tr>
      <tr>
        <td className="label">Status</td>
        {dates.map((d) => {
          const closed = inv(room.id, d)?.closed ?? false;
          return (
            <td key={d}>
              <button className={`chip ${closed ? 'chip-closed' : ''}`} onClick={() => update({ roomTypeIds: [room.id], from: d, to: d, closed: !closed }, closed ? 'Reopened' : 'Closed for sale')}>
                {closed ? 'closed' : 'open'}
              </button>
            </td>
          );
        })}
      </tr>
    </>
  );
}

function PriceCell({ value, onSave }: { value: number | undefined; onSave: (paise: number) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (editing) {
    return (
      <td>
        <input
          autoFocus
          className="cell-input"
          value={text}
          inputMode="decimal"
          onChange={(e) => setText(e.target.value)}
          onBlur={async () => {
            setEditing(false);
            const p = toPaise(text);
            if (text.trim() && Number.isFinite(p) && p >= 0 && p !== value) await onSave(p);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </td>
    );
  }
  return (
    <td>
      <button
        className="cell-btn"
        onClick={() => {
          setText(value !== undefined ? String(value / 100) : '');
          setEditing(true);
        }}
      >
        {value !== undefined ? rupees(value) : <span className="error">set</span>}
      </button>
    </td>
  );
}

function BulkUpdate({
  rooms,
  planId,
  from,
  update,
}: {
  rooms: Calendar['rooms'];
  planId: string;
  from: string;
  update: (body: Record<string, unknown>, note: string) => Promise<void>;
}) {
  const [f, setF] = useState({ roomIds: rooms.map((r) => r.id), from, to: addDays(from, 30), days: [0, 1, 2, 3, 4, 5, 6], price: '', extraAdult: '', extraChild: '', total: '', minStay: '', action: '' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { roomTypeIds: f.roomIds, from: f.from, to: f.to };
    if (f.days.length < 7) body.weekdays = f.days;
    if (f.price) Object.assign(body, { ratePlanId: planId, price: toPaise(f.price) });
    if (f.extraAdult) Object.assign(body, { ratePlanId: planId, extraAdult: toPaise(f.extraAdult) });
    if (f.extraChild) Object.assign(body, { ratePlanId: planId, extraChild: toPaise(f.extraChild) });
    if (f.total) body.total = Number(f.total);
    if (f.minStay) body.minStay = f.minStay === '1' ? null : Number(f.minStay);
    if (f.action === 'close') body.closed = true;
    if (f.action === 'open') body.closed = false;
    if (Object.keys(body).length === 3 + (body.weekdays ? 1 : 0)) return;
    await update(body, 'Changes applied');
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Change many dates at once</h2>
      <div className="grid">
        <div className="field wide">
          Room types
          <div className="actions" style={{ marginTop: 4, flexWrap: 'wrap' }}>
            {rooms.map((r) => (
              <label key={r.id} className="field check">
                <input
                  type="checkbox"
                  checked={f.roomIds.includes(r.id)}
                  onChange={(e) => setF({ ...f, roomIds: e.target.checked ? [...f.roomIds, r.id] : f.roomIds.filter((x) => x !== r.id) })}
                />
                {r.name}
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          From
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required />
        </label>
        <label className="field">
          To (inclusive)
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} required />
        </label>
        <div className="field wide">
          Days of the week
          <div className="actions" style={{ marginTop: 4 }}>
            {DAYS.map((name, i) => (
              <label key={name} className="field check">
                <input type="checkbox" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i) })} />
                {name}
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          Price per night, ₹
          <input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="leave blank to keep" />
        </label>
        <label className="field">
          Extra adult, ₹
          <input inputMode="decimal" value={f.extraAdult} onChange={(e) => setF({ ...f, extraAdult: e.target.value })} placeholder="leave blank to keep" />
        </label>
        <label className="field">
          Extra child, ₹
          <input inputMode="decimal" value={f.extraChild} onChange={(e) => setF({ ...f, extraChild: e.target.value })} placeholder="leave blank to keep" />
        </label>
        <label className="field">
          Rooms to sell
          <input type="number" min={0} value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} placeholder="leave blank to keep" />
        </label>
        <label className="field">
          Minimum stay (nights)
          <input type="number" min={1} value={f.minStay} onChange={(e) => setF({ ...f, minStay: e.target.value })} placeholder="1 removes it" />
        </label>
        <label className="field">
          Sale status
          <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
            <option value="">Keep as is</option>
            <option value="close">Close for sale</option>
            <option value="open">Open for sale</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="primary" disabled={!f.roomIds.length}>
          Apply changes
        </button>
      </div>
    </form>
  );
}
