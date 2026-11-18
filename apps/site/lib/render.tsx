import type { Metadata } from 'next';
import { AuroraTheme } from '@/themes/aurora/Theme';
import { findPage, type Load, type SiteData } from './data';

export function siteMetadata(load: Load, slug: string[] | undefined): Metadata {
  if (!load.ok) return { title: 'Site unavailable', robots: { index: false } };
  const page = findPage(load.data, slug);
  const p = load.data.property;
  if (!page) return { title: `Page not found | ${p.name}` };
  const title = page.seoTitle || (page.kind === 'home' ? p.name : `${page.title} | ${p.name}`);
  const description = page.seoDescription || p.tagline || p.description?.slice(0, 160) || undefined;
  return {
    title,
    description,
    robots: load.data.mode === 'draft' ? { index: false, follow: false } : undefined,
    openGraph: { title, description, type: 'website' },
  };
}

/** schema.org Hotel data helps search engines show the hotel richly. */
function jsonLd(data: SiteData) {
  const p = data.property;
  const first = Object.values(data.images)[0];
  return {
    '@context': 'https://schema.org',
    '@type': 'Hotel',
    name: p.name,
    description: p.tagline ?? p.description ?? undefined,
    telephone: p.phone ?? undefined,
    email: p.email ?? undefined,
    address: p.address || undefined,
    image: first?.url,
    checkinTime: p.checkInTime,
    checkoutTime: p.checkOutTime,
    starRating: p.starRating ? { '@type': 'Rating', ratingValue: p.starRating } : undefined,
    geo: p.latitude !== null ? { '@type': 'GeoCoordinates', latitude: p.latitude, longitude: p.longitude } : undefined,
    amenityFeature: p.amenities.map((a) => ({ '@type': 'LocationFeatureSpecification', name: a, value: true })),
  };
}

export function renderSite(load: Load, slug: string[] | undefined, href: (slug: string) => string, bookingUrl: string) {
  if (!load.ok) {
    return (
      <div className="site-error">
        <h1>{load.status === 404 ? 'Site not found' : 'Something went wrong'}</h1>
        <p>{load.message}</p>
      </div>
    );
  }
  const page = findPage(load.data, slug);
  if (!page) {
    return (
      <div className="site-error">
        <h1>Page not found</h1>
        <p>
          <a href={href('')}>Go to the home page</a>
        </p>
      </div>
    );
  }
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(load.data)).replace(/</g, '\\u003c') }} />
      <AuroraTheme data={load.data} page={page} href={href} bookingUrl={bookingUrl} />
    </>
  );
}
