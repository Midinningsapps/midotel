// Aurora: Midotel's first theme. Original design: calm, photo-led, generous whitespace.
import type { Section } from '@midotel/sections';
import type { SiteData, SitePage } from '@/lib/data';
import { HeroSlider } from './HeroSlider';
import { BookingBar } from './BookingBar';

export interface ThemeProps {
  data: SiteData;
  page: SitePage;
  /** Builds a link to another page of this site (keeps preview tokens). */
  href: (slug: string) => string;
  bookingUrl: string;
}

const NIGHT = ' ';

export function AuroraTheme({ data, page, href, bookingUrl }: ThemeProps) {
  const { property, tokens } = data;
  const menu = data.pages.filter((p) => p.showInMenu);
  const style = {
    '--primary': tokens.primaryColor,
    '--accent': tokens.accentColor,
    '--heading-font': tokens.headingFont === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)',
  } as React.CSSProperties;

  return (
    <div className="aurora" style={style}>
      {data.mode === 'draft' && <div className="preview-flag">Preview of unpublished changes</div>}
      <header className="a-header">
        <a className="a-logo" href={href('')}>
          {property.name}
        </a>
        <nav className="a-nav">
          {menu
            .filter((p) => p.kind !== 'home')
            .map((p) => (
              <a key={p.slug} href={href(p.slug)} aria-current={p.slug === page.slug ? 'page' : undefined}>
                {p.title}
              </a>
            ))}
        </nav>
        <a className="a-btn a-btn-accent" href={bookingUrl}>
          Book now
        </a>
      </header>

      <main>
        {page.sections.map((s) => (
          <SectionView key={s.id} section={s} data={data} href={href} bookingUrl={bookingUrl} />
        ))}
        {page.sections.length === 0 && (
          <section className="a-section a-center">
            <h1 className="a-h1">{page.title}</h1>
            <p className="a-muted">This page has no content yet.</p>
          </section>
        )}
      </main>

      <footer className="a-footer">
        <div>
          <div className="a-logo">{property.name}</div>
          {property.address && <p>{property.address}</p>}
        </div>
        <div>
          {property.phone && <p>Phone: {property.phone}</p>}
          {property.email && <p>Email: {property.email}</p>}
          <p>
            Check-in {property.checkInTime}
            {NIGHT}· Check-out {property.checkOutTime}
          </p>
        </div>
        <p className="a-powered">Website by Midotel</p>
      </footer>
    </div>
  );
}

function SectionView({ section: s, data, href, bookingUrl }: { section: Section; data: SiteData; href: ThemeProps['href']; bookingUrl: string }) {
  const img = (id: string | null | undefined) => (id ? data.images[id] : undefined);
  switch (s.type) {
    case 'hero': {
      const slides = s.data.imageIds.map((i) => data.images[i]).filter((x) => !!x);
      return (
        <section className="a-hero">
          <HeroSlider images={slides} />
          <div className="a-hero-text">
            {s.data.heading && <h1>{s.data.heading}</h1>}
            {s.data.subheading && <p>{s.data.subheading}</p>}
          </div>
          {s.data.showBookingBar && <BookingBar bookingUrl={bookingUrl} />}
        </section>
      );
    }
    case 'text': {
      const image = img(s.data.imageId);
      return (
        <section className={`a-section a-split ${image ? '' : 'a-split-noimg'} ${s.data.imageSide === 'left' ? 'a-split-left' : ''}`}>
          <div>
            {s.data.eyebrow && <p className="a-eyebrow">{s.data.eyebrow}</p>}
            {s.data.heading && <h2 className="a-h2">{s.data.heading}</h2>}
            {s.data.body.split(/\n{2,}/).map((para, i) => (
              <p key={i} className="a-body">
                {para}
              </p>
            ))}
          </div>
          {image && <img className="a-split-img" src={image.url} alt={image.alt} loading="lazy" />}
        </section>
      );
    }
    case 'rooms':
      return (
        <section className="a-section">
          {s.data.heading && <h2 className="a-h2 a-center">{s.data.heading}</h2>}
          {s.data.intro && <p className="a-body a-center">{s.data.intro}</p>}
          <div className="a-rooms">
            {data.rooms.map((r) => {
              const photo = img(r.imageIds[0]);
              return (
                <article key={r.id} className="a-room">
                  {photo ? <img src={photo.url} alt={photo.alt || r.name} loading="lazy" /> : <div className="a-room-ph" />}
                  <div className="a-room-body">
                    <h3>{r.name}</h3>
                    {r.shortDescription && <p>{r.shortDescription}</p>}
                    <ul className="a-facts">
                      <li>Up to {r.maxOccupancy} guests</li>
                      {r.bedType && <li>{r.bedType} bed</li>}
                      {r.sizeSqft && <li>{r.sizeSqft} sq ft</li>}
                    </ul>
                    <a className="a-btn" href={`${bookingUrl}${bookingUrl.includes('?') ? '&' : '?'}room=${r.code}`}>
                      Check availability
                    </a>
                  </div>
                </article>
              );
            })}
            {data.rooms.length === 0 && <p className="a-muted a-center">Rooms will appear here once added in the admin.</p>}
          </div>
        </section>
      );
    case 'amenities':
      return (
        <section className="a-section a-tint">
          {s.data.heading && <h2 className="a-h2 a-center">{s.data.heading}</h2>}
          {s.data.intro && <p className="a-body a-center">{s.data.intro}</p>}
          <ul className="a-amenities">
            {data.property.amenities.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          {data.property.amenities.length === 0 && <p className="a-muted a-center">Add amenities in the hotel details.</p>}
        </section>
      );
    case 'gallery': {
      const pics = s.data.imageIds.map((i) => data.images[i]).filter((x) => !!x);
      return (
        <section className="a-section">
          {s.data.heading && <h2 className="a-h2 a-center">{s.data.heading}</h2>}
          <div className="a-gallery">
            {pics.map((p, i) => (
              <img key={i} src={p.url} alt={p.alt} loading="lazy" />
            ))}
          </div>
          {pics.length === 0 && <p className="a-muted a-center">Choose photos for this gallery in the admin.</p>}
        </section>
      );
    }
    case 'cta':
      return (
        <section className="a-section a-cta">
          {s.data.heading && <h2 className="a-h2">{s.data.heading}</h2>}
          {s.data.body && <p className="a-body">{s.data.body}</p>}
          {s.data.buttonLabel && (
            <a className="a-btn a-btn-accent" href={s.data.buttonLink === '#book' ? bookingUrl : s.data.buttonLink}>
              {s.data.buttonLabel}
            </a>
          )}
        </section>
      );
    case 'contact': {
      const p = data.property;
      const hasMap = s.data.showMap && p.latitude !== null && p.longitude !== null;
      const d = 0.01;
      return (
        <section className={`a-section a-split ${hasMap ? '' : 'a-split-noimg'}`}>
          <div>
            {s.data.heading && <h2 className="a-h2">{s.data.heading}</h2>}
            {s.data.intro && <p className="a-body">{s.data.intro}</p>}
            {p.address && <p className="a-body">{p.address}</p>}
            {p.phone && (
              <p className="a-body">
                <a href={`tel:${p.phone.replace(/\s/g, '')}`}>{p.phone}</a>
              </p>
            )}
            {p.email && (
              <p className="a-body">
                <a href={`mailto:${p.email}`}>{p.email}</a>
              </p>
            )}
            <a className="a-btn" href={href('contact')}>
              Contact page
            </a>
          </div>
          {hasMap && (
            <iframe
              className="a-map"
              title={`Map of ${p.name}`}
              loading="lazy"
              src={`https://www.openstreetmap.org/export/embed.html?bbox=${p.longitude! - d}%2C${p.latitude! - d}%2C${p.longitude! + d}%2C${p.latitude! + d}&layer=mapnik&marker=${p.latitude}%2C${p.longitude}`}
            />
          )}
        </section>
      );
    }
  }
}
