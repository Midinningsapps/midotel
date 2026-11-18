// Drizzle table definitions mirroring migrations/*.sql (the SQL is the source of truth).
import {
  bigserial,
  boolean,
  char,
  date,
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
  notificationEmails: text('notification_emails').array().notNull().default([]),
  taxSlabs: jsonb('tax_slabs')
    .$type<{ upTo: number | null; rate: number }[]>()
    .notNull()
    .default([
      { upTo: 750000, rate: 5 },
      { upTo: null, rate: 18 },
    ]),
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

export interface CancellationRule {
  daysBefore: number;
  penaltyType: 'percent' | 'nights';
  value: number;
}

export const cancellationPolicy = pgTable('cancellation_policy', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  rules: jsonb('rules').$type<CancellationRule[]>().notNull().default([]),
  isNonRefundable: boolean('is_non_refundable').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const ratePlan = pgTable('rate_plan', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  description: text('description'),
  mealPlan: text('meal_plan', { enum: ['EP', 'CP', 'MAP', 'AP'] }).notNull().default('EP'),
  cancellationPolicyId: uuid('cancellation_policy_id'),
  parentId: uuid('parent_id'),
  deriveKind: text('derive_kind', { enum: ['percent', 'amount'] }),
  deriveValue: integer('derive_value'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const roomRate = pgTable('room_rate', {
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  ratePlanId: uuid('rate_plan_id').notNull(),
  date: date('date', { mode: 'string' }).notNull(),
  price: integer('price').notNull(),
  extraAdult: integer('extra_adult').notNull().default(0),
  extraChild: integer('extra_child').notNull().default(0),
});

export const inventoryDay = pgTable('inventory_day', {
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  date: date('date', { mode: 'string' }).notNull(),
  total: smallint('total').notNull(),
  sold: smallint('sold').notNull().default(0),
  held: smallint('held').notNull().default(0),
  closed: boolean('closed').notNull().default(false),
  closedToArrival: boolean('closed_to_arrival').notNull().default(false),
  closedToDeparture: boolean('closed_to_departure').notNull().default(false),
  minStay: smallint('min_stay'),
  maxStay: smallint('max_stay'),
});

export interface NightPrice {
  date: string;
  price: number;
  tax: number;
}

export const booking = pgTable('booking', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  reference: text('reference').notNull(),
  status: text('status', { enum: ['pending_payment', 'confirmed', 'cancelled', 'expired'] }).notNull(),
  source: text('source', { enum: ['website', 'desk', 'channel'] }).notNull().default('website'),
  checkIn: date('check_in', { mode: 'string' }).notNull(),
  checkOut: date('check_out', { mode: 'string' }).notNull(),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  guestPhone: text('guest_phone').notNull(),
  guestGstin: text('guest_gstin'),
  specialRequests: text('special_requests'),
  adults: smallint('adults').notNull(),
  children: smallint('children').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  subtotal: integer('subtotal').notNull(),
  tax: integer('tax').notNull(),
  total: integer('total').notNull(),
  paid: integer('paid').notNull().default(0),
  paymentMode: text('payment_mode', { enum: ['pay_now', 'pay_at_hotel'] }).notNull(),
  cancellationPolicy: jsonb('cancellation_policy').$type<{ name: string; rules: CancellationRule[]; isNonRefundable: boolean } | null>(),
  holdExpiresAt: ts('hold_expires_at'),
  manageTokenHash: text('manage_token_hash').notNull(),
  whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
  cancelPenalty: integer('cancel_penalty'),
  cancelledAt: ts('cancelled_at'),
  confirmedAt: ts('confirmed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const bookingRoom = pgTable('booking_room', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  bookingId: uuid('booking_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  ratePlanId: uuid('rate_plan_id').notNull(),
  roomName: text('room_name').notNull(),
  ratePlanName: text('rate_plan_name').notNull(),
  adults: smallint('adults').notNull(),
  children: smallint('children').notNull(),
  nights: jsonb('nights').$type<NightPrice[]>().notNull(),
  subtotal: integer('subtotal').notNull(),
  tax: integer('tax').notNull(),
});

export const gatewayAccount = pgTable('gateway_account', {
  propertyId: uuid('property_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  provider: text('provider', { enum: ['razorpay', 'demo'] }).notNull(),
  keyId: text('key_id'),
  keySecretEnc: text('key_secret_enc'),
  webhookSecretEnc: text('webhook_secret_enc'),
  payAtHotel: boolean('pay_at_hotel').notNull().default(true),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const payment = pgTable('payment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  bookingId: uuid('booking_id').notNull(),
  provider: text('provider').notNull(),
  kind: text('kind', { enum: ['charge', 'refund'] }).notNull().default('charge'),
  providerOrderId: text('provider_order_id'),
  providerPaymentId: text('provider_payment_id'),
  amount: integer('amount').notNull(),
  status: text('status', { enum: ['created', 'captured', 'failed', 'refunded', 'pending'] }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export interface WhatsAppPayload {
  template: string;
  language: string;
  params: string[];
}

export const messageOutbox = pgTable('message_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  bookingId: uuid('booking_id'),
  channel: text('channel', { enum: ['email', 'whatsapp'] }).notNull().default('email'),
  template: text('template').notNull(),
  recipient: text('recipient').notNull(),
  replyTo: text('reply_to'),
  fromName: text('from_name').notNull(),
  subject: text('subject').notNull(),
  bodyHtml: text('body_html').notNull(),
  bodyText: text('body_text').notNull(),
  status: text('status', { enum: ['pending', 'sending', 'sent', 'failed'] }).notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
  sendAfter: ts('send_after').notNull().defaultNow(),
  sentAt: ts('sent_at'),
  providerMessageId: text('provider_message_id'),
  payload: jsonb('payload').$type<WhatsAppPayload | null>(),
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
