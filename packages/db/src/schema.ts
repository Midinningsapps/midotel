// Drizzle table definitions mirroring migrations/*.sql (the SQL is the source of truth).
import {
  bigserial,
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  kind: text('kind', { enum: ['independent', 'chain'] }).notNull().default('independent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const property = pgTable('property', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  tagline: text('tagline'),
  description: text('description'),
  propertyType: text('property_type').notNull().default('hotel'),
  starRating: smallint('star_rating'),
  email: text('email'),
  phone: text('phone'),
  addressLine: text('address_line'),
  city: text('city'),
  state: text('state'),
  country: char('country', { length: 2 }).notNull().default('IN'),
  postalCode: text('postal_code'),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  gstin: text('gstin'),
  checkInTime: time('check_in_time').notNull().default('14:00'),
  checkOutTime: time('check_out_time').notNull().default('11:00'),
  status: text('status', { enum: ['draft', 'live', 'archived'] }).notNull().default('draft'),
  amenities: text('amenities').array().notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const membership = pgTable('membership', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role', { enum: ['owner', 'manager', 'front_desk', 'content_editor'] }).notNull(),
  propertyId: uuid('property_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const domain = pgTable('domain', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  hostname: text('hostname').notNull(),
  purpose: text('purpose', { enum: ['website', 'booking'] }).notNull(),
  verifiedAt: ts('verified_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const roomType = pgTable('room_type', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  shortDescription: text('short_description'),
  description: text('description'),
  baseOccupancy: smallint('base_occupancy').notNull().default(2),
  maxAdults: smallint('max_adults').notNull().default(2),
  maxChildren: smallint('max_children').notNull().default(1),
  maxOccupancy: smallint('max_occupancy').notNull().default(3),
  totalUnits: smallint('total_units').notNull().default(1),
  sizeSqft: integer('size_sqft'),
  bedType: text('bed_type'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  imageIds: uuid('image_ids').array().notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const site = pgTable('site', {
  propertyId: uuid('property_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  theme: text('theme').notNull().default('aurora'),
  tokens: jsonb('tokens').$type<Record<string, string>>().notNull().default({}),
  publishedVersion: integer('published_version').notNull().default(0),
  publishedAt: ts('published_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export interface PageMeta {
  title: string;
  slug: string;
  kind: 'home' | 'custom';
  sortOrder: number;
  showInMenu: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
}

export const page = pgTable('page', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  kind: text('kind', { enum: ['home', 'custom'] }).notNull().default('custom'),
  sortOrder: integer('sort_order').notNull().default(0),
  showInMenu: boolean('show_in_menu').notNull().default(true),
  seoTitle: text('seo_title'),
  seoDescription: text('seo_description'),
  draft: jsonb('draft').$type<unknown[]>().notNull().default([]),
  published: jsonb('published').$type<unknown[] | null>(),
  publishedMeta: jsonb('published_meta').$type<PageMeta | null>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const mediaAsset = pgTable('media_asset', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  storageKey: text('storage_key').notNull(),
  alt: text('alt'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  data: jsonb('data'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
