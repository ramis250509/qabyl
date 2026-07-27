-- Ready-for-launch migration:
--   1) Promote WA agent V4 to default for new AND existing salons (V3 stays as fallback
--      via the same salon_ai_assistant.engine column — flip individual rows back if needed).
--   2) Introduce error_logs — a Supabase-native prod error sink readable at /admin/errors
--      by super_admin only. Small, indexed, auto-pruned to 30 days.

-- 1) V4 as default -------------------------------------------------------------------
ALTER TABLE public.salon_ai_assistant
  ALTER COLUMN engine SET DEFAULT 'v4';

-- Flip existing V3 rows (V4 is now the sanctioned default per product decision;
-- individual salons can still be moved back to V3 in the admin UI if V4 misbehaves for them).
UPDATE public.salon_ai_assistant SET engine = 'v4' WHERE engine = 'v3';

-- 2) error_logs table ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.error_logs (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  level        text NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  source       text NOT NULL,                       -- 'wa-webhook' | 'server-fn' | 'edge-fn' | 'client' | 'agent-v4' | 'agent-v3'
  salon_id     uuid NULL REFERENCES public.salons(id) ON DELETE SET NULL,
  user_id      uuid NULL,                           -- auth.users.id when known; kept loose to avoid FK on auth schema
  message      text NOT NULL,
  stack        text NULL,
  context      jsonb NULL,                          -- request id, url, phone, etc.
  fingerprint  text NULL                            -- SHA-1 of (source|message) for grouping
);

CREATE INDEX IF NOT EXISTS error_logs_ts_desc_idx      ON public.error_logs (ts DESC);
CREATE INDEX IF NOT EXISTS error_logs_salon_ts_idx     ON public.error_logs (salon_id, ts DESC);
CREATE INDEX IF NOT EXISTS error_logs_fingerprint_idx  ON public.error_logs (fingerprint);
CREATE INDEX IF NOT EXISTS error_logs_level_ts_idx     ON public.error_logs (level, ts DESC);

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Reads: super_admin only. Writes: service role only (server code) — no user-facing INSERT policy.
DROP POLICY IF EXISTS error_logs_super_admin_read ON public.error_logs;
CREATE POLICY error_logs_super_admin_read ON public.error_logs
  FOR SELECT
  USING (public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS error_logs_super_admin_delete ON public.error_logs;
CREATE POLICY error_logs_super_admin_delete ON public.error_logs
  FOR DELETE
  USING (public.has_role(auth.uid(), 'super_admin'));

-- 3) 30-day retention via existing cron_secret scheme --------------------------------
CREATE OR REPLACE FUNCTION public.prune_error_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.error_logs WHERE ts < now() - interval '30 days';
END;
$$;

-- Nightly at 03:15 UTC — safe idempotent schedule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prune_error_logs_daily';
    PERFORM cron.schedule(
      'prune_error_logs_daily',
      '15 3 * * *',
      $cron$ SELECT public.prune_error_logs(); $cron$
    );
  END IF;
END $$;
