'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    companyName: '',
    propertyName: '',
    kind: 'independent',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ propertyId: string }>('/auth/signup', { method: 'POST', body: form });
      router.push(`/properties/${res.propertyId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center-card" style={{ maxWidth: 520 }}>
      <h1>Create your Midotel account</h1>
      <p className="muted">Set up your hotel in a few minutes.</p>
      <form onSubmit={submit} className="grid">
        <label className="field">
          Your name
          <input value={form.name} onChange={set('name')} required />
        </label>
        <label className="field">
          Work email
          <input type="email" value={form.email} onChange={set('email')} required />
        </label>
        <label className="field wide">
          Password (at least 10 characters)
          <input type="password" value={form.password} onChange={set('password')} minLength={10} required />
        </label>
        <label className="field">
          Company or brand name
          <input value={form.companyName} onChange={set('companyName')} required />
        </label>
        <label className="field">
          First hotel name
          <input value={form.propertyName} onChange={set('propertyName')} required />
        </label>
        <label className="field wide">
          Account type
          <select value={form.kind} onChange={set('kind')}>
            <option value="independent">Independent hotel</option>
            <option value="chain">Hotel chain or group</option>
          </select>
        </label>
        {error && <p className="error field wide">{error}</p>}
        <div className="actions field wide">
          <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          <span className="muted">
            Have an account? <Link href="/login">Sign in</Link>
          </span>
        </div>
      </form>
    </div>
  );
}
