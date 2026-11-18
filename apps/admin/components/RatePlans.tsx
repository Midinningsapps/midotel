'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { rupees, toPaise } from './money';

interface Plan {
  id: string;
  name: string;
  code: string;
  description: string | null;
  mealPlan: 'EP' | 'CP' | 'MAP' | 'AP';
  cancellationPolicyId: string | null;
  parentId: string | null;
  deriveKind: 'percent' | 'amount' | null;
  deriveValue: number | null;
  isActive: boolean;
  sortOrder: number;
}
interface Policy {
  id: string;
  name: string;
  summary: string;
  isNonRefundable: boolean;
}

const MEALS = { EP: 'Room only', CP: 'With breakfast', MAP: 'Breakfast + one meal', AP: 'All meals' };

export function RatePlans({ propertyId }: { propertyId: string }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState('');
  const load = async () => {
    const [p, c] = await Promise.all([api<Plan[]>(`/properties/${propertyId}/rate-plans`), api<Policy[]>(`/properties/${propertyId}/cancellation-policies`)]);
    setPlans(p);
    setPolicies(c);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [propertyId]);

  const describe = (p: Plan) => {
    if (!p.parentId) return 'Base plan: priced in the Rates calendar';
    const parent = plans.find((x) => x.id === p.parentId)?.name ?? 'parent';
    const v = p.deriveValue ?? 0;
    return p.deriveKind === 'percent' ? `${v > 0 ? '+' : ''}${v}% of ${parent}` : `${v >= 0 ? '+' : '−'}${rupees(Math.abs(v))} on ${parent} per night`;
  };

  async function toggle(p: Plan) {
    await api(`/rate-plans/${p.id}`, { method: 'PATCH', body: { isActive: !p.isActive } });
    load();
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <h2>Rate plans</h2>
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Meals</th>
              <th>Pricing</th>
              <th>Cancellation</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong> <span className="muted">{p.code}</span>
                </td>
                <td>{MEALS[p.mealPlan]}</td>
                <td>{describe(p)}</td>
                <td>{policies.find((c) => c.id === p.cancellationPolicyId)?.name ?? 'Free cancellation'}</td>
                <td>
                  <button onClick={() => toggle(p)}>{p.isActive ? 'On sale' : 'Hidden'}</button>
                </td>
              </tr>
            ))}
            {plans.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No rate plans yet. Start with a base plan such as "Room with breakfast".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <NewPlan propertyId={propertyId} plans={plans} policies={policies} onCreated={load} />
      <div className="card">
        <h2>Cancellation policies</h2>
        <ul>
          {policies.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>: <span className="muted">{c.summary}</span>
            </li>
          ))}
        </ul>
        <NewPolicy propertyId={propertyId} onCreated={load} />
      </div>
    </>
  );
}

function NewPlan({ propertyId, plans, policies, onCreated }: { propertyId: string; plans: Plan[]; policies: Policy[]; onCreated: () => void }) {
  const bases = plans.filter((p) => !p.parentId);
  const [f, setF] = useState({ name: '', code: '', description: '', mealPlan: 'CP', cancellationPolicyId: '', parentId: '', deriveKind: 'percent', deriveValue: '-10' });
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const derived = !!f.parentId;
    try {
      await api(`/properties/${propertyId}/rate-plans`, {
        method: 'POST',
        body: {
          name: f.name,
          code: f.code || f.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'PLAN',
          description: f.description || null,
          mealPlan: f.mealPlan,
          cancellationPolicyId: f.cancellationPolicyId || null,
          parentId: derived ? f.parentId : null,
          deriveKind: derived ? f.deriveKind : null,
          deriveValue: derived ? (f.deriveKind === 'percent' ? Number(f.deriveValue) : toPaise(f.deriveValue)) : null,
          sortOrder: plans.length,
        },
      });
      setF({ ...f, name: '', code: '', description: '' });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Add a rate plan</h2>
      <div className="grid">
        <label className="field">
          Name guests see
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Room with breakfast" required />
        </label>
        <label className="field">
          Code (for channel managers)
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={20} placeholder="BB" />
        </label>
        <label className="field">
          Meals
          <select value={f.mealPlan} onChange={(e) => setF({ ...f, mealPlan: e.target.value })}>
            {Object.entries(MEALS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Cancellation policy
          <select value={f.cancellationPolicyId} onChange={(e) => setF({ ...f, cancellationPolicyId: e.target.value })}>
            <option value="">Free cancellation</option>
            {policies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Pricing
          <select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            <option value="">Own prices (base plan)</option>
            {bases.map((b) => (
              <option key={b.id} value={b.id}>
                Follow {b.name}
              </option>
            ))}
          </select>
        </label>
        {f.parentId && (
          <>
            <label className="field">
              Adjust by
              <select value={f.deriveKind} onChange={(e) => setF({ ...f, deriveKind: e.target.value })}>
                <option value="percent">Percent</option>
                <option value="amount">Rupees per night</option>
              </select>
            </label>
            <label className="field">
              {f.deriveKind === 'percent' ? 'Percent (−10 = 10% cheaper)' : 'Rupees per night (−500 = ₹500 cheaper)'}
              <input inputMode="decimal" value={f.deriveValue} onChange={(e) => setF({ ...f, deriveValue: e.target.value })} required />
            </label>
          </>
        )}
        <label className="field wide">
          Description (optional)
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary">Add plan</button>
      </div>
    </form>
  );
}

function NewPolicy({ propertyId, onCreated }: { propertyId: string; onCreated: () => void }) {
  const [f, setF] = useState({ name: '', kind: 'standard', days: '3', penaltyType: 'nights', value: '1' });
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/properties/${propertyId}/cancellation-policies`, {
        method: 'POST',
        body:
          f.kind === 'nr'
            ? { name: f.name, isNonRefundable: true }
            : { name: f.name, rules: [{ daysBefore: Number(f.days), penaltyType: f.penaltyType, value: Number(f.value) }] },
      });
      setF({ ...f, name: '' });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="grid">
        <label className="field">
          New policy name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Flexible" required />
        </label>
        <label className="field">
          Type
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="standard">Free until a cut-off, then a charge</option>
            <option value="nr">Non-refundable</option>
          </select>
        </label>
        {f.kind === 'standard' && (
          <>
            <label className="field">
              Charge starts this many days before arrival
              <input type="number" min={0} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
            </label>
            <label className="field">
              Charge
              <select value={f.penaltyType} onChange={(e) => setF({ ...f, penaltyType: e.target.value })}>
                <option value="nights">Number of nights</option>
                <option value="percent">Percent of booking</option>
              </select>
            </label>
            <label className="field">
              {f.penaltyType === 'nights' ? 'Nights' : 'Percent'}
              <input type="number" min={1} max={100} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
            </label>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button>Add policy</button>
      </div>
    </form>
  );
}
