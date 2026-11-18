'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { PropertyDetails } from '@/components/PropertyDetails';
import { RoomTypes } from '@/components/RoomTypes';
import { api, type Property } from '@/lib/api';

function PropertyPage({ id }: { id: string }) {
  const [property, setProperty] = useState<Property | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'details' | 'rooms'>('details');

  useEffect(() => {
    api<Property>(`/properties/${id}`).then(setProperty).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!property) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted">
        <Link href="/">Hotels</Link> / {property.name}
      </p>
      <h1>{property.name}</h1>
      <div className="tabs">
        <button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>
          Hotel details
        </button>
        <button className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}>
          Rooms
        </button>
      </div>
      {tab === 'details' ? <PropertyDetails property={property} onSaved={setProperty} /> : <RoomTypes propertyId={id} />}
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Shell>
      <PropertyPage id={id} />
    </Shell>
  );
}
