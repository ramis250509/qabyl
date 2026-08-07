-- ============================================================================
-- Tell the client when their held slot is released.
-- ============================================================================
-- prepayment_expire_holds() frees the slot and writes an audit row, but says
-- nothing to the person who was told "держим слот до 14:30". They are left
-- waiting for a confirmation that will never arrive — the single worst moment
-- in the prepayment flow, and the easiest to fix.
--
-- Same shape as the existing wa reconciliation job (20260728120000): the SQL
-- side POSTs to an app route, which owns the channel-specific sending. Delivery
-- is best-effort by design — a failed notification must never stop the slot from
-- being released, so the whole call is wrapped and any error is downgraded to a
-- warning.
--
-- Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prepayment_expire_holds()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r RECORD;
  cnt integer := 0;
  secret text;
  notify_url text := 'https://qabyl.com/api/public/prepayment-expired';
BEGIN
  SELECT public.internal_get_cron_secret() INTO secret;

  FOR r IN
    SELECT id, salon_id FROM appointments
     WHERE status = 'pending_payment'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < now()
     LIMIT 200
  LOOP
    UPDATE appointments SET status = 'payment_expired' WHERE id = r.id;
    UPDATE appointment_prepayments
       SET status = 'expired'
     WHERE appointment_id = r.id
       AND status IN ('waiting_upload','uploaded','processing','manual_review');
    INSERT INTO prepayment_audit(appointment_id, salon_id, actor_kind, action)
    VALUES (r.id, r.salon_id, 'system', 'expired');
    cnt := cnt + 1;

    -- Best-effort: the slot is already free regardless of what happens here.
    BEGIN
      IF secret IS NOT NULL AND length(secret) > 0 THEN
        PERFORM net.http_post(
          url := notify_url,
          body := jsonb_build_object('appointment_id', r.id),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
          timeout_milliseconds := 5000
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'hold-expiry notification failed for appointment %: %', r.id, SQLERRM;
    END;
  END LOOP;

  RETURN cnt;
END;
$$;
