-- Lets the WhatsApp AI assistant move an existing confirmed appointment to a new time,
-- with the same conflict/break validation create_appointment already does for new bookings
-- (recomputed duration+buffer from the service, excluding the appointment being moved from
-- its own conflict check, master break overrides honored). Internal-only: not exposed to
-- anon/authenticated — only the server-side WA agent (service_role) calls this, since it
-- trusts the appointment_id it was given without re-checking salon/client ownership itself.
CREATE OR REPLACE FUNCTION public.reschedule_appointment(
  _appointment_id uuid,
  _new_starts_at timestamp with time zone
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

  UPDATE appointments SET starts_at = _new_starts_at, ends_at = _ends_at WHERE id = _appointment_id;

  RETURN _appointment_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_appointment(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment(uuid, timestamptz) TO service_role;
