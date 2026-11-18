// Builds everything the site renderer needs for one property, from drafts (preview) or published content.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@midotel/db';
import { imageIdsIn, Sections, starterPages, ThemeTokens, type Section } from '@midotel/sections';

export const publicApiUrl = () => process.env.PUBLIC_API_URL ?? 'http://localhost:4000';
export const mediaUrl = (tenantId: string, mediaId: string) => `${publicApiUrl()}/media/${tenantId}/${mediaId}`;

/** Create the site row and starter pages the first time a property's website is opened. */
export async function ensureSite(db: Db, tenantId: string, propertyId: string) {
  const [existing] = await db.select().from(schema.site).where(eq(schema.site.propertyId, propertyId));
  if (existing) return existing;
  const [prop] = await db.select({ name: schema.property.name }).from(schema.property).where(eq(schema.property.id, propertyId));
  if (!prop) return null;
  const [created] = await db.insert(schema.site).values({ tenantId, propertyId }).onConflictDoNothing().returning();
  if (!created) {
    const [again] = await db.select().from(schema.site).where(eq(schema.site.propertyId, propertyId));
    return again ?? null;
  }
  const pages = starterPages(prop.name, () => randomUUID().slice(0, 8));
  await db.insert(schema.page).values(
    pages.map((p) => ({
      tenantId,
      propertyId,
      slug: p.slug,
      title: p.title,
      kind: p.kind,
      sortOrder: p.sortOrder,
      draft: p.sections,
    })),
  );
  return created;
}

export async function buildSiteData(db: Db, tenantId: string, propertyId: string, mode: 'draft' | 'published') {
  const [property] = await db.select().from(schema.property).where(eq(schema.property.id, propertyId));
  if (!property) return null;
  const site = mode === 'draft' ? await ensureSite(db, tenantId, propertyId) : (await db.select().from(schema.site).where(eq(schema.site.propertyId, propertyId)))[0];
  if (!site || (mode === 'published' && site.publishedVersion === 0)) return null;

  const pageRows = await db.select().from(schema.page).where(eq(schema.page.propertyId, propertyId)).orderBy(asc(schema.page.sortOrder));
  const pages = pageRows
    .map((p) => {
      const meta =
        mode === 'draft'
          ? { title: p.title, slug: p.slug, kind: p.kind, sortOrder: p.sortOrder, showInMenu: p.showInMenu, seoTitle: p.seoTitle, seoDescription: p.seoDescription }
          : p.publishedMeta;
      const raw = mode === 'draft' ? p.draft : p.published;
      if (!meta || !raw) return null;
      const parsed = Sections.safeParse(raw);
      return { ...meta, sections: parsed.success ? parsed.data : ([] as Section[]) };
    })
    .filter((p) => p !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const rooms = await db
    .select()
    .from(schema.roomType)
    .where(and(eq(schema.roomType.propertyId, propertyId), eq(schema.roomType.isActive, true)))
    .orderBy(asc(schema.roomType.sortOrder), asc(schema.roomType.name));

  // Resolve every referenced image to a URL in one query.
  const wanted = new Set<string>([...pages.flatMap((p) => imageIdsIn(p.sections)), ...rooms.flatMap((r) => r.imageIds)]);
  const media = wanted.size
    ? await db
        .select({ id: schema.mediaAsset.id, alt: schema.mediaAsset.alt })
        .from(schema.mediaAsset)
        .where(and(eq(schema.mediaAsset.propertyId, propertyId), inArray(schema.mediaAsset.id, [...wanted])))
    : [];
  const images = Object.fromEntries(media.map((m) => [m.id, { url: mediaUrl(tenantId, m.id), alt: m.alt ?? '' }]));

  return {
    mode,
    version: site.publishedVersion,
    theme: site.theme,
    tokens: ThemeTokens.parse(site.tokens ?? {}),
    property: {
      id: property.id,
      name: property.name,
      tagline: property.tagline,
      description: property.description,
      email: property.email,
      phone: property.phone,
      address: [property.addressLine, property.city, property.state, property.postalCode].filter(Boolean).join(', '),
      city: property.city,
      latitude: property.latitude === null ? null : Number(property.latitude),
      longitude: property.longitude === null ? null : Number(property.longitude),
      currency: property.currency,
      checkInTime: property.checkInTime.slice(0, 5),
      checkOutTime: property.checkOutTime.slice(0, 5),
      starRating: property.starRating,
      amenities: property.amenities,
    },
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      shortDescription: r.shortDescription,
      description: r.description,
      maxAdults: r.maxAdults,
      maxChildren: r.maxChildren,
      maxOccupancy: r.maxOccupancy,
      sizeSqft: r.sizeSqft,
      bedType: r.bedType,
      imageIds: r.imageIds.filter((i) => images[i]),
    })),
    pages,
    images,
  };
}

export type SiteData = NonNullable<Awaited<ReturnType<typeof buildSiteData>>>;
