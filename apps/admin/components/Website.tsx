'use client';
import { useEffect, useState } from 'react';
import { newSection, SECTION_LABELS, type Section, type SectionType, type ThemeTokens } from '@midotel/sections';
import { api } from '@/lib/api';
import { SectionEditor } from './SectionEditor';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001';

interface Page {
  id: string;
  slug: string;
  title: string;
  kind: 'home' | 'custom';
  sortOrder: number;
  showInMenu: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  sections: Section[];
  isPublished: boolean;
  hasUnpublishedChanges: boolean;
}

interface Site {
  theme: string;
  tokens: ThemeTokens;
  publishedVersion: number;
  publishedAt: string | null;
  pages: Page[];
}

const newId = () => Math.random().toString(36).slice(2, 10);

export function Website({ propertyId }: { propertyId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Page | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(selectId?: string) {
    const s = await api<Site>(`/properties/${propertyId}/site`);
    setSite(s);
    const pick = s.pages.find((p) => p.id === (selectId ?? pageId)) ?? s.pages[0]!;
    setPageId(pick.id);
    setDraft(pick);
    setDirty(false);
  }
  useEffect(() => {
    load().catch((e) => setMsg({ ok: false, text: e.message }));
  }, [propertyId]);

  if (!site || !draft) return <p className="muted">{msg?.text ?? 'Loading…'}</p>;

  const edit = (patch: Partial<Page>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setMsg(null);
  };
  const setSections = (sections: Section[]) => edit({ sections });

  function selectPage(id: string) {
    if (dirty && !confirm('You have unsaved changes on this page. Discard them?')) return;
    const p = site!.pages.find((x) => x.id === id)!;
    setPageId(id);
    setDraft(p);
    setDirty(false);
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/pages/${draft!.id}`, {
        method: 'PATCH',
        body: {
          title: draft!.title,
          slug: draft!.slug,
          showInMenu: draft!.showInMenu,
          sortOrder: draft!.sortOrder,
          seoTitle: draft!.seoTitle?.trim() || null,
          seoDescription: draft!.seoDescription?.trim() || null,
          sections: draft!.sections,
        },
      });
      await load(draft!.id);
      setMsg({ ok: true, text: 'Saved as draft. Publish to put it live.' });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (dirty) {
      setMsg({ ok: false, text: 'Save this page first, then publish.' });
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ version: number }>(`/properties/${propertyId}/publish`, { method: 'POST' });
      await load(draft!.id);
      setMsg({ ok: true, text: `Published (version ${r.version}).` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    // Open the tab synchronously so pop-up blockers allow it, then point it at the signed preview URL.
    const win = window.open('about:blank', '_blank');
    const { token } = await api<{ token: string }>(`/properties/${propertyId}/preview-token`, { method: 'POST' });
    const path = draft!.kind === 'home' ? '' : `/${draft!.slug}`;
    const url = `${SITE_URL}/preview${path}?token=${encodeURIComponent(token)}`;
    if (win) win.location.href = url;
    else window.location.href = url;
  }

  async function addPage() {
    const title = prompt('Page title (for example: Weddings)');
    if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
    try {
      const p = await api<Page>(`/properties/${propertyId}/pages`, { method: 'POST', body: { title, slug } });
      await load(p.id);
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  async function deletePage() {
    if (!confirm(`Delete the page "${draft!.title}"? It disappears from the live site at the next publish.`)) return;
    await api(`/pages/${draft!.id}`, { method: 'DELETE' });
    setPageId(null);
    await load(site!.pages[0]!.id);
  }

  async function saveTokens(tokens: ThemeTokens) {
    const r = await api<{ tokens: ThemeTokens }>(`/properties/${propertyId}/site`, { method: 'PATCH', body: { tokens } });
    setSite({ ...site!, tokens: r.tokens });
  }

  const changed = site.pages.some((p) => p.hasUnpublishedChanges);
  const move = (i: number, d: number) => {
    const next = [...draft.sections];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setSections(next);
  };

  return (
    <div className="website">
      <div className="card actions" style={{ marginTop: 0, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <strong>Website</strong>{' '}
          <span className={`badge ${site.publishedVersion ? 'live' : ''}`}>
            {site.publishedVersion ? `live, version ${site.publishedVersion}` : 'not published yet'}
          </span>{' '}
          {changed && <span className="badge">unpublished changes</span>}
        </div>
        <div className="actions" style={{ marginTop: 0 }}>
          <button onClick={preview}>Preview</button>
          <button className="primary" disabled={busy} onClick={publish}>
            Publish website
          </button>
        </div>
      </div>
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}

      <div className="website-cols">
        <aside className="card">
          <h2>Pages</h2>
          <ul className="page-list">
            {site.pages.map((p) => (
              <li key={p.id}>
                <button className={p.id === pageId ? 'active' : ''} onClick={() => selectPage(p.id)}>
                  {p.title}
                  {p.hasUnpublishedChanges && <span className="dot" title="Unpublished changes" />}
                </button>
              </li>
            ))}
          </ul>
          <button onClick={addPage}>+ Add page</button>
          <h2 style={{ marginTop: 24 }}>Web address</h2>
          <Domains propertyId={propertyId} />
          <h2 style={{ marginTop: 24 }}>Look</h2>
          <TokensForm tokens={site.tokens} onSave={saveTokens} />
        </aside>

        <div>
          <div className="card">
            <div className="grid">
              <label className="field">
                Page title
                <input value={draft.title} maxLength={80} onChange={(e) => edit({ title: e.target.value })} />
              </label>
              <label className="field">
                Address
                <input
                  value={draft.kind === 'home' ? '/' : `/${draft.slug}`}
                  disabled={draft.kind === 'home'}
                  onChange={(e) => edit({ slug: e.target.value.replace(/^\//, '').toLowerCase() })}
                />
              </label>
              <label className="field">
                Menu position
                <input type="number" min={0} value={draft.sortOrder} onChange={(e) => edit({ sortOrder: Number(e.target.value) })} />
              </label>
              <label className="field check">
                <input type="checkbox" checked={draft.showInMenu} onChange={(e) => edit({ showInMenu: e.target.checked })} /> Show in menu
              </label>
              <label className="field wide">
                Search engine title <Counter value={draft.seoTitle} max={60} />
                <input value={draft.seoTitle ?? ''} maxLength={70} onChange={(e) => edit({ seoTitle: e.target.value })} />
              </label>
              <label className="field wide">
                Search engine description <Counter value={draft.seoDescription} max={160} />
                <textarea value={draft.seoDescription ?? ''} maxLength={170} onChange={(e) => edit({ seoDescription: e.target.value })} />
              </label>
            </div>
          </div>

          {draft.sections.map((s, i) => (
            <SectionEditor
              key={s.id}
              section={s}
              propertyId={propertyId}
              first={i === 0}
              last={i === draft.sections.length - 1}
              onChange={(next) => setSections(draft.sections.map((x) => (x.id === s.id ? next : x)))}
              onMove={(d) => move(i, d)}
              onRemove={() => setSections(draft.sections.filter((x) => x.id !== s.id))}
            />
          ))}

          <div className="card actions" style={{ marginTop: 0 }}>
            <select
              defaultValue=""
              onChange={(e) => {
                if (!e.target.value) return;
                setSections([...draft.sections, newSection(e.target.value as SectionType, newId())]);
                e.target.value = '';
              }}
            >
              <option value="">+ Add a section…</option>
              {Object.entries(SECTION_LABELS).map(([type, label]) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </select>
            <span className="spacer" />
            {draft.kind !== 'home' && (
              <button className="danger" onClick={deletePage}>
                Delete page
              </button>
            )}
            <button className="primary" disabled={busy || !dirty} onClick={save}>
              {dirty ? 'Save page' : 'Saved'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Counter({ value, max }: { value: string | null; max: number }) {
  const n = value?.length ?? 0;
  return <span className={n > max ? 'error' : 'muted'}>({n}/{max})</span>;
}

function TokensForm({ tokens, onSave }: { tokens: ThemeTokens; onSave: (t: ThemeTokens) => Promise<void> }) {
  const [t, setT] = useState(tokens);
  const [saved, setSaved] = useState(false);
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      <label className="field">
        Main colour
        <input type="color" value={t.primaryColor} onChange={(e) => setT({ ...t, primaryColor: e.target.value })} />
      </label>
      <label className="field">
        Button colour
        <input type="color" value={t.accentColor} onChange={(e) => setT({ ...t, accentColor: e.target.value })} />
      </label>
      <label className="field">
        Heading style
        <select value={t.headingFont} onChange={(e) => setT({ ...t, headingFont: e.target.value as ThemeTokens['headingFont'] })}>
          <option value="serif">Classic (serif)</option>
          <option value="sans">Modern (sans-serif)</option>
        </select>
      </label>
      <button
        onClick={async () => {
          await onSave(t);
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }}
      >
        {saved ? 'Saved' : 'Save look'}
      </button>
    </div>
  );
}

interface Domain {
  id: string;
  hostname: string;
  purpose: 'website' | 'booking';
}

function Domains({ propertyId }: { propertyId: string }) {
  const [items, setItems] = useState<Domain[]>([]);
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Domain[]>(`/properties/${propertyId}/domains`).then(setItems).catch(() => {});
  useEffect(() => {
    load();
  }, [propertyId]);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/properties/${propertyId}/domains`, { method: 'POST', body: { hostname: host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), purpose: 'website' } });
      setHost('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div>
      {items.map((d) => (
        <p key={d.id} style={{ margin: '4px 0', wordBreak: 'break-all' }}>
          <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer">
            {d.hostname}
          </a>
        </p>
      ))}
      {items.length === 0 && <p className="muted">No address yet.</p>}
      <form onSubmit={add} className="grid" style={{ gridTemplateColumns: '1fr', marginTop: 8 }}>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.yourhotel.com" required />
        <button>Add address</button>
        {error && <span className="error">{error}</span>}
        <span className="muted">Point the address to Midotel in your domain's DNS settings first.</span>
      </form>
    </div>
  );
}
