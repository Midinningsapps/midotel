import type { Section, ThemeTokens } from '@midotel/sections';

export interface SiteImage {
  url: string;
  alt: string;
}

export interface SitePage {
  title: string;
  slug: string;
  kind: 'home' | 'custom';
  sortOrder: number;
  showInMenu: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  sections: Section[];
}

export interface SiteData {
  mode: 'draft' | 'published';
  version: number;
  theme: string;
  tokens: ThemeTokens;
  property: {
    id: string;
    name: string;
    tagline: string | null;
    description: string | null;
    email: string | null;
    phone: string | null;
    address: string;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    currency: string;
    checkInTime: string;
    checkOutTime: string;
    starRating: number | null;
    amenities: string[];
  };
  rooms: {
    id: string;
    name: string;
    code: string;
    shortDescription: string | null;
    description: string | null;
    maxAdults: number;
    maxChildren: number;
    maxOccupancy: number;
    sizeSqft: number | null;
    bedType: string | null;
    imageIds: string[];
  }[];
  pages: SitePage[];
  images: Record<string, SiteImage>;
}

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export type Load = { ok: true; data: SiteData } | { ok: false; status: number; message: string };

async function load(url: string): Promise<Load> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, message: body.error ?? 'Site unavailable' };
    return { ok: true, data: body as SiteData };
  } catch {
    return { ok: false, status: 503, message: 'Site temporarily unavailable' };
  }
}

export const loadPublished = (host: string) => load(`${API}/public/site?host=${encodeURIComponent(host)}`);
export const loadPreview = (token: string) => load(`${API}/public/preview?token=${encodeURIComponent(token)}`);

export function findPage(data: SiteData, slug: string[] | undefined): SitePage | undefined {
  const path = slug?.join('/') ?? '';
  return path === '' ? data.pages.find((p) => p.kind === 'home') : data.pages.find((p) => p.slug === path && p.kind !== 'home');
}
