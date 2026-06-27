-- Archive table: one compact JSONB bundle per salon per archiving run
CREATE TABLE public.appointment_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  period_start date,
  period_end date,
  appointment_count integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.appointment_archives TO authenticated;
GRANT ALL ON public.appointment_archives TO service_role;

ALTER TABLE public.appointment_archives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Salon staff can view their archives"
ON public.appointment_archives
FOR SELECT TO authenticated
USING (public.has_salon_access(auth.uid(), salon_id));

CREATE INDEX idx_appointment_archives_salon ON public.appointment_archives (salon_id, archived_at DESC);

-- Function: export appointments that ended > 7 days ago into compact JSON,
-- then hard-delete them from the main table. Returns number of archived rows.
CREATE OR REPLACE FUNCTION public.archive_old_appointments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count integer := 0;
BEGIN
  WITH old_rows AS (
    DELETE FROM public.appointments a
    WHERE a.ends_at < now() - interval '7 days'
    RETURNING a.*
  ),
  grouped AS (
    SELECT
      salon_id,
      count(*)::int AS cnt,
      min(starts_at)::date AS p_start,
      max(ends_at)::date AS p_end,
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'master_id', master_id,
          'service_id', service_id,
          'branch_id', branch_id,
          'client_name', client_name,
          'client_phone', client_phone,
          'client_notes', client_notes,
          'starts_at', starts_at,
          'ends_at', ends_at,
          'price', price,
          'status', status,
          'created_at', created_at
        ) ORDER BY starts_at
      ) AS data
    FROM old_rows
    GROUP BY salon_id
  ),
  ins AS (
    INSERT INTO public.appointment_archives (salon_id, appointment_count, period_start, period_end, data)
    SELECT salon_id, cnt, p_start, p_end, data FROM grouped
    RETURNING appointment_count
  )
  SELECT COALESCE(sum(appointment_count), 0)::int INTO _count FROM ins;

  RETURN _count;
END;
$$;

-- Run the archiver automatically every night at 03:00 UTC
SELECT cron.schedule(
  'archive-old-appointments-daily',
  '0 3 * * *',
  $$SELECT public.archive_old_appointments();$$
);