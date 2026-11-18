import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { globalDb, schema, withTenant } from '@midotel/db';
import { HttpError, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { hashPassword, hashToken, newSessionToken, SESSION_COOKIE, SESSION_TTL_MS, verifyPassword } from '../auth.ts';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'hotel';

const SignupBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200),
  password: z.string().min(10).max(200),
  companyName: z.string().trim().min(1).max(120),
  propertyName: z.string().trim().min(1).max(120),
  kind: z.enum(['independent', 'chain']).default('independent'),
});

const LoginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
  tenantId: z.uuid().optional(),
});

export async function authRoutes(app: FastifyInstance) {
  const pool = app.pool;

  async function startSession(reply: FastifyReply, userId: string, tenantId: string) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await globalDb(pool).insert(schema.session).values({ tokenHash: hashToken(token), userId, tenantId, expiresAt });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      expires: expiresAt,
    });
  }

  async function memberships(userId: string) {
    const { rows } = await pool.query<{
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
      role: string;
      property_id: string | null;
    }>('SELECT * FROM user_memberships($1)', [userId]);
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      tenantSlug: r.tenant_slug,
      role: r.role,
      propertyId: r.property_id,
    }));
  }

  // Creates a user, their company (tenant) and first property in one transaction.
  app.post('/signup', async (req, reply) => {
    const body = SignupBody.parse(req.body);
    const db = globalDb(pool);
    const [existing] = await db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(sql`lower(${schema.appUser.email}) = lower(${body.email})`);
    if (existing) throw new HttpError(409, 'An account with this email already exists');

    let tenantSlug = slugify(body.companyName);
    const { rows } = await pool.query<{ taken: boolean }>('SELECT tenant_slug_taken($1) AS taken', [tenantSlug]);
    if (rows[0]?.taken) tenantSlug = `${tenantSlug}-${randomUUID().slice(0, 6)}`;

    const tenantId = randomUUID();
    const passwordHash = await hashPassword(body.password);
    const result = await withTenant(pool, tenantId, async (tx) => {
      const [user] = await tx
        .insert(schema.appUser)
        .values({ email: body.email, name: body.name, passwordHash })
        .returning({ id: schema.appUser.id });
      await tx.insert(schema.tenant).values({ id: tenantId, name: body.companyName, slug: tenantSlug, kind: body.kind });
      await tx.insert(schema.membership).values({ tenantId, userId: user!.id, role: 'owner' });
      const [property] = await tx
        .insert(schema.property)
        .values({ tenantId, name: body.propertyName, slug: slugify(body.propertyName) })
        .returning({ id: schema.property.id });
      await audit(tx, { tenantId, userId: user!.id, action: 'signup', entity: 'tenant', entityId: tenantId });
      return { userId: user!.id, propertyId: property!.id };
    });
    await startSession(reply, result.userId, tenantId);
    return reply.status(201).send({ userId: result.userId, tenantId, propertyId: result.propertyId });
  });

  app.post('/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const [user] = await globalDb(pool)
      .select()
      .from(schema.appUser)
      .where(sql`lower(${schema.appUser.email}) = lower(${body.email})`);
    // Same message either way so the endpoint does not reveal which emails exist.
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new HttpError(401, 'Wrong email or password');
    }
    const ms = await memberships(user.id);
    const chosen = body.tenantId ? ms.find((m) => m.tenantId === body.tenantId) : ms[0];
    if (!chosen) throw new HttpError(403, 'No access to this account');
    await startSession(reply, user.id, chosen.tenantId);
    return { userId: user.id, tenantId: chosen.tenantId };
  });

  app.post('/logout', async (req, reply) => {
    if (req.auth) await globalDb(pool).delete(schema.session).where(eq(schema.session.id, req.auth.sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const auth = requireAuth(req);
    const [user] = await globalDb(pool)
      .select({ id: schema.appUser.id, email: schema.appUser.email, name: schema.appUser.name })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, auth.userId));
    const ms = await memberships(auth.userId);
    const current = ms.find((m) => m.tenantId === auth.tenantId);
    return {
      user,
      tenant: current ? { id: current.tenantId, name: current.tenantName, slug: current.tenantSlug } : null,
      roles: auth.roles,
      tenants: [...new Map(ms.map((m) => [m.tenantId, { id: m.tenantId, name: m.tenantName }])).values()],
    };
  });

  app.post('/switch-tenant', async (req) => {
    const auth = requireAuth(req);
    const { tenantId } = z.object({ tenantId: z.uuid() }).parse(req.body);
    const ms = await memberships(auth.userId);
    if (!ms.some((m) => m.tenantId === tenantId)) throw new HttpError(403, 'No access to this account');
    await globalDb(pool).update(schema.session).set({ tenantId }).where(eq(schema.session.id, auth.sessionId));
    return { tenantId };
  });
}
