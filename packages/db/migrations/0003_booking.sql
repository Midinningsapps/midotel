-- Phase 2: rates, inventory, restrictions, bookings, payments.
-- Money is stored as integer paise (minor units). Dates are hotel-local calendar dates.

CREATE TABLE cancellation_policy (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  -- [{ "daysBefore": 3, "penaltyType": "percent"|"nights", "value": 100 }]: within N days of check-in, charge this.
  rules        jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_non_refundable boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_plan (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id             uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  code                    text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  description             text,
  meal_plan               text NOT NULL DEFAULT 'EP' CHECK (meal_plan IN ('EP', 'CP', 'MAP', 'AP')),
  cancellation_policy_id  uuid REFERENCES cancellation_policy(id) ON DELETE SET NULL,
  -- A derived plan prices itself from its parent: percent (e.g. -10) or amount in paise per night (e.g. 80000).
  parent_id               uuid REFERENCES rate_plan(id) ON DELETE CASCADE,
  derive_kind             text CHECK (derive_kind IN ('percent', 'amount')),
  derive_value            integer,
  is_active               boolean NOT NULL DEFAULT true,
  sort_order              integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  CHECK ((parent_id IS NULL) = (derive_kind IS NULL) AND (derive_kind IS NULL) = (derive_value IS NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE TRIGGER rate_plan_touch BEFORE UPDATE ON rate_plan FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Prices for base plans, per room type and night.
CREATE TABLE room_rate (
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id        uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  room_type_id       uuid NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  rate_plan_id       uuid NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
  date               date NOT NULL,
  price              integer NOT NULL CHECK (price >= 0),          -- for the room's base occupancy
  extra_adult        integer NOT NULL DEFAULT 0 CHECK (extra_adult >= 0),
  extra_child        integer NOT NULL DEFAULT 0 CHECK (extra_child >= 0),
  PRIMARY KEY (room_type_id, rate_plan_id, date)
);
CREATE INDEX room_rate_property_date_idx ON room_rate (property_id, date);

-- Inventory and restrictions per room type and night. A missing row means: all units open, no restrictions.
CREATE TABLE inventory_day (
  tenant_id            uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  room_type_id         uuid NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  date                 date NOT NULL,
  total                smallint NOT NULL CHECK (total >= 0),
  sold                 smallint NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held                 smallint NOT NULL DEFAULT 0 CHECK (held >= 0),
  closed               boolean NOT NULL DEFAULT false,
  closed_to_arrival    boolean NOT NULL DEFAULT false,
  closed_to_departure  boolean NOT NULL DEFAULT false,
  min_stay             smallint CHECK (min_stay >= 1),
  max_stay             smallint CHECK (max_stay >= 1),
  -- No CHECK on sold + held <= total: a hotel may lower total below sold. Our booking path enforces availability.
  PRIMARY KEY (room_type_id, date)
);
CREATE INDEX inventory_day_property_date_idx ON inventory_day (property_id, date);

CREATE TABLE booking (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  reference            text NOT NULL UNIQUE,
  status               text NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'expired')),
  source               text NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'desk', 'channel')),
  check_in             date NOT NULL,
  check_out            date NOT NULL,
  guest_name           text NOT NULL,
  guest_email          text NOT NULL,
  guest_phone          text NOT NULL,
  guest_gstin          text,
  special_requests     text,
  adults               smallint NOT NULL,
  children             smallint NOT NULL,
  currency             char(3) NOT NULL,
  subtotal             integer NOT NULL,
  tax                  integer NOT NULL,
  total                integer NOT NULL,
  paid                 integer NOT NULL DEFAULT 0,
  payment_mode         text NOT NULL CHECK (payment_mode IN ('pay_now', 'pay_at_hotel')),
  cancellation_policy  jsonb,          -- snapshot at booking time
  hold_expires_at      timestamptz,
  manage_token_hash    text NOT NULL,
  cancel_penalty       integer,
  cancelled_at         timestamptz,
  confirmed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE INDEX booking_property_idx ON booking (property_id, created_at DESC);
CREATE INDEX booking_hold_idx ON booking (hold_expires_at) WHERE status = 'pending_payment';
CREATE TRIGGER booking_touch BEFORE UPDATE ON booking FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE booking_room (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id     uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  room_type_id   uuid NOT NULL REFERENCES room_type(id) ON DELETE RESTRICT,
  rate_plan_id   uuid NOT NULL REFERENCES rate_plan(id) ON DELETE RESTRICT,
  room_name      text NOT NULL,
  rate_plan_name text NOT NULL,
  adults         smallint NOT NULL,
  children       smallint NOT NULL,
  nights         jsonb NOT NULL,       -- [{ "date": "2026-12-01", "price": 450000, "tax": 22500 }]
  subtotal       integer NOT NULL,
  tax            integer NOT NULL
);
CREATE INDEX booking_room_booking_idx ON booking_room (booking_id);

-- The hotel's own payment gateway account (we never hold guest money).
CREATE TABLE gateway_account (
  property_id        uuid PRIMARY KEY REFERENCES property(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('razorpay', 'demo')),
  key_id             text,
  key_secret_enc     text,       -- AES-GCM, see apps/api/src/crypto.ts
  webhook_secret_enc text,
  pay_at_hotel       boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gateway_account_touch BEFORE UPDATE ON gateway_account FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE payment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id           uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  provider             text NOT NULL,
  kind                 text NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge', 'refund')),
  provider_order_id    text,
  provider_payment_id  text,
  amount               integer NOT NULL CHECK (amount > 0),
  status               text NOT NULL CHECK (status IN ('created', 'captured', 'failed', 'refunded', 'pending')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_provider_payment_idx ON payment (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payment_booking_idx ON payment (booking_id);
CREATE TRIGGER payment_touch BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- GST slabs per property, editable later; default is India hotel accommodation GST.
ALTER TABLE property ADD COLUMN tax_slabs jsonb NOT NULL DEFAULT
  '[{"upTo": 750000, "rate": 5}, {"upTo": null, "rate": 18}]'::jsonb;

-- RLS on every new table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cancellation_policy', 'rate_plan', 'room_rate', 'inventory_day', 'booking', 'booking_room', 'gateway_account', 'payment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO midotel_app', t);
  END LOOP;
END $$;

-- Public lookups (booking engine) that must find the tenant before RLS applies.
CREATE OR REPLACE FUNCTION property_tenant(p_property_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM property WHERE id = p_property_id AND status <> 'archived'
$$;

CREATE OR REPLACE FUNCTION booking_tenant(p_reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM booking WHERE reference = upper(p_reference)
$$;

-- Releases inventory held by unpaid bookings whose hold has expired, across all tenants.
CREATE OR REPLACE FUNCTION expire_booking_holds() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; b record;
BEGIN
  FOR b IN
    SELECT id FROM booking WHERE status = 'pending_payment' AND hold_expires_at < now() FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE inventory_day i SET held = greatest(i.held - x.cnt, 0)
    FROM (
      SELECT br.room_type_id, (n->>'date')::date AS d, count(*) AS cnt
      FROM booking_room br, jsonb_array_elements(br.nights) n
      WHERE br.booking_id = b.id
      GROUP BY 1, 2
    ) x
    WHERE i.room_type_id = x.room_type_id AND i.date = x.d;
    UPDATE booking SET status = 'expired', hold_expires_at = NULL WHERE id = b.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION property_tenant(uuid), booking_tenant(text), expire_booking_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION property_tenant(uuid), booking_tenant(text), expire_booking_holds() TO midotel_app;
