'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, useMe } from '@/components/Shell';
import { api, type Property } from '@/lib/api';

function Properties() {
  const me = useMe();
  const [items, setItems] = useState<Property[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const canAdd = me?.roles.some((r) => r.propertyId === null && (r.role === 'owner' || r.role === 'manager'));

  const load = () => api<Property[]>('/properties').then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    try {
      await api('/properties', { method: 'POST', body: { name, slug } });
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Your hotels</h1>
      <p className="muted">Pick a hotel to edit its details and rooms.</p>
      <div className="card">
        {items === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Hotel</th>
                <th>City</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/properties/${p.id}`}>{p.name}</Link>
                  </td>
                  <td>{p.city ?? '—'}</td>
                  <td>
                    <span className={`badge ${p.status === 'live' ? 'live' : ''}`}>{p.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canAdd && (
          <form onSubmit={add} className="actions">
            <input placeholder="New hotel name" value={name} onChange={(e) => setName(e.target.value)} required />
            <button className="primary">Add hotel</button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}

export default function Home() {
  return (
    <Shell>
      <Properties />
    </Shell>
  );
}
