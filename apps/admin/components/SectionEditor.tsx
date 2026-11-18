'use client';
import type { Section } from '@midotel/sections';
import { SECTION_LABELS } from '@midotel/sections';
import { ImageField } from './ImagePicker';

type Props = {
  section: Section;
  propertyId: string;
  onChange: (s: Section) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
};

const AUTO_NOTES: Partial<Record<Section['type'], string>> = {
  rooms: 'Shows your active room types with their first photo. Edit rooms in the Rooms tab.',
  amenities: 'Shows the amenities listed in Hotel details.',
  contact: 'Shows the address, phone, email and map from Hotel details.',
};

export function SectionEditor({ section, propertyId, onChange, onMove, onRemove, first, last }: Props) {
  // Generic setter: copies the section and updates one data field.
  const set = (key: string, value: unknown) => onChange({ ...section, data: { ...section.data, [key]: value } } as Section);
  const text = (key: string, label: string, opts: { area?: boolean; max?: number; wide?: boolean } = {}) => {
    const value = String((section.data as Record<string, unknown>)[key] ?? '');
    return (
      <label className={`field ${opts.wide || opts.area ? 'wide' : ''}`}>
        {label}
        {opts.area ? (
          <textarea value={value} maxLength={opts.max} onChange={(e) => set(key, e.target.value)} />
        ) : (
          <input value={value} maxLength={opts.max} onChange={(e) => set(key, e.target.value)} />
        )}
      </label>
    );
  };

  return (
    <div className="card section-card">
      <div className="section-head">
        <strong>{SECTION_LABELS[section.type]}</strong>
        <span className="spacer" />
        <button type="button" disabled={first} onClick={() => onMove(-1)} aria-label="Move up">
          ↑
        </button>
        <button type="button" disabled={last} onClick={() => onMove(1)} aria-label="Move down">
          ↓
        </button>
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      {AUTO_NOTES[section.type] && <p className="muted">{AUTO_NOTES[section.type]}</p>}
      <div className="grid">
        {section.type === 'hero' && (
          <>
            {text('heading', 'Heading', { max: 120, wide: true })}
            {text('subheading', 'Subheading', { max: 240, wide: true })}
            <ImageField propertyId={propertyId} label="Slideshow photos" value={section.data.imageIds} onChange={(ids) => set('imageIds', ids)} />
            <label className="field check">
              <input type="checkbox" checked={section.data.showBookingBar} onChange={(e) => set('showBookingBar', e.target.checked)} /> Show date and guest search
            </label>
          </>
        )}
        {section.type === 'text' && (
          <>
            {text('eyebrow', 'Small label above the heading', { max: 60 })}
            {text('heading', 'Heading', { max: 120 })}
            {text('body', 'Text (leave a blank line between paragraphs)', { area: true, max: 5000 })}
            <ImageField
              propertyId={propertyId}
              label="Photo"
              multiple={false}
              value={section.data.imageId ? [section.data.imageId] : []}
              onChange={(ids) => set('imageId', ids[0] ?? null)}
            />
            <label className="field">
              Photo position
              <select value={section.data.imageSide} onChange={(e) => set('imageSide', e.target.value)}>
                <option value="right">Right of the text</option>
                <option value="left">Left of the text</option>
              </select>
            </label>
          </>
        )}
        {(section.type === 'rooms' || section.type === 'amenities') && (
          <>
            {text('heading', 'Heading', { max: 120 })}
            {text('intro', 'Introduction', { area: true, max: 600 })}
          </>
        )}
        {section.type === 'gallery' && (
          <>
            {text('heading', 'Heading', { max: 120 })}
            <ImageField propertyId={propertyId} label="Photos" value={section.data.imageIds} onChange={(ids) => set('imageIds', ids)} />
          </>
        )}
        {section.type === 'cta' && (
          <>
            {text('heading', 'Heading', { max: 120 })}
            {text('buttonLabel', 'Button label', { max: 40 })}
            {text('body', 'Text', { area: true, max: 600 })}
            {text('buttonLink', 'Button link (#book opens the booking engine)', { max: 500, wide: true })}
          </>
        )}
        {section.type === 'contact' && (
          <>
            {text('heading', 'Heading', { max: 120 })}
            {text('intro', 'Introduction', { area: true, max: 600 })}
            <label className="field check">
              <input type="checkbox" checked={section.data.showMap} onChange={(e) => set('showMap', e.target.checked)} /> Show map (needs latitude and longitude)
            </label>
          </>
        )}
      </div>
    </div>
  );
}
