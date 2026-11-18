// Published site, addressed by hostname. In production a proxy maps www.hotel.com/* to /s/www.hotel.com/*.
import type { Metadata } from 'next';
import { loadPublished } from '@/lib/data';
import { renderSite, siteMetadata } from '@/lib/render';

type Props = { params: Promise<{ host: string; slug?: string[] }> };

const BOOKING_BASE = process.env.BOOKING_URL ?? 'http://localhost:3002';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, slug } = await params;
  return siteMetadata(await loadPublished(decodeURIComponent(host)), slug);
}

export default async function PublishedPage({ params }: Props) {
  const { host, slug } = await params;
  const h = decodeURIComponent(host);
  const load = await loadPublished(h);
  const href = (s: string) => `/s/${encodeURIComponent(h)}${s ? `/${s}` : ''}`;
  const bookingUrl = load.ok ? `${BOOKING_BASE}/?property=${load.data.property.id}` : BOOKING_BASE;
  return renderSite(load, slug, href, bookingUrl);
}
