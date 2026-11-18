// Draft preview opened from the admin. The token is short-lived and signed by the API.
import type { Metadata } from 'next';
import { loadPreview } from '@/lib/data';
import { renderSite, siteMetadata } from '@/lib/render';

type Props = { params: Promise<{ slug?: string[] }>; searchParams: Promise<{ token?: string }> };

const BOOKING_BASE = process.env.BOOKING_URL ?? 'http://localhost:3002';

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, { token }] = await Promise.all([params, searchParams]);
  if (!token) return { title: 'Preview', robots: { index: false } };
  return siteMetadata(await loadPreview(token), slug);
}

export default async function PreviewPage({ params, searchParams }: Props) {
  const [{ slug }, { token }] = await Promise.all([params, searchParams]);
  if (!token) return <div className="site-error">Open the preview from the Midotel admin.</div>;
  const load = await loadPreview(token);
  const href = (s: string) => `/preview${s ? `/${s}` : ''}?token=${encodeURIComponent(token)}`;
  const bookingUrl = load.ok ? `${BOOKING_BASE}/?property=${load.data.property.id}` : BOOKING_BASE;
  return renderSite(load, slug, href, bookingUrl);
}
