
-- 1) Add kind column to master_day_overrides
ALTER TABLE public.master_day_overrides
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'workday';

-- Backfill existing rows
UPDATE public.master_day_overrides
  SET kind = CASE WHEN is_off THEN 'off' ELSE 'workday' END
  WHERE kind = 'workday' AND is_off = true;

ALTER TABLE public.master_day_overrides
  DROP CONSTRAINT IF EXISTS master_day_overrides_kind_check;
ALTER TABLE public.master_day_overrides
  ADD CONSTRAINT master_day_overrides_kind_check
  CHECK (kind IN ('workday','off','break'));

-- 2) Replace get_available_slots with break-aware logic
CREATE OR REPLACE FUNCTION public.get_available_slots(_master_id uuid, _service_id uuid, _date date)
 RETURNS TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _tz text; _wd smallint;
  _branch_id uuid; _branch_hours jsonb; _branch_intervals jsonb;
  _override record; _override_intervals jsonb;
  _master_intervals jsonb;
  _break_intervals jsonb;
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

  IF _branch_id IS NOT NULL THEN
    SELECT working_hours INTO _branch_hours FROM branches WHERE id = _branch_id;
    IF _branch_hours IS NOT NULL AND jsonb_typeof(_branch_hours) = 'object' THEN
      _branch_intervals := _branch_hours -> _wd::text;
      IF _branch_intervals IS NOT NULL AND jsonb_typeof(_branch_intervals) = 'array'
         AND jsonb_array_length(_branch_intervals) = 0 THEN RETURN; END IF;
    END IF;
  END IF;

  SELECT * INTO _override FROM master_day_overrides
  WHERE master_id = _master_id AND date = _date;

  IF FOUND AND (_override.is_off OR _override.kind = 'off') THEN RETURN; END IF;

  -- Only treat override intervals as the master's workday when kind = 'workday'
  IF FOUND AND _override.kind = 'workday'
     AND _override.intervals IS NOT NULL AND jsonb_typeof(_override.intervals) = 'array'
     AND jsonb_array_length(_override.intervals) > 0 THEN
    _override_intervals := _override.intervals;
  END IF;

  -- Collect break intervals (kind = 'break')
  IF FOUND AND _override.kind = 'break'
     AND _override.intervals IS NOT NULL AND jsonb_typeof(_override.intervals) = 'array' THEN
    _break_intervals := _override.intervals;
  END IF;

  IF _override_intervals IS NOT NULL THEN
    _master_intervals := _override_intervals;
  ELSE
    SELECT jsonb_agg(jsonb_build_object('start', start_time::text, 'end', end_time::text))
    INTO _master_intervals
    FROM master_schedules WHERE master_id = _master_id AND weekday = _wd;
  END IF;

  IF _master_intervals IS NULL OR jsonb_array_length(_master_intervals) = 0 THEN RETURN; END IF;

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
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(_break_intervals,'[]'::jsonb)) bi
        WHERE ((_date::text || ' ' || (bi->>'start'))::timestamp AT TIME ZONE _tz) < _slot_block_end
          AND ((_date::text || ' ' || (bi->>'end'))::timestamp AT TIME ZONE _tz) > _slot_start
      )
      THEN slot_start := _slot_start; slot_end := _slot_end; RETURN NEXT; END IF;
      _slot_start := _slot_start + _step;
    END LOOP;
  END LOOP;
END;
$function$;

-- 3) Trigger to enforce break blocks on direct INSERT/UPDATE of appointments
CREATE OR REPLACE FUNCTION public.guard_appointment_break()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tz text;
  _date date;
  _row record;
  _bstart timestamptz;
  _bend timestamptz;
BEGIN
  IF NEW.status IS DISTINCT FROM 'confirmed' THEN RETURN NEW; END IF;
  SELECT COALESCE(s.timezone,'UTC') INTO _tz FROM salons s WHERE s.id = NEW.salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  FOR _date IN
    SELECT d::date FROM generate_series(
      (NEW.starts_at AT TIME ZONE _tz)::date,
      (NEW.ends_at   AT TIME ZONE _tz)::date,
      interval '1 day'
    ) d
  LOOP
    FOR _row IN
      SELECT i AS interval_json
      FROM master_day_overrides o,
           LATERAL jsonb_array_elements(o.intervals) i
      WHERE o.master_id = NEW.master_id
        AND o.date = _date
        AND o.kind = 'break'
        AND o.intervals IS NOT NULL
        AND jsonb_typeof(o.intervals) = 'array'
    LOOP
      _bstart := ((_date::text || ' ' || (_row.interval_json->>'start'))::timestamp AT TIME ZONE _tz);
      _bend   := ((_date::text || ' ' || (_row.interval_json->>'end'))::timestamp AT TIME ZONE _tz);
      IF NEW.starts_at < _bend AND NEW.ends_at > _bstart THEN
        RAISE EXCEPTION 'У мастера установлен перерыв с % до %',
          to_char(_bstart AT TIME ZONE _tz, 'HH24:MI'),
          to_char(_bend   AT TIME ZONE _tz, 'HH24:MI');
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_appointment_break_guard ON public.appointments;
CREATE TRIGGER trg_appointment_break_guard
BEFORE INSERT OR UPDATE OF starts_at, ends_at, master_id, status
ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.guard_appointment_break();

-- 4) Update create_appointment to reject break overlaps with same friendly message
CREATE OR REPLACE FUNCTION public.create_appointment(_salon_id uuid, _master_id uuid, _service_id uuid, _starts_at timestamp with time zone, _client_name text, _client_phone text, _client_notes text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid, _addon_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _price numeric;
  _addon_price numeric := 0;
  _ends_at timestamptz; _block_end timestamptz; _new_id uuid; _mb uuid;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;

  SELECT duration_min, price, COALESCE(buffer_after_min,0)
    INTO _duration, _price, _buffer
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  SELECT branch_id INTO _mb FROM masters WHERE id = _master_id AND salon_id = _salon_id AND is_active = true;
  IF NOT EXISTS (SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id
                 WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true AND ms.service_id = _service_id)
  THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  IF _branch_id IS NOT NULL AND _mb IS NOT NULL AND _mb <> _branch_id THEN
    RAISE EXCEPTION 'Master does not work at this branch';
  END IF;

  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(price),0)
      INTO _addon_price
    FROM service_addons
    WHERE id = ANY(_addon_ids) AND salon_id = _salon_id AND is_active = true;
  END IF;

  _ends_at := _starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;
  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed'
             AND starts_at < _block_end AND ends_at > _starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  -- Break check (mirrors trigger for a nicer message at RPC time)
  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_starts_at AT TIME ZONE _tz)::date,
      (_ends_at   AT TIME ZONE _tz)::date,
      interval '1 day'
    ) d
  LOOP
    FOR _row IN
      SELECT i AS interval_json
      FROM master_day_overrides o,
           LATERAL jsonb_array_elements(o.intervals) i
      WHERE o.master_id = _master_id
        AND o.date = _date
        AND o.kind = 'break'
        AND jsonb_typeof(o.intervals) = 'array'
    LOOP
      _bstart := ((_date::text || ' ' || (_row.interval_json->>'start'))::timestamp AT TIME ZONE _tz);
      _bend   := ((_date::text || ' ' || (_row.interval_json->>'end'))::timestamp AT TIME ZONE _tz);
      IF _starts_at < _bend AND _ends_at > _bstart THEN
        RAISE EXCEPTION 'У мастера установлен перерыв с % до %',
          to_char(_bstart AT TIME ZONE _tz, 'HH24:MI'),
          to_char(_bend   AT TIME ZONE _tz, 'HH24:MI');
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price, branch_id)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _price + _addon_price, COALESCE(_branch_id, _mb))
  RETURNING id INTO _new_id;

  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    INSERT INTO appointment_addons (appointment_id, addon_id, name_snapshot, price_snapshot, duration_snapshot)
    SELECT _new_id, a.id, a.name, a.price, a.duration_min
    FROM service_addons a
    WHERE a.id = ANY(_addon_ids) AND a.salon_id = _salon_id AND a.is_active = true;
  END IF;

  RETURN _new_id;
END;
$function$;
