'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export interface Media {
  id: string;
  url: string;
  fileName: string;
  alt: string | null;
}

/** Upload one image to a property's library. */
export async function uploadImage(propertyId: string, file: File): Promise<Media> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/properties/${propertyId}/media`, { method: 'POST', body: form, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Upload failed');
  return data as Media;
}

export function useMedia(propertyId: string) {
  const [items, setItems] = useState<Media[]>([]);
  const reload = () => api<Media[]>(`/properties/${propertyId}/media`).then(setItems).catch(() => {});
  useEffect(() => {
    reload();
  }, [propertyId]);
  return { items, reload };
}

/** Shows chosen images as thumbnails, with a library to add, remove and reorder them. */
export function ImageField({
  propertyId,
  value,
  onChange,
  multiple = true,
  label,
}: {
  propertyId: string;
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const { items, reload } = useMedia(propertyId);
  const byId = new Map(items.map((m) => [m.id, m]));
  const move = (i: number, d: number) => {
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };

  return (
    <div className="field wide">
      {label}
      <div className="thumbs">
        {value.map((id, i) => {
          const m = byId.get(id);
          return (
            <div key={id} className="thumb">
              {m ? <img src={m.url} alt={m.alt ?? ''} /> : <div className="thumb-missing">missing</div>}
              <div className="thumb-actions">
                {multiple && i > 0 && (
                  <button type="button" onClick={() => move(i, -1)} aria-label="Move left">
                    ←
                  </button>
                )}
                <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} aria-label="Remove">
                  ×
                </button>
                {multiple && i < value.length - 1 && (
                  <button type="button" onClick={() => move(i, 1)} aria-label="Move right">
                    →
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button type="button" className="thumb-add" onClick={() => setOpen(true)}>
          {value.length && !multiple ? 'Change' : '+ Add photo'}
        </button>
      </div>
      {open && (
        <Library
          propertyId={propertyId}
          items={items}
          reload={reload}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            onChange(multiple ? (value.includes(id) ? value : [...value, id]) : [id]);
            if (!multiple) setOpen(false);
          }}
          picked={value}
        />
      )}
    </div>
  );
}

function Library({
  propertyId,
  items,
  reload,
  onClose,
  onPick,
  picked,
}: {
  propertyId: string;
  items: Media[];
  reload: () => Promise<void>;
  onClose: () => void;
  onPick: (id: string) => void;
  picked: string[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError('');
    try {
      for (const f of Array.from(files)) {
        const m = await uploadImage(propertyId, f);
        onPick(m.id);
      }
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="actions" style={{ marginTop: 0, justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Photo library</h2>
          <div className="actions" style={{ marginTop: 0 }}>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={(e) => upload(e.target.files)} />
            <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Uploading…' : 'Upload photos'}
            </button>
            <button type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <p className="muted">Click a photo to use it. JPEG, PNG, WebP or AVIF, up to 10 MB each.</p>
        <div className="library">
          {items.map((m) => (
            <button type="button" key={m.id} className={`lib-item ${picked.includes(m.id) ? 'picked' : ''}`} onClick={() => onPick(m.id)}>
              <img src={m.url} alt={m.alt ?? m.fileName} />
            </button>
          ))}
          {items.length === 0 && <p className="muted">No photos yet. Upload your first ones.</p>}
        </div>
      </div>
    </div>
  );
}
