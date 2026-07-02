-- 1) Salon-configurable deadline for cancel/reschedule via the WA assistant:
--    visits starting in less than manage_cutoff_hours can only be changed by phone.
--    0 = no limit (default).
ALTER TABLE public.salon_ai_assistant
  ADD COLUMN IF NOT EXISTS manage_cutoff_hours integer NOT NULL DEFAULT 0;

-- 2) reschedule_appointment_v2 — same validation as reschedule_appointment, but can also
--    move the appointment to ANOTHER master (used when the original master's day is full
--    and the client agreed to a slot of a different master). Internal-only: called by the
--    server-side WA agent (service_role), which trusts the appointment_id it was given.
CREATE OR REPLACE FUNCTION public.reschedule_appointment_v2(
  _appointment_id uuid,
  _new_starts_at timestamp with time zone,
  _new_master_id uuid DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _salon_id uuid; _master_id uuid; _service_id uuid; _status text;
  _duration int; _buffer int;
  _ends_at timestamptz; _block_end timestamptz;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
BEGIN
  SELECT salon_id, master_id, service_id, status
    INTO _salon_id, _master_id, _service_id, _status
  FROM appointments WHERE id = _appointment_id;
  IF _salon_id IS NULL THEN RAISE EXCEPTION 'Appointment not found'; END IF;
  IF _status <> 'confirmed' THEN RAISE EXCEPTION 'Only confirmed appointments can be rescheduled'; END IF;
  IF _new_starts_at <= now() THEN RAISE EXCEPTION 'Cannot reschedule to the past'; END IF;

  -- Target master: the new one when given (must belong to the same salon and be active).
  IF _new_master_id IS NOT NULL AND _new_master_id <> _master_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM masters
      WHERE id = _new_master_id AND salon_id = _salon_id AND is_active = true
    ) THEN RAISE EXCEPTION 'Master not found'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM master_services
      WHERE master_id = _new_master_id AND service_id = _service_id
    ) THEN RAISE EXCEPTION 'Master does not offer this service'; END IF;
    _master_id := _new_master_id;
  END IF;

  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  _ends_at := _new_starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id AND status = 'confirmed'
             AND id <> _appointment_id
             AND starts_at < _block_end AND ends_at > _new_starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_new_starts_at AT TIME ZONE _tz)::date,
      (_ends_at        AT TIME ZONE _tz)::date,
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
      IF _new_starts_at < _bend AND _ends_at > _bstart THEN
        RAISE EXCEPTION 'У мастера установлен перерыв с % до %',
          to_char(_bstart AT TIME ZONE _tz, 'HH24:MI'),
          to_char(_bend   AT TIME ZONE _tz, 'HH24:MI');
      END IF;
    END LOOP;
  END LOOP;

  UPDATE appointments
  SET starts_at = _new_starts_at, ends_at = _ends_at, master_id = _master_id
  WHERE id = _appointment_id;

  RETURN _appointment_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) TO service_role;
