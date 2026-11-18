'use client';
import { useEffect, useState } from 'react';
import { api, type RoomType } from '@/lib/api';

interface Connection {
  id: string;
  provider: 'ezee' | 'staah' | 'simulator';
  certified: boolean;
  hotelCode: string;
  endpointUrl: string | null;
  hasCredentials: boolean;
  master: 'channel_manager' | 'midotel';
  isActive: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  webhookUrl: string;
  roomMaps: { roomTypeId: string; externalCode: string }[];
  rateMaps: { roomTypeId: string; ratePlanId: string; externalCode: string }[];
  outbox: { id: string; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string; payload: { from?: string; to?: string } }[];
  inbound: { id: number; kind: string; outcome: string; detail: string | null; createdAt: string }[];
}
interface Plan {
  id: string;
  name: string;
  code: string;
}

const NAMES = { ezee: 'eZee Centrix', staah: 'STAAH', simulator: 'Simulator (for testing)' };
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function ChannelManager({ propertyId }: { propertyId: string }) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = async () => {
    const [c, r, p] = await Promise.all([
      api<Connection[]>(`/properties/${propertyId}/channels`),
      api<RoomType[]>(`/properties/${propertyId}/room-types`),
      api<Plan[]>(`/properties/${propertyId}/rate-plans`),
    ]);
    setConns(c);
    setRooms(r);
    setPlans(p);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [propertyId]);

  if (!conns) return <p className="muted">{error || 'Loading…'}</p>;
  return (
    <>
      <div className="card">
        <h2>Channel manager</h2>
        <p className="muted">
          Connect your channel manager so bookings from Booking.com, MakeMyTrip, Agoda and other OTAs block rooms here, and website bookings block rooms on the OTAs.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
      {newToken && (
        <div className="card" style={{ borderColor: '#d97706' }}>
          <strong>Copy this secret now. It will not be shown again.</strong>
          <p className="muted">Give it to your channel manager together with the webhook address below, so it can send bookings to Midotel.</p>
          <code style={{ wordBreak: 'break-all' }}>{newToken}</code>
          <div className="actions">
            <button onClick={() => navigator.clipboard?.writeText(newToken)}>Copy</button>
            <button onClick={() => setNewToken(null)}>I have saved it</button>
          </div>
        </div>
      )}
      {conns.map((c) => (
        <ConnectionCard key={c.id} c={c} rooms={rooms} plans={plans} onChange={load} />
      ))}
      <NewConnection propertyId={propertyId} existing={conns.map((c) => c.provider)} onCreated={(t) => (setNewToken(t), load())} />
    </>
  );
}

function ConnectionCard({ c, rooms, plans, onChange }: { c: Connection; rooms: RoomType[]; plans: Plan[]; onChange: () => Promise<void> }) {
  const [roomCodes, setRoomCodes] = useState<Record<string, string>>(() => Object.fromEntries(c.roomMaps.map((m) => [m.roomTypeId, m.externalCode])));
  const [rateCodes, setRateCodes] = useState<Record<string, string>>(() => Object.fromEntries(c.rateMaps.map((m) => [`${m.roomTypeId}|${m.ratePlanId}`, m.externalCode])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const saveMappings = () =>
    run(
      () =>
        api(`/channels/${c.id}/mappings`, {
          method: 'PUT',
          body: {
            rooms: Object.entries(roomCodes)
              .filter(([, v]) => v.trim())
              .map(([roomTypeId, externalCode]) => ({ roomTypeId, externalCode: externalCode.trim() })),
            rates: Object.entries(rateCodes)
              .filter(([k, v]) => v.trim() && roomCodes[k.split('|')[0]!]?.trim())
              .map(([k, externalCode]) => {
                const [roomTypeId, ratePlanId] = k.split('|');
                return { roomTypeId, ratePlanId, externalCode: externalCode.trim() };
              }),
          },
        }),
      'Mappings saved',
    );

  return (
    <div className="card">
      <div className="actions" style={{ marginTop: 0, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{NAMES[c.provider]}</h2>
        <span className={`badge ${c.isActive ? 'live' : ''}`}>{c.isActive ? 'connected' : 'off'}</span>
        {!c.certified && <span className="badge">draft: waiting for {NAMES[c.provider]} API access</span>}
        <span className="spacer" />
        <button onClick={() => run(() => api(`/channels/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } }), c.isActive ? 'Switched off' : 'Switched on')}>
          {c.isActive ? 'Switch off' : 'Switch on'}
        </button>
        {c.master === 'midotel' && c.isActive && (
          <button onClick={() => run(() => api(`/channels/${c.id}/full-sync`, { method: 'POST', body: { days: 365 } }), 'Full sync queued for the next 365 days')}>Send all rates now</button>
        )}
      </div>
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
      <div className="grid" style={{ marginTop: 12 }}>
        <div className="field">
          Hotel code at {NAMES[c.provider]}
          <strong style={{ color: 'var(--text)' }}>{c.hotelCode}</strong>
        </div>
        <label className="field">
          Who manages rates and availability?
          <select value={c.master} onChange={(e) => run(() => api(`/channels/${c.id}`, { method: 'PATCH', body: { master: e.target.value } }), 'Saved')}>
            <option value="channel_manager">The channel manager (Midotel receives them)</option>
            <option value="midotel">Midotel (we send them to the channel manager)</option>
          </select>
        </label>
        <div className="field">
          Last successful sync
          <span style={{ color: 'var(--text)' }}>{when(c.lastSuccessAt)}</span>
          {c.lastError && <span className="error">{c.lastError}</span>}
        </div>
        <div className="field wide">
          Webhook address for {NAMES[c.provider]}
          <code style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{c.webhookUrl}</code>
        </div>
      </div>

      <h3>Room and rate mapping</h3>
      <p className="muted">Enter the codes {NAMES[c.provider]} uses for each of your rooms and rate plans. Unmapped rates are sold only on your website.</p>
      <table>
        <thead>
          <tr>
            <th>Room</th>
            <th>Room code</th>
            {plans.map((p) => (
              <th key={p.id}>{p.name} code</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>
                <input value={roomCodes[r.id] ?? ''} onChange={(e) => setRoomCodes({ ...roomCodes, [r.id]: e.target.value })} placeholder="e.g. 177539" />
              </td>
              {plans.map((p) => (
                <td key={p.id}>
                  <input
                    value={rateCodes[`${r.id}|${p.id}`] ?? ''}
                    disabled={!roomCodes[r.id]?.trim()}
                    onChange={(e) => setRateCodes({ ...rateCodes, [`${r.id}|${p.id}`]: e.target.value })}
                    placeholder="rate code"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="primary" onClick={saveMappings}>
          Save mapping
        </button>
      </div>

      <h3>Recent activity</h3>
      <table>
        <tbody>
          {[
            ...c.outbox.map((o) => ({ at: o.createdAt, dir: 'Sent', what: o.kind === 'ari' ? `Rates and availability ${o.payload.from ?? ''} to ${o.payload.to ?? ''}` : 'Booking', status: o.status, note: o.lastError })),
            ...c.inbound.map((i) => ({ at: i.createdAt, dir: 'Received', what: i.kind, status: i.outcome, note: i.detail })),
          ]
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 20)
            .map((row, i) => (
              <tr key={i}>
                <td className="muted">{when(row.at)}</td>
                <td>{row.dir}</td>
                <td>{row.what}</td>
                <td>
                  <span className={`badge ${row.status === 'sent' || row.status === 'applied' ? 'live' : ''}`}>{row.status}</span>
                </td>
                <td className="muted">{row.note}</td>
              </tr>
            ))}
          {c.outbox.length + c.inbound.length === 0 && (
            <tr>
              <td className="muted">Nothing yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function NewConnection({ propertyId, existing, onCreated }: { propertyId: string; existing: string[]; onCreated: (token: string) => void }) {
  const [f, setF] = useState({ provider: 'staah', hotelCode: '', endpointUrl: '', username: '', password: '', master: 'channel_manager' });
  const [error, setError] = useState('');
  const options = (['staah', 'ezee', 'simulator'] as const).filter((p) => !existing.includes(p));
  if (!options.length) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api<{ inboundToken: string }>(`/properties/${propertyId}/channels`, {
        method: 'POST',
        body: {
          provider: f.provider,
          hotelCode: f.hotelCode,
          endpointUrl: f.endpointUrl || null,
          username: f.username || undefined,
          password: f.password || undefined,
          master: f.master,
        },
      });
      onCreated(res.inboundToken);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Connect a channel manager</h2>
      <div className="grid">
        <label className="field">
          Channel manager
          <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            {options.map((p) => (
              <option key={p} value={p}>
                {NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Your hotel code at the channel manager
          <input value={f.hotelCode} onChange={(e) => setF({ ...f, hotelCode: e.target.value })} required placeholder="e.g. 26676" />
        </label>
        <label className="field">
          Who manages rates and availability?
          <select value={f.master} onChange={(e) => setF({ ...f, master: e.target.value })}>
            <option value="channel_manager">The channel manager</option>
            <option value="midotel">Midotel</option>
          </select>
        </label>
        {f.provider !== 'simulator' && (
          <>
            <label className="field wide">
              API address (from the channel manager, optional for now)
              <input type="url" value={f.endpointUrl} onChange={(e) => setF({ ...f, endpointUrl: e.target.value })} />
            </label>
            <label className="field">
              API username
              <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">
              API password
              <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" />
            </label>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary">Add connection</button>
      </div>
    </form>
  );
}
