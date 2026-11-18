# Midotel

Multi-tenant SaaS for hotels: CMS-driven hotel websites, a direct booking engine, a reservation desk, and two-way sync with channel managers (eZee, STAAH first). India-first.

Architecture doc (source of truth for design decisions): https://claude.ai/artifact/Mvm3WgSaofuLueTXfByWz1

## Decisions that shape the code
- India-first: INR default, GST tax slabs, Razorpay / PayU / CCAvenue, data in AWS Mumbai.
- Customers are independent hotels and chains: tenant -> many properties; roles per tenant or per property.
- Guest payments go ONLY to the hotel's own gateway account. We never hold guest money; our commission is invoiced.
- Channel managers: integrate (eZee, STAAH), do not build our own yet.
- Hotel websites are published as static pages to a CDN; the booking engine is a live app on `book.<hotel-domain>`.
- Never copy Simplotel's code, templates, copy, images or branding. Research is for understanding features only.

## Layout (npm workspaces)
- `packages/db` - SQL migrations (`migrations/*.sql`), Drizzle table definitions (`src/schema.ts`), `withTenant()` helper.
- `apps/api` - Fastify API. Routes in `src/routes/`. Tests in `test/` (Vitest + embedded Postgres).
- `packages/sections` - page section schemas (zod), starter pages and theme tokens; shared by API, admin and site.
- `apps/admin` - Next.js admin app. Calls the API through the `/api/*` rewrite in `next.config.ts`.
- `apps/site` - Next.js hotel website renderer (port 3001). `/s/<hostname>/...` = published site, `/preview/...?token=` = draft. Themes in `themes/` (first theme: Aurora, original design).
- `apps/booking` - Next.js guest booking engine (port 3002): search, rooms and rates, guest details, payment, manage booking.
- `scripts/dev-db.ts` - starts a local embedded Postgres on port 5433 (data in `.data/pg`).

## Tenant isolation (do not weaken)
- Every business table has `tenant_id` and row-level security (`FORCE ROW LEVEL SECURITY`).
- The API connects as `midotel_app` (not superuser, no BYPASSRLS). Migrations run as `postgres`.
- All tenant data access goes through `withTenant(pool, tenantId, fn)`, which sets `app.tenant_id` for the transaction.
- Cross-tenant lookups (login memberships, hostname routing) use the SECURITY DEFINER functions in the migrations only.
- New tables: add `tenant_id`, enable + force RLS, add the `tenant_isolation` policy, grant to `midotel_app`, and add an isolation test.

## Commands
- `npm install`
- `npm run db:start` (keep running in its own terminal; first run creates the database and roles)
- `npm run db:migrate`
- `npm run dev` (API on :4000, admin on :3000, hotel sites on :3001, booking engine on :3002)
- `npm test` (starts its own throwaway Postgres)
- `npm run typecheck`

## Website builder
- Pages hold `draft` and `published` JSON arrays of sections. Publish copies draft to published for every page in one transaction.
- Media: uploads are sniffed by magic bytes (never trust the declared type), stored via `Storage` (local disk now, S3 later), served at `/media/<tenantId>/<id>`.
- Preview links use short-lived HMAC tokens (`PREVIEW_SECRET`).

## Booking engine
- Pricing rules live in `apps/api/src/booking/pricing.ts` (pure functions, unit-tested). Money is integer paise.
- GST per room-night by slab (`property.tax_slabs`, default 5% up to Rs 7,500, 18% above). Confirm current rates with a CA before going live.
- Inventory: `inventory_day` rows (missing row = all units open). Bookings take units with a guarded UPDATE so the last room cannot be sold twice.
- Pay now = 15-minute hold (`held`), confirmed by a verified gateway signature; `expire_booking_holds()` releases unpaid holds (API runs it every minute).
- Payments go to the hotel's own gateway (`gateway_account`, secrets AES-GCM encrypted with `SECRETS_KEY`). `demo` provider simulates payments for demos.
- Guests manage bookings with reference + secret token (only its hash is stored).

## Notifications
- Booking emails are written to `message_outbox` in the same transaction as the booking change (never lost, never sent for a rolled-back booking).
- The API delivers due messages every 5 s via `claim_outbox_messages` / `settle_outbox_message` (SKIP LOCKED, retries 1/2/4/8 min, then `failed`; staff can retry).
- Sender: Postmark when `POSTMARK_TOKEN` + `MAIL_FROM` are set, otherwise HTML files in `.data/mail`.
- Templates in `apps/api/src/notify/templates.ts`; every guest-typed value is HTML-escaped.
- WhatsApp: only for guests who opted in (`booking.whatsapp_opt_in`), via Meta Cloud API templates (`docs/whatsapp-templates.md`, wording must match `notify/whatsapp.ts`); locally saved to `.data/whatsapp`.

## Channel manager
- See `docs/channel-manager.md`. Code in `apps/api/src/channel/` (types, OTA XML drafts, adapters, sync); routes in `routes/channels.ts`.
- Rate/inventory edits call `queueAri`; booking confirm/cancel calls `queueBookingPush`. Delivery runs every 5 s.
- eZee and STAAH adapters are drafts (`certified: false`) until their specs are implemented and certified.
- Known gap: expired pay-now holds do not trigger an availability push (next rate change or full sync corrects it).
- zod: never call `.partial()` on a schema with `.default()` for PATCH bodies; defaults would overwrite stored values.

## Deployment (demo)
- `deploy/`: one Dockerfile for the monorepo, `docker-compose.yml` (Postgres, migrate, api, admin, site, booking, Caddy), `Caddyfile`.
- Caddy issues certificates for platform hosts and, on demand, for hotel domains approved by `GET /public/domain-check`.
- `apps/site/proxy.ts` rewrites hotel hosts to `/s/<host>`; platform hosts listed in `SITE_PLATFORM_HOSTS`.
- Guide for the owner: `docs/deploy-demo.md`. Docker is not installed on the dev Mac, so the image has not been built locally.

## Conventions
- TypeScript strict. Validate request bodies with zod. Money as integer minor units (paise) when pricing arrives.
- Migrations are append-only: never edit an applied migration; add `NNNN_name.sql`.
- Every change ships with tests; booking, pricing and inventory code needs tests for edge cases.
- Write audit_log rows for changes to properties, rooms, rates and bookings.
