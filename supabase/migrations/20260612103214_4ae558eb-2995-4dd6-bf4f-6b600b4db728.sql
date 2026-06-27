
-- 1. Branch contact fields
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS whatsapp_url text,
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS tiktok_url text;

-- 2. Fix bad data for Байтик branch
UPDATE public.branches
SET working_hours = '{"0":[{"start":"09:00","end":"21:00"}],"1":[{"start":"09:00","end":"21:00"}],"2":[{"start":"09:00","end":"21:00"}],"3":[{"start":"09:00","end":"21:00"}],"4":[{"start":"09:00","end":"21:00"}],"5":[{"start":"09:00","end":"21:00"}],"6":[{"start":"09:00","end":"21:00"}]}'::jsonb
WHERE id = '19ef1845-9dcd-4fb1-b1b8-1d7980c82a55';

-- 3. Master per-day overrides
CREATE TABLE IF NOT EXISTS public.master_day_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id uuid NOT NULL REFERENCES public.masters(id) ON DELETE CASCADE,
  date date NOT NULL,
  is_off boolean NOT NULL DEFAULT false,
  intervals jsonb, -- e.g. [{"start":"10:00","end":"15:00"}]
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (master_id, date)
);

GRANT SELECT ON public.master_day_overrides TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_day_overrides TO authenticated;
GRANT ALL ON public.master_day_overrides TO service_role;

ALTER TABLE public.master_day_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public reads day overrides" ON public.master_day_overrides
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Salon admin manages day overrides" ON public.master_day_overrides
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM masters m WHERE m.id = master_id AND has_salon_access(auth.uid(), m.salon_id)));

CREATE POLICY "Super admin manages day overrides" ON public.master_day_overrides
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'super_admin')) WITH CHECK (has_role(auth.uid(), 'super_admin'));

CREATE TRIGGER trg_master_day_overrides_updated
  BEFORE UPDATE ON public.master_day_overrides
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. Rewrite get_available_slots with branch ∩ master schedule ∩ day override
CREATE OR REPLACE FUNCTION public.get_available_slots(_master_id uuid, _service_id uuid, _date date)
RETURNS TABLE(slot_start timestamptz, slot_end timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _duration int; _buffer int; _tz text; _wd smallint;
  _branch_id uuid; _branch_hours jsonb; _branch_intervals jsonb;
  _override record; _override_intervals jsonb;
  _master_intervals jsonb;
  _slot_start timestamptz; _slot_end timestamptz; _slot_block_end timestamptz;
  _step interval := interval '15 minutes';
  _eff_start time; _eff_end time;
  _row record;
BEGIN
  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND is_active = true;
  IF _duration IS NULL THEN RETURN; END IF;

  SELECT s.timezone, m.branch_id INTO _tz, _branch_id
  FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  _wd := EXTRACT(DOW FROM _date)::smallint;

  -- Branch hours for this weekday
  IF _branch_id IS NOT NULL THEN
    SELECT working_hours INTO _branch_hours FROM branches WHERE id = _branch_id;
    IF _branch_hours IS NOT NULL AND jsonb_typeof(_branch_hours) = 'object' THEN
      _branch_intervals := _branch_hours -> _wd::text;
      IF _branch_intervals IS NOT NULL AND jsonb_typeof(_branch_intervals) = 'array'
         AND jsonb_array_length(_branch_intervals) = 0 THEN RETURN; END IF;
    END IF;
  END IF;

  -- Day override for this master
  SELECT * INTO _override FROM master_day_overrides
  WHERE master_id = _master_id AND date = _date;

  IF FOUND AND _override.is_off THEN RETURN; END IF;

  IF FOUND AND _override.intervals IS NOT NULL AND jsonb_typeof(_override.intervals) = 'array'
     AND jsonb_array_length(_override.intervals) > 0 THEN
    _override_intervals := _override.intervals;
  END IF;

  -- Master intervals: override → schedule
  IF _override_intervals IS NOT NULL THEN
    _master_intervals := _override_intervals;
  ELSE
    SELECT jsonb_agg(jsonb_build_object('start', start_time::text, 'end', end_time::text))
    INTO _master_intervals
    FROM master_schedules WHERE master_id = _master_id AND weekday = _wd;
  END IF;

  IF _master_intervals IS NULL OR jsonb_array_length(_master_intervals) = 0 THEN RETURN; END IF;

  -- Intersect master intervals × branch intervals (or use master if branch unspecified)
  FOR _row IN
    SELECT
      GREATEST((mi->>'start')::time,
        CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
             THEN (mi->>'start')::time ELSE (bi->>'start')::time END) AS s,
      LEAST((mi->>'end')::time,
        CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
             THEN (mi->>'end')::time ELSE (bi->>'end')::time END) AS e
    FROM jsonb_array_elements(_master_intervals) mi
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
           THEN jsonb_build_array(mi) ELSE _branch_intervals END
    ) bi ON true
  LOOP
    _eff_start := _row.s; _eff_end := _row.e;
    IF _eff_start >= _eff_end THEN CONTINUE; END IF;
    _slot_start := ((_date::text || ' ' || _eff_start::text)::timestamp AT TIME ZONE _tz);
    LOOP
      _slot_end := _slot_start + (_duration || ' minutes')::interval;
      _slot_block_end := _slot_end + (_buffer || ' minutes')::interval;
      EXIT WHEN _slot_end > ((_date::text || ' ' || _eff_end::text)::timestamp AT TIME ZONE _tz);
      IF _slot_start <= now() THEN _slot_start := _slot_start + _step; CONTINUE; END IF;
      IF NOT EXISTS (SELECT 1 FROM appointments a WHERE a.master_id = _master_id AND a.status = 'confirmed' AND a.starts_at < _slot_block_end AND a.ends_at > _slot_start)
      AND NOT EXISTS (SELECT 1 FROM master_time_off t WHERE t.master_id = _master_id AND t.starts_at < _slot_block_end AND t.ends_at > _slot_start)
      THEN slot_start := _slot_start; slot_end := _slot_end; RETURN NEXT; END IF;
      _slot_start := _slot_start + _step;
    END LOOP;
  END LOOP;
END;
$$;
