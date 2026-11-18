-- Notifications: an outbox written in the same transaction as the booking change, sent by a worker with retries.

ALTER TABLE property ADD COLUMN notification_emails text[] NOT NULL DEFAULT '{}';

CREATE TABLE message_outbox (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  booking_id           uuid REFERENCES booking(id) ON DELETE SET NULL,
  channel              text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp')),
  template             text NOT NULL,
  recipient            text NOT NULL,
  reply_to             text,
  from_name            text NOT NULL,
  subject              text NOT NULL,
  body_html            text NOT NULL,
  body_text            text NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts             smallint NOT NULL DEFAULT 0,
  last_error           text,
  send_after           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_outbox_due_idx ON message_outbox (send_after) WHERE status = 'pending';
CREATE INDEX message_outbox_property_idx ON message_outbox (property_id, created_at DESC);
CREATE INDEX message_outbox_booking_idx ON message_outbox (booking_id);
ALTER TABLE message_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_outbox
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON message_outbox TO midotel_app;

-- The sender works across tenants, so it claims and settles messages only through these functions.
CREATE OR REPLACE FUNCTION claim_outbox_messages(p_limit integer)
RETURNS SETOF message_outbox
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE message_outbox m SET status = 'sending', attempts = m.attempts + 1
  WHERE m.id IN (
    SELECT id FROM message_outbox
    WHERE (status = 'pending' AND send_after <= now())
       OR (status = 'sending' AND send_after <= now() - interval '10 minutes') -- a sender died mid-send
    ORDER BY send_after
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING m.*
$$;

CREATE OR REPLACE FUNCTION settle_outbox_message(p_id uuid, p_ok boolean, p_error text, p_provider_id text, p_max_attempts integer)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE message_outbox SET
    status = CASE WHEN p_ok THEN 'sent' WHEN attempts >= p_max_attempts THEN 'failed' ELSE 'pending' END,
    sent_at = CASE WHEN p_ok THEN now() ELSE NULL END,
    provider_message_id = p_provider_id,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    -- Retry after 1, 2, 4, 8 minutes.
    send_after = CASE WHEN p_ok THEN send_after ELSE now() + make_interval(mins => power(2, attempts - 1)::int) END
  WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION claim_outbox_messages(integer), settle_outbox_message(uuid, boolean, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_messages(integer), settle_outbox_message(uuid, boolean, text, text, integer) TO midotel_app;
