-- Fix: automatic appointment reminders never fire on the current (post-migration) project.
--
-- ROOT CAUSE: the 'send-appointment-reminders' pg_cron job was last (re)scheduled in
-- 20260619064833 pointing at the OLD Supabase project URL (kcmxbzsjizhrierakvkj...). When the
-- platform moved to the new project (khykprcdojksqvuqyajd) on 2026-06-29, trigger URLs were
-- fixed (20260630120000) but this cron was overlooked — so every 15 minutes it POSTs into a
-- dead endpoint and no reminder is ever sent, for any salon. It also read the vault secret
-- directly instead of the internal_get_cron_secret() helper the other jobs now use.
--
-- This migration:
--   1) Adds a per-salon, configurable reminder lead time (default 2h) on salon_ai_assistant.
--   2) Adds get_due_reminders() so the edge function picks appointments due for a reminder using
--      EACH salon's own lead time (instead of a single hard-coded ~2h window), keyed off the
--      per-appointment starts_at. Scales to any number of salons in one query.
--   3) Re-schedules the cron at the CORRECT new-project URL with the standard cron-secret helper.

-- 1) Configurable lead time. 1–72h; 2h stays the default so existing salons are unchanged.
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS reminder_lead_hours integer NOT NULL DEFAULT 2;

ALTER TABLE public.salon_ai_assistant
  DROP CONSTRAINT IF EXISTS salon_ai_assistant_reminder_lead_hours_ck;
ALTER TABLE public.salon_ai_assistant
  ADD CONSTRAINT salon_ai_assistant_reminder_lead_hours_ck
  CHECK (reminder_lead_hours BETWEEN 1 AND 72);

-- 2) Appointments whose visit is now within [lead-15m, lead+15m] and not yet reminded. The ±15m
--    band is wider than the 15-min cron cadence so every appointment is caught at least once;
--    reminder_sent then guarantees exactly one send. The lower bound also means a booking made
--    INSIDE its own lead window never triggers a redundant reminder (it just got a confirmation).
--    Salons without an assistant row fall back to the 2h default via COALESCE + LEFT JOIN.
CREATE OR REPLACE FUNCTION public.get_due_reminders()
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
  FROM appointments a
  LEFT JOIN salon_ai_assistant aa ON aa.salon_id = a.salon_id
  WHERE a.status = 'confirmed'
    AND a.reminder_sent = false
    AND a.starts_at >= now() + ((COALESCE(aa.reminder_lead_hours, 2) * 60 - 15) * interval '1 minute')
    AND a.starts_at <= now() + ((COALESCE(aa.reminder_lead_hours, 2) * 60 + 15) * interval '1 minute')
  ORDER BY a.starts_at
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION public.get_due_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_due_reminders() TO service_role;

-- 3) Re-schedule the cron at the correct new-project URL + standard secret helper.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-appointment-reminders') THEN
    PERFORM cron.unschedule('send-appointment-reminders');
  END IF;
END $$;

SELECT cron.schedule(
  'send-appointment-reminders',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://khykprcdojksqvuqyajd.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT public.internal_get_cron_secret())
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) AS request_id;
  $$
);
