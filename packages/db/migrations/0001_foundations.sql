-- Phase 0: tenants, properties, users, memberships, sessions, domains, room types, audit log.
-- Every tenant-owned table: tenant_id + RLS forced + tenant_isolation policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'midotel_app') THEN
    CREATE ROLE midotel_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- Tenants -----------------------------------------------------------------
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind        text NOT NULL DEFAULT 'independent' CHECK (kind IN ('independent', 'chain')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant
  USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());
CREATE TRIGGER tenant_touch BEFORE UPDATE ON tenant FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Properties (one hotel each) ----------------------------------------------
CREATE TABLE property (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name            text NOT NULL,
  slug            text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  tagline         text,
  description     text,
  property_type   text NOT NULL DEFAULT 'hotel'
                  CHECK (property_type IN ('hotel', 'resort', 'homestay', 'villa', 'camp', 'hostel', 'apartment')),
  star_rating     smallint CHECK (star_rating BETWEEN 1 AND 7),
  email           text,
  phone           text,
  address_line    text,
  city            text,
  state           text,
  country         char(2) NOT NULL DEFAULT 'IN',
  postal_code     text,
  latitude        numeric(9, 6),
  longitude       numeric(9, 6),
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  currency        char(3) NOT NULL DEFAULT 'INR',
  gstin           text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  check_in_time   time NOT NULL DEFAULT '14:00',
  check_out_time  time NOT NULL DEFAULT '11:00',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX property_tenant_idx ON property (tenant_id);
ALTER TABLE property ENABLE ROW LEVEL SECURITY;
ALTER TABLE property FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON property
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER property_touch BEFORE UPDATE ON property FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Users are global (one login can belong to several tenants) ----------------
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_idx ON app_user (lower(email));

CREATE TABLE membership (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'manager', 'front_desk', 'content_editor')),
  property_id  uuid REFERENCES property(id) ON DELETE CASCADE, -- NULL = all properties of the tenant
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX membership_unique_idx
  ON membership (tenant_id, user_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_user_idx ON session (user_id);

-- Hostnames that route to a property (www.hotel.com, book.hotel.com) --------
CREATE TABLE domain (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  hostname     text NOT NULL CHECK (hostname = lower(hostname)),
  purpose      text NOT NULL CHECK (purpose IN ('website', 'booking')),
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX domain_hostname_idx ON domain (hostname);
ALTER TABLE domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON domain
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Room types (shared by the CMS and the booking engine) ---------------------
CREATE TABLE room_type (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id     uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  short_description text,
  description     text,
  base_occupancy  smallint NOT NULL DEFAULT 2 CHECK (base_occupancy >= 1),
  max_adults      smallint NOT NULL DEFAULT 2 CHECK (max_adults >= 1),
  max_children    smallint NOT NULL DEFAULT 1 CHECK (max_children >= 0),
  max_occupancy   smallint NOT NULL DEFAULT 3 CHECK (max_occupancy >= 1),
  total_units     smallint NOT NULL DEFAULT 1 CHECK (total_units >= 0),
  size_sqft       integer CHECK (size_sqft > 0),
  bed_type        text,
  sort_order      integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  CHECK (max_occupancy <= max_adults + max_children),
  CHECK (base_occupancy <= max_occupancy)
);
CREATE INDEX room_type_property_idx ON room_type (property_id, sort_order);
ALTER TABLE room_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_type FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_type
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER room_type_touch BEFORE UPDATE ON room_type FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Audit log --------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Cross-tenant lookups, only through these definer functions ------------------
CREATE OR REPLACE FUNCTION user_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, role text, property_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, t.name, t.slug, m.role, m.property_id
  FROM membership m JOIN tenant t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
  ORDER BY t.name
$$;

CREATE OR REPLACE FUNCTION resolve_hostname(p_hostname text)
RETURNS TABLE (tenant_id uuid, property_id uuid, purpose text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.tenant_id, d.property_id, d.purpose FROM domain d WHERE d.hostname = lower(p_hostname)
$$;

CREATE OR REPLACE FUNCTION tenant_slug_taken(p_slug text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tenant WHERE slug = p_slug)
$$;

REVOKE ALL ON FUNCTION user_memberships(uuid), resolve_hostname(text), tenant_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_memberships(uuid), resolve_hostname(text), tenant_slug_taken(text) TO midotel_app;

GRANT USAGE ON SCHEMA public TO midotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant, property, app_user, membership, session, domain, room_type TO midotel_app;
GRANT SELECT, INSERT ON audit_log TO midotel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO midotel_app;
