'use client';
import { useState } from 'react';
import { api, type Property } from '@/lib/api';

type Form = Record<string, string>;

const TEXT_FIELDS: { key: keyof Property; label: string; type?: string; wide?: boolean; area?: boolean }[] = [
  { key: 'name', label: 'Hotel name' },
  { key: 'tagline', label: 'Tagline' },
  { key: 'description', label: 'Description', wide: true, area: true },
  { key: 'email', label: 'Reservations email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'addressLine', label: 'Address', wide: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'PIN code' },
  { key: 'country', label: 'Country code' },
  { key: 'latitude', label: 'Latitude', type: 'number' },
  { key: 'longitude', label: 'Longitude', type: 'number' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'timezone', label: 'Time zone' },
  { key: 'currency', label: 'Currency' },
  { key: 'checkInTime', label: 'Check-in time', type: 'time' },
  { key: 'checkOutTime', label: 'Check-out time', type: 'time' },
];

const toForm = (p: Property): Form =>
  Object.fromEntries(
    Object.entries(p).map(([k, v]) => [k, v === null ? '' : k.endsWith('Time') ? String(v).slice(0, 5) : String(v)]),
  );

export function PropertyDetails({ property, onSaved }: { property: Property; onSaved: (p: Property) => void }) {
  const [form, setForm] = useState<Form>(() => toForm(property));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const nullable = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());
    const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : Number(v));
    const body = {
      name: form.name,
      tagline: nullable(form.tagline),
      description: nullable(form.description),
      propertyType: form.propertyType,
      starRating: num(form.starRating),
      email: nullable(form.email),
      phone: nullable(form.phone),
      addressLine: nullable(form.addressLine),
      city: nullable(form.city),
      state: nullable(form.state),
      postalCode: nullable(form.postalCode),
      country: form.country,
      latitude: num(form.latitude),
      longitude: num(form.longitude),
      gstin: nullable(form.gstin),
      timezone: form.timezone,
      currency: form.currency,
      checkInTime: form.checkInTime,
      checkOutTime: form.checkOutTime,
      status: form.status,
    };
    try {
      const saved = await api<Property>(`/properties/${property.id}`, { method: 'PATCH', body });
      onSaved(saved);
      setForm(toForm(saved));
      setMsg({ ok: true, text: 'Saved' });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="grid">
        {TEXT_FIELDS.map((f) => (
          <label key={f.key} className={`field ${f.wide ? 'wide' : ''}`}>
            {f.label}
            {f.area ? (
              <textarea value={form[f.key] ?? ''} onChange={set(f.key)} />
            ) : (
              <input type={f.type ?? 'text'} step={f.type === 'number' ? 'any' : undefined} value={form[f.key] ?? ''} onChange={set(f.key)} />
            )}
          </label>
        ))}
        <label className="field">
          Property type
          <select value={form.propertyType} onChange={set('propertyType')}>
            {['hotel', 'resort', 'homestay', 'villa', 'camp', 'hostel', 'apartment'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Star rating
          <select value={form.starRating} onChange={set('starRating')}>
            <option value="">Not rated</option>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Status
          <select value={form.status} onChange={set('status')}>
            <option value="draft">Draft</option>
            <option value="live">Live</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
        {msg && <span className={msg.ok ? 'success' : 'error'}>{msg.text}</span>}
      </div>
    </form>
  );
}
