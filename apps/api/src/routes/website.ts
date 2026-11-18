import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { Sections, THEMES, ThemeTokens } from '@midotel/sections';
import { assertProperty, assertPropertyExists, HttpError, requireAuth, type Role } from '../app.ts';
import { audit } from '../audit.ts';
import { makePreviewToken } from '../preview-token.ts';
import { ensureSite } from '../site-data.ts';

const EDITORS: Role[] = ['owner', 'manager', 'content_editor'];
const Slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, numbers and dashes');

const PageUpdate = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  slug: Slug.optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  showInMenu: z.boolean().optional(),
  seoTitle: z.string().trim().max(70).nullable().optional(),
  seoDescription: z.string().trim().max(170).nullable().optional(),
  sections: Sections.optional(),
});

const pageDto = (p: typeof schema.page.$inferSelect) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  kind: p.kind,
  sortOrder: p.sortOrder,
  showInMenu: p.showInMenu,
  seoTitle: p.seoTitle,
  seoDescription: p.seoDescription,
  sections: p.draft,
  isPublished: p.published !== null,
  hasUnpublishedChanges: JSON.stringify(p.draft) !== JSON.stringify(p.published),
  updatedAt: p.updatedAt,
});

export async function websiteRoutes(app: FastifyInstance) {
  const pool = app.pool;

  app.get('/themes', async () => THEMES);

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/site', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const site = await ensureSite(db, auth.tenantId, propertyId);
      const pages = await db.select().from(schema.page).where(eq(schema.page.propertyId, propertyId)).orderBy(asc(schema.page.sortOrder));
      return {
        theme: site!.theme,
        tokens: ThemeTokens.parse(site!.tokens ?? {}),
        publishedVersion: site!.publishedVersion,
        publishedAt: site!.publishedAt,
        pages: pages.map(pageDto),
      };
    });
  });

  app.patch<{ Params: { propertyId: string } }>('/properties/:propertyId/site', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, EDITORS);
    const body = z
      .object({ theme: z.enum(THEMES.map((t) => t.id) as [string, ...string[]]).optional(), tokens: ThemeTokens.optional() })
      .parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      await ensureSite(db, auth.tenantId, propertyId);
      const [s] = await db.update(schema.site).set(body).where(eq(schema.site.propertyId, propertyId)).returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'site', entityId: propertyId, data: body });
      return { theme: s!.theme, tokens: ThemeTokens.parse(s!.tokens) };
    });
  });

  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/pages', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, EDITORS);
    const body = z.object({ title: z.string().trim().min(1).max(80), slug: Slug }).parse(req.body);
    const created = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      await ensureSite(db, auth.tenantId, propertyId);
      const [p] = await db
        .insert(schema.page)
        .values({ tenantId: auth.tenantId, propertyId, title: body.title, slug: body.slug, sortOrder: 100, draft: [] })
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'page', entityId: p!.id });
      return p!;
    });
    return reply.status(201).send(pageDto(created));
  });

  app.get<{ Params: { id: string } }>('/pages/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [p] = await db.select().from(schema.page).where(eq(schema.page.id, id));
      if (!p) throw new HttpError(404, 'Page not found');
      assertProperty(auth, p.propertyId);
      return pageDto(p);
    });
  });

  app.patch<{ Params: { id: string } }>('/pages/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const body = PageUpdate.parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [current] = await db.select().from(schema.page).where(eq(schema.page.id, id));
      if (!current) throw new HttpError(404, 'Page not found');
      assertProperty(auth, current.propertyId, EDITORS);
      if (current.kind === 'home' && body.slug && body.slug !== current.slug) throw new HttpError(400, 'The home page address cannot change');
      const ids = body.sections?.map((s) => s.id) ?? [];
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Section ids must be unique');
      const { sections, ...meta } = body;
      const [p] = await db
        .update(schema.page)
        .set({ ...meta, ...(sections && { draft: sections }) })
        .where(eq(schema.page.id, id))
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'page', entityId: id });
      return pageDto(p!);
    });
  });

  app.delete<{ Params: { id: string } }>('/pages/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    await withTenant(pool, auth.tenantId, async (db) => {
      const [current] = await db.select().from(schema.page).where(eq(schema.page.id, id));
      if (!current) throw new HttpError(404, 'Page not found');
      assertProperty(auth, current.propertyId, EDITORS);
      if (current.kind === 'home') throw new HttpError(400, 'The home page cannot be deleted');
      await db.delete(schema.page).where(eq(schema.page.id, id));
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'delete', entity: 'page', entityId: id, data: { slug: current.slug } });
    });
    return reply.status(204).send();
  });

  // Publish: every page's draft becomes live in one transaction; deleted pages disappear with it.
  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/publish', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, EDITORS);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const site = await ensureSite(db, auth.tenantId, propertyId);
      const pages = await db.select().from(schema.page).where(eq(schema.page.propertyId, propertyId));
      for (const p of pages) {
        await db
          .update(schema.page)
          .set({
            published: p.draft,
            publishedMeta: {
              title: p.title,
              slug: p.slug,
              kind: p.kind,
              sortOrder: p.sortOrder,
              showInMenu: p.showInMenu,
              seoTitle: p.seoTitle,
              seoDescription: p.seoDescription,
            },
          })
          .where(eq(schema.page.id, p.id));
      }
      const version = site!.publishedVersion + 1;
      const publishedAt = new Date();
      await db.update(schema.site).set({ publishedVersion: version, publishedAt }).where(eq(schema.site.propertyId, propertyId));
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'publish', entity: 'site', entityId: propertyId, data: { version } });
      return { version, publishedAt, pages: pages.length };
    });
  });

  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/preview-token', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return { token: makePreviewToken(auth.tenantId, propertyId) };
  });
}
