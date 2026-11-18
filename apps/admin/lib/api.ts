export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls the Midotel API through the same-origin /api rewrite. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = data?.issues?.[0];
    const msg = issue ? `${issue.path?.join('.') || 'input'}: ${issue.message}` : data?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string };
  tenant: { id: string; name: string; slug: string } | null;
  roles: { role: string; propertyId: string | null }[];
  tenants: { id: string; name: string }[];
}

export interface Property {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  propertyType: string;
  starRating: number | null;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  country: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  currency: string;
  gstin: string | null;
  checkInTime: string;
  checkOutTime: string;
  status: 'draft' | 'live' | 'archived';
  amenities: string[];
  notificationEmails: string[];
}

export interface RoomType {
  id: string;
  name: string;
  code: string;
  shortDescription: string | null;
  description: string | null;
  baseOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  totalUnits: number;
  sizeSqft: number | null;
  bedType: string | null;
  sortOrder: number;
  isActive: boolean;
  imageIds: string[];
}
