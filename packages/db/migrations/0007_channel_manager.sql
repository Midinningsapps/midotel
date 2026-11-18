-- Channel manager integration (eZee, STAAH, ...). Midotel talks to the hotel's channel manager, which talks to OTAs.

CREATE TABLE channel_connection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('ezee', 'staah', 'simulator')),
  hotel_code       text NOT NULL,                 -- the hotel's id at the channel manager
  endpoint_url     text,                          -- where we push updates (from the provider's spec)
  credentials_enc  text,                          -- AES-GCM encrypted JSON (username/password or API key)
  inbound_token_hash text NOT NULL,               -- authenticates the provider's calls to our webhook
  -- Which side owns prices and availability:
  --   channel_manager: hotel edits rates in the CM; we receive them and push only our bookings.
  --   midotel:         hotel edits rates in Midotel; we push prices/availability and bookings.
  master           text NOT NULL DEFAULT 'channel_manager' CHECK (master IN ('channel_manager', 'midotel')),
  is_active        boolean NOT NULL DEFAULT false,
  last_success_at  timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, provider)
);
CREATE TRIGGER channel_connection_touch BEFORE UPDATE ON channel_connection FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE channel_room_map (
  connection_id  uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  room_type_id   uuid NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  external_code  text NOT NULL,
  PRIMARY KEY (connection_id, room_type_id),
  UNIQUE (connection_id, external_code)
);

CREATE TABLE channel_rate_map (
  connection_id  uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  room_type_id   uuid NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  rate_plan_id   uuid NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
  external_code  text NOT NULL,
  PRIMARY KEY (connection_id, room_type_id, rate_plan_id),
  UNIQUE (connection_id, room_type_id, external_code)
);

-- Outgoing work for the channel manager, retried until accepted.
CREATE TABLE channel_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('ari', 'booking')),
  -- ari: { "roomTypeIds": [...], "from": "2026-12-01", "to": "2026-12-31" } (values are read fresh at send time)
  -- booking: { "bookingId": "..." }
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts       smallint NOT NULL DEFAULT 0,
  last_error     text,
  send_after     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_outbox_due_idx ON channel_outbox (send_after) WHERE status = 'pending';
CREATE INDEX channel_outbox_connection_idx ON channel_outbox (connection_id, created_at DESC);

-- Messages received from the channel manager, kept for support and replay.
CREATE TABLE channel_inbound_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  outcome        text NOT NULL,      -- 'applied' | 'ignored' | 'error'
  detail         text,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_inbound_connection_idx ON channel_inbound_log (connection_id, created_at DESC);

-- Bookings that arrive from OTAs through the channel manager.
ALTER TABLE booking ADD COLUMN channel_connection_id uuid REFERENCES channel_connection(id) ON DELETE SET NULL;
ALTER TABLE booking ADD COLUMN channel_name text;          -- e.g. Booking.com, MakeMyTrip
ALTER TABLE booking ADD COLUMN external_reference text;
CREATE UNIQUE INDEX booking_external_ref_idx ON booking (channel_connection_id, external_reference) WHERE external_reference IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_connection', 'channel_room_map', 'channel_rate_map', 'channel_outbox', 'channel_inbound_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO midotel_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE channel_inbound_log_id_seq TO midotel_app;

-- Webhook calls carry only the connection id; find its tenant before RLS applies.
CREATE OR REPLACE FUNCTION channel_connection_tenant(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM channel_connection WHERE id = p_id
$$;

CREATE OR REPLACE FUNCTION claim_channel_outbox(p_limit integer)
RETURNS SETOF channel_outbox
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE channel_outbox c SET status = 'sending', attempts = c.attempts + 1
  WHERE c.id IN (
    SELECT o.id FROM channel_outbox o JOIN channel_connection cc ON cc.id = o.connection_id AND cc.is_active
    WHERE (o.status = 'pending' AND o.send_after <= now())
       OR (o.status = 'sending' AND o.send_after <= now() - interval '10 minutes')
    ORDER BY o.send_after
    LIMIT p_limit
    FOR UPDATE OF o SKIP LOCKED
  )
  RETURNING c.*
$$;

CREATE OR REPLACE FUNCTION settle_channel_outbox(p_id uuid, p_ok boolean, p_error text, p_max_attempts integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE conn uuid;
BEGIN
  UPDATE channel_outbox SET
    status = CASE WHEN p_ok THEN 'sent' WHEN attempts >= p_max_attempts THEN 'failed' ELSE 'pending' END,
    sent_at = CASE WHEN p_ok THEN now() ELSE NULL END,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    send_after = CASE WHEN p_ok THEN send_after ELSE now() + make_interval(mins => power(2, attempts - 1)::int) END
  WHERE id = p_id
  RETURNING connection_id INTO conn;
  UPDATE channel_connection SET
    last_success_at = CASE WHEN p_ok THEN now() ELSE last_success_at END,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  WHERE id = conn;
END $$;

REVOKE ALL ON FUNCTION channel_connection_tenant(uuid), claim_channel_outbox(integer), settle_channel_outbox(uuid, boolean, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_connection_tenant(uuid), claim_channel_outbox(integer), settle_channel_outbox(uuid, boolean, text, integer) TO midotel_app;
