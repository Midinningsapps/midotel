-- Fix: in 0003 the loop counter "n" clashed with the jsonb element alias "n".
CREATE OR REPLACE FUNCTION expire_booking_holds() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE expired_count integer := 0; b record;
BEGIN
  FOR b IN
    SELECT id FROM booking WHERE status = 'pending_payment' AND hold_expires_at < now() FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE inventory_day i SET held = greatest(i.held - x.cnt, 0)
    FROM (
      SELECT br.room_type_id, (night->>'date')::date AS d, count(*) AS cnt
      FROM booking_room br, jsonb_array_elements(br.nights) night
      WHERE br.booking_id = b.id
      GROUP BY 1, 2
    ) x
    WHERE i.room_type_id = x.room_type_id AND i.date = x.d;
    UPDATE booking SET status = 'expired', hold_expires_at = NULL WHERE id = b.id;
    expired_count := expired_count + 1;
  END LOOP;
  RETURN expired_count;
END $$;

REVOKE ALL ON FUNCTION expire_booking_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_booking_holds() TO midotel_app;
