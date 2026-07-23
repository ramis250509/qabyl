-- ============================================================
-- Repoint all hardcoded project URLs: Tokyo (khykprcdojksqvuqyajd) → Frankfurt (bfxexnpyfslfuelfkhzr)
-- ============================================================
-- The DB trigger functions and pg_cron jobs call edge functions via hardcoded
-- https://<ref>.supabase.co/functions/v1/... URLs (see 20260630120000_fix_trigger_urls_new_project).
-- After a project move those URLs must point at the new project or push notifications, WhatsApp
-- confirmations, reminders, and the silent-salon alert silently fail.
--
-- This is done ROBUSTLY (not by hand-reconstructing each function): it finds EVERY function in the
-- public schema whose definition references the old ref and re-creates it with the new ref, and
-- rewrites EVERY pg_cron job command the same way. Runs last in the migration order, so by the time
-- it executes every function/cron already exists with the old ref baked in.
--
-- Idempotent: a second run finds nothing to change. Safe to keep in the migration history.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%khykprcdojksqvuqyajd%'
  LOOP
    EXECUTE replace(r.def, 'khykprcdojksqvuqyajd', 'bfxexnpyfslfuelfkhzr');
  END LOOP;
END $$;

-- pg_cron stores each job's SQL in cron.job.command — rewrite any that still reference the old ref.
-- Guarded so the migration doesn't fail on a project where pg_cron isn't installed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    UPDATE cron.job
    SET command = replace(command, 'khykprcdojksqvuqyajd', 'bfxexnpyfslfuelfkhzr')
    WHERE command LIKE '%khykprcdojksqvuqyajd%';
  END IF;
END $$;
