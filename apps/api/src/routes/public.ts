import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '@midotel/db';
import { HttpError } from '../app.ts';
import { readPreviewToken } from '../preview-token.ts';
import { buildSiteData } from '../site-data.ts';

// Unauthenticated endpoints used by hotel websites and the booking engine.
export async function publicRoutes(app: FastifyInstance) {
  const pool = app.pool;

  // Published site for a hostname (www.hotel.com).
  app.get('/site', async (req, reply) => {
    const { host } = z.object({ host: z.string().min(1).max(253) }).parse(req.query);
    const { rows } = await pool.query<{ tenant_id: string; property_id: string; purpose: string }>(
      'SELECT * FROM resolve_hostname($1)',
      [host.toLowerCase().split(':')[0]],
    );
    const hit = rows[0];
    if (!hit) throw new HttpError(404, 'Unknown site');
    const data = await withTenant(pool, hit.tenant_id, (db) => buildSiteData(db, hit.tenant_id, hit.property_id, 'published'));
    if (!data) throw new HttpError(404, 'This site has not been published yet');
    reply.header('cache-control', 'public, max-age=30');
    return { purpose: hit.purpose, ...data };
  });

  // Draft site for the admin preview, authorised by a short-lived signed token.
  app.get('/preview', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(1000) }).parse(req.query);
    const t = readPreviewToken(token);
    if (!t) throw new HttpError(401, 'Preview link expired. Open the preview again from the admin.');
    const data = await withTenant(pool, t.tenantId, (db) => buildSiteData(db, t.tenantId, t.propertyId, 'draft'));
    if (!data) throw new HttpError(404, 'Unknown site');
    reply.header('cache-control', 'no-store');
    return { purpose: 'website', ...data };
  });

  // Asked by the HTTPS proxy before it requests a certificate for a hotel's domain, so only known domains get one.
  app.get('/domain-check', async (req, reply) => {
    const { domain } = z.object({ domain: z.string().min(1).max(253) }).parse(req.query);
    const { rows } = await pool.query('SELECT 1 FROM resolve_hostname($1)', [domain.toLowerCase()]);
    return rows.length ? { ok: true } : reply.status(404).send({ ok: false });
  });
}
