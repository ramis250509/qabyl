
CREATE OR REPLACE FUNCTION public.get_available_slots(_master_id uuid, _service_id uuid, _date date)
 RETURNS TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _buffer int; _tz text; _wd smallint; _sched record;
  _branch_id uuid; _branch_hours jsonb; _branch_intervals jsonb;
  _slot_start timestamptz; _slot_end timestamptz; _slot_block_end timestamptz;
  _step interval := interval '15 minutes';
  _eff_start time; _eff_end time;
  _bh record;
BEGIN
  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND is_active = true;
  IF _duration IS NULL THEN RETURN; END IF;

  SELECT s.timezone, m.branch_id INTO _tz, _branch_id
  FROM masters m JOIN salons s ON s.id = m.salon_id
  WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  _wd := EXTRACT(DOW FROM _date)::smallint;

  -- branch hours: { "0": [{"start":"10:00","end":"19:00"}, ...], ..., "closed": false }
  IF _branch_id IS NOT NULL THEN
    SELECT working_hours INTO _branch_hours FROM branches WHERE id = _branch_id;
    IF _branch_hours IS NOT NULL AND jsonb_typeof(_branch_hours) = 'object' THEN
      _branch_intervals := _branch_hours -> _wd::text;
      -- If key exists but is empty array → branch is closed that day
      IF _branch_intervals IS NOT NULL AND jsonb_typeof(_branch_intervals) = 'array'
         AND jsonb_array_length(_branch_intervals) = 0
      THEN
        RETURN;
      END IF;
    END IF;
  END IF;

  FOR _sched IN
    SELECT start_time, end_time FROM master_schedules
    WHERE master_id = _master_id AND weekday = _wd
    ORDER BY start_time
  LOOP
    -- For each branch interval (or just one no-op pass), intersect with master schedule.
    FOR _bh IN
      SELECT
        CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
             THEN _sched.start_time
             ELSE GREATEST(_sched.start_time, (elem->>'start')::time)
        END AS s,
        CASE WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
             THEN _sched.end_time
             ELSE LEAST(_sched.end_time, (elem->>'end')::time)
        END AS e
      FROM (
        SELECT CASE
          WHEN _branch_intervals IS NULL OR jsonb_typeof(_branch_intervals) <> 'array'
          THEN jsonb_build_array(jsonb_build_object('start', _sched.start_time::text, 'end', _sched.end_time::text))
          ELSE _branch_intervals
        END AS arr
      ) src, LATERAL jsonb_array_elements(src.arr) elem
    LOOP
      _eff_start := _bh.s; _eff_end := _bh.e;
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
  END LOOP;
END;
$function$;
