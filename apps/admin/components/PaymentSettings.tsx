'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Gateway {
  provider: 'razorpay' | 'demo';
  keyId: string | null;
  hasSecret: boolean;
  payAtHotel: boolean;
  configured: boolean;
}

export function PaymentSettings({ propertyId }: { propertyId: string }) {
  const [g, setG] = useState<Gateway | null>(null);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Gateway>(`/properties/${propertyId}/gateway`).then(setG).catch((e) => setMsg({ ok: false, text: e.message }));
  }, [propertyId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const saved = await api<Gateway>(`/properties/${propertyId}/gateway`, {
        method: 'PUT',
        body: { provider: g!.provider, keyId: g!.provider === 'razorpay' ? g!.keyId : null, keySecret: secret || undefined, payAtHotel: g!.payAtHotel },
      });
      setG(saved);
      setSecret('');
      setMsg({ ok: true, text: 'Saved' });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  if (!g) return <p className="muted">{msg?.text ?? 'Loading…'}</p>;
  return (
    <form className="card" onSubmit={save} style={{ maxWidth: 640 }}>
      <h2>Online payments</h2>
      <p className="muted">
        Guests pay straight into your own payment gateway account. Midotel never holds your money. Use Razorpay test keys first, then switch to live keys.
      </p>
      <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
        <label className="field">
          Gateway
          <select value={g.provider} onChange={(e) => setG({ ...g, provider: e.target.value as Gateway['provider'] })}>
            <option value="demo">Demo (no real money, for testing)</option>
            <option value="razorpay">Razorpay</option>
          </select>
        </label>
        {g.provider === 'razorpay' && (
          <>
            <label className="field">
              Key id (Razorpay Dashboard → Settings → API keys)
              <input value={g.keyId ?? ''} onChange={(e) => setG({ ...g, keyId: e.target.value.trim() })} placeholder="rzp_test_..." required />
            </label>
            <label className="field">
              Key secret {g.hasSecret && <span className="muted">(saved; leave blank to keep it)</span>}
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" placeholder={g.hasSecret ? '••••••••' : ''} required={!g.hasSecret} />
            </label>
          </>
        )}
        <label className="field check">
          <input type="checkbox" checked={g.payAtHotel} onChange={(e) => setG({ ...g, payAtHotel: e.target.checked })} /> Let guests choose to pay at the hotel
        </label>
      </div>
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
      <div className="actions">
        <button className="primary">Save payment settings</button>
      </div>
    </form>
  );
}
