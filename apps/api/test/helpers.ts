import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { createPool } from '@midotel/db';
import { buildApp } from '../src/app.ts';

export async function makeApp() {
  const pool = createPool(inject('appUrl'), 5);
  const app = await buildApp({ pool });
  return { app, pool };
}

export interface Owner {
  cookie: string;
  tenantId: string;
  propertyId: string;
  email: string;
}

export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0]!;
}

/** Sign up a fresh company with one property and return its session cookie. */
export async function signUp(app: FastifyInstance, label = 'Hotel'): Promise<Owner> {
  const email = `owner-${randomUUID()}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Test Owner',
      email,
      password: 'correct horse battery',
      companyName: `${label} Group ${randomUUID().slice(0, 4)}`,
      propertyName: `${label} Palace`,
    },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { tenantId: string; propertyId: string };
  return { cookie: cookieFrom(res), tenantId: body.tenantId, propertyId: body.propertyId, email };
}
