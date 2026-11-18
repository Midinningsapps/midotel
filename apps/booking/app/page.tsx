import { Suspense } from 'react';
import { BookingEngine } from './BookingEngine';

export default function Page() {
  return (
    <Suspense fallback={<div className="wrap muted">Loading…</div>}>
      <BookingEngine />
    </Suspense>
  );
}
