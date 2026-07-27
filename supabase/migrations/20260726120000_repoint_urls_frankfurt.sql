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
  -- prokind IN ('f','p') = normal functions + procedures only. MUST filter BEFORE calling
  -- pg_get_functiondef, which throws "X is an aggregate function" (42809) on aggregate ('a') or
  -- window ('w') functions. The subquery applies the prokind filter in WHERE, so the definition
  -- is only computed for eligible rows.
  FOR r IN
    SELECT def
    FROM (
      SELECT pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind IN ('f', 'p')
    ) fns
    WHERE fns.def LIKE '%khykprcdojksqvuqyajd%'
  LOOP
    EXECUTE replace(r.def, 'khykprcdojksqvuqyajd', 'bfxexnpyfslfuelfkhzr');
  END LOOP;
END $$;

-- pg_cron jobs reference the edge-function URL in their command. Direct UPDATE on cron.job is
-- denied for the postgres role (42501) — the supported way to change a job is cron.alter_job().
-- We loop over jobs referencing the old ref and re-point them via that function. Wrapped so any
-- privilege / missing-extension issue is skipped gracefully instead of breaking the migration;
-- if skipped, the cron URLs can be fixed from the Dashboard SQL editor afterwards.
DO $$
DECLARE
  j RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR j IN
      SELECT jobid, command FROM cron.job WHERE command LIKE '%khykprcdojksqvuqyajd%'
    LOOP
      PERFORM cron.alter_job(
        job_id => j.jobid,
        command => replace(j.command, 'khykprcdojksqvuqyajd', 'bfxexnpyfslfuelfkhzr')
      );
    END LOOP;
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_function OR undefined_table THEN
    RAISE NOTICE 'Skipping cron URL repoint (fix from Dashboard SQL editor if needed): %', SQLERRM;
END $$;
