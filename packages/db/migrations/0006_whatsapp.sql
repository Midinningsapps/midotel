-- WhatsApp: guest opt-in on the booking, and structured template data on outbox messages.
ALTER TABLE booking ADD COLUMN whatsapp_opt_in boolean NOT NULL DEFAULT false;
-- For WhatsApp: { "template": "booking_confirmed", "language": "en", "params": ["Asha", ...] }
ALTER TABLE message_outbox ADD COLUMN payload jsonb;
