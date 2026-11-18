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
- `npm run dev` (API on :4000, admin on :3000, hotel sites on :3001)
- `npm test` (starts its own throwaway Postgres)
- `npm run typecheck`

## Website builder
- Pages hold `draft` and `published` JSON arrays of sections. Publish copies draft to published for every page in one transaction.
- Media: uploads are sniffed by magic bytes (never trust the declared type), stored via `Storage` (local disk now, S3 later), served at `/media/<tenantId>/<id>`.
- Preview links use short-lived HMAC tokens (`PREVIEW_SECRET`).

## Conventions
- TypeScript strict. Validate request bodies with zod. Money as integer minor units (paise) when pricing arrives.
- Migrations are append-only: never edit an applied migration; add `NNNN_name.sql`.
- Every change ships with tests; booking, pricing and inventory code needs tests for edge cases.
- Write audit_log rows for changes to properties, rooms, rates and bookings.
