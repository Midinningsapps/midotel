// Published site, addressed by hostname. In production a proxy maps www.hotel.com/* to /s/www.hotel.com/*.
import type { Metadata } from 'next';
import { headers } from 'next/headers';
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
  // On the hotel's own domain links are plain paths; on the platform host they keep the /s/<host> prefix.
  const reqHost = ((await headers()).get('x-forwarded-host') ?? (await headers()).get('host') ?? '').split(':')[0]!.toLowerCase();
  const own = reqHost === h.toLowerCase();
  const href = (s: string) => (own ? `/${s}` : `/s/${encodeURIComponent(h)}${s ? `/${s}` : ''}`);
  const bookingUrl = load.ok ? `${BOOKING_BASE}/?property=${load.data.property.id}` : BOOKING_BASE;
  return renderSite(load, slug, href, bookingUrl);
}
