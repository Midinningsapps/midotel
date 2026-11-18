'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { PropertyDetails } from '@/components/PropertyDetails';
import { RoomTypes } from '@/components/RoomTypes';
import { Website } from '@/components/Website';
import { RatePlans } from '@/components/RatePlans';
import { RatesCalendar } from '@/components/RatesCalendar';
import { Reservations } from '@/components/Reservations';
import { PaymentSettings } from '@/components/PaymentSettings';

const TABS = [
  ['reservations', 'Reservations'],
  ['rates', 'Rates and availability'],
  ['plans', 'Rate plans'],
  ['rooms', 'Rooms'],
  ['website', 'Website'],
  ['payments', 'Payments'],
  ['details', 'Hotel details'],
] as const;
type Tab = (typeof TABS)[number][0];
import { api, type Property } from '@/lib/api';

function PropertyPage({ id }: { id: string }) {
  const [property, setProperty] = useState<Property | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('reservations');

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
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'details' && <PropertyDetails property={property} onSaved={setProperty} />}
      {tab === 'rooms' && <RoomTypes propertyId={id} />}
      {tab === 'website' && <Website propertyId={id} />}
      {tab === 'reservations' && <Reservations propertyId={id} />}
      {tab === 'rates' && <RatesCalendar propertyId={id} />}
      {tab === 'plans' && <RatePlans propertyId={id} />}
      {tab === 'payments' && <PaymentSettings propertyId={id} />}
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
