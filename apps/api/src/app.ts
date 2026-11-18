import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import { ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import { globalDb, schema, type Db } from '@midotel/db';
import { hashToken, SESSION_COOKIE } from './auth.ts';
import { authRoutes } from './routes/auth.ts';
import { propertyRoutes } from './routes/properties.ts';
import { roomTypeRoutes } from './routes/room-types.ts';
import { domainRoutes } from './routes/domains.ts';
import { publicRoutes } from './routes/public.ts';

export type Role = 'owner' | 'manager' | 'front_desk' | 'content_editor';

export interface AuthContext {
  userId: string;
  tenantId: string;
  sessionId: string;
  /** Memberships of this user in the current tenant. */
  roles: { role: Role; propertyId: string | null }[];
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new HttpError(401, 'Not signed in');
  return req.auth;
}

/** Can this user act on this property with one of these roles? Tenant-wide memberships cover every property. */
export function canAccessProperty(auth: AuthContext, propertyId: string, allowed?: Role[]): boolean {
  return auth.roles.some(
    (r) => (r.propertyId === null || r.propertyId === propertyId) && (!allowed || allowed.includes(r.role)),
  );
}

export function assertProperty(auth: AuthContext, propertyId: string, allowed?: Role[]): void {
  if (!canAccessProperty(auth, propertyId)) throw new HttpError(404, 'Property not found');
  if (allowed && !canAccessProperty(auth, propertyId, allowed)) throw new HttpError(403, 'Not allowed');
}

/** 404 unless the property exists inside the current tenant (RLS hides other tenants' rows). */
export async function assertPropertyExists(db: Db, propertyId: string): Promise<void> {
  const [p] = await db.select({ id: schema.property.id }).from(schema.property).where(eq(schema.property.id, propertyId));
  if (!p) throw new HttpError(404, 'Property not found');
}

export async function buildApp(opts: { pool: pg.Pool; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  app.decorate('pool', opts.pool);
  app.decorateRequest('auth', null);
  await app.register(cookie);

  // Resolve the session cookie into an AuthContext.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const db = globalDb(opts.pool);
    const [s] = await db.select().from(schema.session).where(eq(schema.session.tokenHash, hashToken(token)));
    if (!s || s.expiresAt.getTime() < Date.now()) return;
    const { rows } = await opts.pool.query<{ role: Role; property_id: string | null; tenant_id: string }>(
      'SELECT tenant_id, role, property_id FROM user_memberships($1)',
      [s.userId],
    );
    const roles = rows
      .filter((r) => r.tenant_id === s.tenantId)
      .map((r) => ({ role: r.role, propertyId: r.property_id }));
    if (roles.length === 0) return;
    req.auth = { userId: s.userId, tenantId: s.tenantId, sessionId: s.id, roles };
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Invalid input', issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    const pgCode = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') return reply.status(409).send({ error: 'Already exists' });
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23503') {
      return reply.status(400).send({ error: 'Invalid value' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(propertyRoutes, { prefix: '/properties' });
  await app.register(roomTypeRoutes);
  await app.register(domainRoutes);
  await app.register(publicRoutes, { prefix: '/public' });
  return app;
}
