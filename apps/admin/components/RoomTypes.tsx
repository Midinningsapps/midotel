'use client';
import { useEffect, useState } from 'react';
import { api, type RoomType } from '@/lib/api';

const EMPTY = {
  name: '',
  code: '',
  shortDescription: '',
  bedType: '',
  sizeSqft: '',
  maxAdults: '2',
  maxChildren: '1',
  maxOccupancy: '3',
  baseOccupancy: '2',
  totalUnits: '1',
  sortOrder: '0',
  isActive: true,
};
type Draft = typeof EMPTY;

const fromRoom = (r: RoomType): Draft => ({
  name: r.name,
  code: r.code,
  shortDescription: r.shortDescription ?? '',
  bedType: r.bedType ?? '',
  sizeSqft: r.sizeSqft?.toString() ?? '',
  maxAdults: String(r.maxAdults),
  maxChildren: String(r.maxChildren),
  maxOccupancy: String(r.maxOccupancy),
  baseOccupancy: String(r.baseOccupancy),
  totalUnits: String(r.totalUnits),
  sortOrder: String(r.sortOrder),
  isActive: r.isActive,
});

const toBody = (d: Draft) => ({
  name: d.name,
  code: d.code,
  shortDescription: d.shortDescription.trim() || null,
  bedType: d.bedType.trim() || null,
  sizeSqft: d.sizeSqft ? Number(d.sizeSqft) : null,
  maxAdults: Number(d.maxAdults),
  maxChildren: Number(d.maxChildren),
  maxOccupancy: Number(d.maxOccupancy),
  baseOccupancy: Number(d.baseOccupancy),
  totalUnits: Number(d.totalUnits),
  sortOrder: Number(d.sortOrder),
  isActive: d.isActive,
});

export function RoomTypes({ propertyId }: { propertyId: string }) {
  const [rooms, setRooms] = useState<RoomType[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState('');

  const load = () => api<RoomType[]>(`/properties/${propertyId}/room-types`).then(setRooms).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [propertyId]);

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [k]: k === 'isActive' ? e.target.checked : e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') {
        await api(`/properties/${propertyId}/room-types`, { method: 'POST', body: toBody(draft) });
      } else if (editing) {
        await api(`/room-types/${editing}`, { method: 'PATCH', body: toBody(draft) });
      }
      setEditing(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(r: RoomType) {
    if (!confirm(`Delete "${r.name}"? This cannot be undone.`)) return;
    try {
      await api(`/room-types/${r.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const num = (k: keyof Draft, label: string, min = 0) => (
    <label className="field">
      {label}
      <input type="number" min={min} value={String(draft[k])} onChange={set(k)} required={k !== 'sizeSqft'} />
    </label>
  );

  return (
    <>
      <div className="card">
        <div className="actions" style={{ marginTop: 0, justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Room types</h2>
          <button
            className="primary"
            onClick={() => {
              setDraft(EMPTY);
              setEditing('new');
            }}
          >
            Add room type
          </button>
        </div>
        {rooms === null ? (
          <p className="muted">Loading…</p>
        ) : rooms.length === 0 ? (
          <p className="muted">No rooms yet. Add your first room type.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Code</th>
                <th>Units</th>
                <th>Max guests</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.code}</td>
                  <td>{r.totalUnits}</td>
                  <td>
                    {r.maxOccupancy} ({r.maxAdults} adults, {r.maxChildren} children)
                  </td>
                  <td>
                    <span className={`badge ${r.isActive ? 'live' : ''}`}>{r.isActive ? 'active' : 'hidden'}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      onClick={() => {
                        setDraft(fromRoom(r));
                        setEditing(r.id);
                      }}
                    >
                      Edit
                    </button>{' '}
                    <button className="danger" onClick={() => remove(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && !editing && <p className="error">{error}</p>}
      </div>

      {editing && (
        <form className="card" onSubmit={save}>
          <h2>{editing === 'new' ? 'New room type' : `Edit ${draft.name}`}</h2>
          <div className="grid">
            <label className="field">
              Name
              <input value={draft.name} onChange={set('name')} required />
            </label>
            <label className="field">
              Code (used for channel manager mapping)
              <input value={draft.code} onChange={set('code')} required maxLength={20} />
            </label>
            <label className="field wide">
              Short description
              <input value={draft.shortDescription} onChange={set('shortDescription')} />
            </label>
            <label className="field">
              Bed type
              <input value={draft.bedType} onChange={set('bedType')} placeholder="King, Twin…" />
            </label>
            {num('sizeSqft', 'Size (sq ft)', 1)}
            {num('totalUnits', 'Number of rooms of this type')}
            {num('maxAdults', 'Max adults', 1)}
            {num('maxChildren', 'Max children')}
            {num('maxOccupancy', 'Max guests in total', 1)}
            {num('baseOccupancy', 'Guests included in base price', 1)}
            {num('sortOrder', 'Display order')}
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={draft.isActive} onChange={set('isActive')} /> Show on website and booking engine
            </label>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="primary">Save room</button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}
