'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      router.push('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center-card">
      <h1>Sign in to Midotel</h1>
      <p className="muted">Manage your hotel website, rooms and bookings.</p>
      <form onSubmit={submit} className="grid" style={{ gridTemplateColumns: '1fr' }}>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label className="field">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <span className="muted">
            New hotel? <Link href="/signup">Create an account</Link>
          </span>
        </div>
      </form>
    </div>
  );
}
