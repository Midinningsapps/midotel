// Short-lived signed tokens that let the site renderer show a property's unpublished draft.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.PREVIEW_SECRET ?? randomBytes(32).toString('hex');
const TTL_MS = 2 * 60 * 60 * 1000;

const sign = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('base64url');

export function makePreviewToken(tenantId: string, propertyId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, p: propertyId, e: now + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readPreviewToken(token: string, now = Date.now()): { tenantId: string; propertyId: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: string; p: string; e: number };
    if (typeof data.e !== 'number' || data.e < now) return null;
    return { tenantId: data.t, propertyId: data.p };
  } catch {
    return null;
  }
}
