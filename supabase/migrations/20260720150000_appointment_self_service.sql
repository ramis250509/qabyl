-- Self-service booking management: a client who has a booking can open a personal, unguessable
-- link and see / reschedule / cancel their own appointment WITHOUT talking to the AI assistant.
--
-- Design:
--  * Each appointment gets an opaque `manage_token` (uuid). The token is the only credential —
--    it is sent over the same WhatsApp confirmation the client already receives, and it maps to
--    exactly ONE appointment. No PII (phone) is ever exposed through it.
--  * Three SECURITY DEFINER RPCs, callable by `anon` (the manage page is public, no login):
--      get_appointment_by_token       — read-only snapshot for the page
--      reschedule_appointment_by_token — move the visit's time (same master, same service)
--      cancel_appointment_by_token     — cancel the visit
--    They re-derive everything from the token server-side, so a client can only ever touch the
--    one appointment their token points at. They reuse the atomic validation in
--    reschedule_appointment_v2 (double-booking / past / break / master-service checks).
--  * The salon's `manage_cutoff_hours` (already used by the WA assistant) is honoured here too:
--    a visit starting sooner than the cutoff can only be changed by contacting the salon.
--  * Owner awareness: a self-service change fires a WhatsApp note to the salon owner only
--    (kinds self_reschedule / self_cancel in send-whatsapp), never a duplicate to the client —
--    the client is looking at the result on the page. The AFTER UPDATE client-notify trigger is
--    naturally skipped because these RPCs run with auth.uid() = NULL (service_role context).

-- 1) Token column. A volatile default backfills every existing row with a unique value during
--    the rewrite, so historical appointments are manageable too.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS manage_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS appointments_manage_token_idx
  ON public.appointments (manage_token);

-- 2) Read snapshot for the manage page. Returns only what the page renders — deliberately no
--    client_phone. `manageable` folds together status + cutoff so the UI has one flag to gate on.
CREATE OR REPLACE FUNCTION public.get_appointment_by_token(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a record;
  _cutoff int;
  _min_at timestamptz;
BEGIN
  SELECT ap.id, ap.salon_id, ap.master_id, ap.service_id, ap.starts_at, ap.ends_at,
         ap.status, ap.price, ap.client_name,
         s.name AS salon_name, s.address AS salon_address, s.phone AS salon_phone,
         COALESCE(s.timezone,'UTC') AS timezone,
         m.name AS master_name, sv.name AS service_name
    INTO a
  FROM appointments ap
  JOIN salons s   ON s.id  = ap.salon_id
  JOIN masters m  ON m.id  = ap.master_id
  JOIN services sv ON sv.id = ap.service_id
  WHERE ap.manage_token = _token;

  IF a.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT COALESCE(manage_cutoff_hours, 0) INTO _cutoff
  FROM salon_ai_assistant WHERE salon_id = a.salon_id;
  _cutoff := COALESCE(_cutoff, 0);
  _min_at := now() + (_cutoff || ' hours')::interval;

  RETURN jsonb_build_object(
    'found', true,
    'status', a.status,
    'starts_at', a.starts_at,
    'ends_at', a.ends_at,
    'price', a.price,
    'client_first_name', split_part(btrim(COALESCE(a.client_name,'')), ' ', 1),
    'salon_name', a.salon_name,
    'salon_address', a.salon_address,
    'salon_phone', a.salon_phone,
    'timezone', a.timezone,
    'master_id', a.master_id,
    'master_name', a.master_name,
    'service_id', a.service_id,
    'service_name', a.service_name,
    'cutoff_hours', _cutoff,
    -- Earliest visit time still eligible for self-service (page disables sooner dates).
    'min_manage_at', _min_at,
    'manageable', (a.status = 'confirmed' AND a.starts_at > _min_at)
  );
END;
$$;

-- 3) Notify the salon owner (only) about a self-service change. Mirrors the net.http_post
--    pattern used by dispatch_whatsapp_appointment_change. Best-effort: never blocks the change.
CREATE OR REPLACE FUNCTION public.notify_owner_self_service(_appointment_id uuid, _kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn_url TEXT := 'https://khykprcdojksqvuqyajd.supabase.co/functions/v1/send-whatsapp';
  secret TEXT;
  wa_on BOOLEAN;
  _salon uuid;
BEGIN
  SELECT salon_id INTO _salon FROM appointments WHERE id = _appointment_id;
  IF _salon IS NULL THEN RETURN; END IF;
  SELECT whatsapp_enabled INTO wa_on FROM public.salons WHERE id = _salon;
  IF NOT COALESCE(wa_on, false) THEN RETURN; END IF;

  SELECT public.internal_get_cron_secret() INTO secret;
  IF secret IS NULL OR length(secret) = 0 THEN RETURN; END IF;

  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('appointment_id', _appointment_id, 'kind', _kind),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_owner_self_service failed for % (%): %', _appointment_id, _kind, SQLERRM;
END;
$$;

-- 4) Reschedule via token. Same master + service; only the time moves. All slot validation is
--    delegated to reschedule_appointment_v2. Errors come back as a friendly {ok:false,error}.
CREATE OR REPLACE FUNCTION public.reschedule_appointment_by_token(
  _token uuid,
  _new_starts_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id uuid; _salon uuid; _starts timestamptz; _status text; _cutoff int;
BEGIN
  SELECT ap.id, ap.salon_id, ap.starts_at, ap.status
    INTO _id, _salon, _starts, _status
  FROM appointments ap WHERE ap.manage_token = _token;
  IF _id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Запись не найдена'); END IF;
  IF _status <> 'confirmed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Эту запись уже нельзя изменить');
  END IF;

  SELECT COALESCE(manage_cutoff_hours, 0) INTO _cutoff FROM salon_ai_assistant WHERE salon_id = _salon;
  IF COALESCE(_cutoff,0) > 0 AND _starts < now() + (_cutoff || ' hours')::interval THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('Перенести можно не позднее чем за %s ч до визита. Свяжитесь с салоном.', _cutoff));
  END IF;

  BEGIN
    PERFORM public.reschedule_appointment_v2(_id, _new_starts_at, NULL);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error',
      CASE
        WHEN SQLERRM LIKE '%no longer available%' THEN 'Это время уже занято'
        WHEN SQLERRM LIKE '%past%' THEN 'Нельзя перенести на прошедшее время'
        WHEN SQLERRM LIKE 'У мастера%' THEN SQLERRM
        ELSE 'Не удалось перенести запись. Попробуйте другое время.'
      END);
  END;

  PERFORM public.notify_owner_self_service(_id, 'self_reschedule');
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 5) Cancel via token.
CREATE OR REPLACE FUNCTION public.cancel_appointment_by_token(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id uuid; _salon uuid; _starts timestamptz; _status text; _cutoff int;
BEGIN
  SELECT ap.id, ap.salon_id, ap.starts_at, ap.status
    INTO _id, _salon, _starts, _status
  FROM appointments ap WHERE ap.manage_token = _token;
  IF _id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Запись не найдена'); END IF;
  IF _status <> 'confirmed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Эта запись уже отменена или завершена');
  END IF;

  SELECT COALESCE(manage_cutoff_hours, 0) INTO _cutoff FROM salon_ai_assistant WHERE salon_id = _salon;
  IF COALESCE(_cutoff,0) > 0 AND _starts < now() + (_cutoff || ' hours')::interval THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('Отменить можно не позднее чем за %s ч до визита. Свяжитесь с салоном.', _cutoff));
  END IF;

  UPDATE appointments SET status = 'cancelled' WHERE id = _id;
  PERFORM public.notify_owner_self_service(_id, 'self_cancel');
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Access: the manage page is public (anon). These functions are the ONLY appointment surface anon
-- can touch, and only via a token they were handed. Lock down the mutating pair from PUBLIC first.
REVOKE ALL ON FUNCTION public.get_appointment_by_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reschedule_appointment_by_token(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_appointment_by_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_owner_self_service(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_appointment_by_token(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment_by_token(uuid, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_appointment_by_token(uuid) TO anon, authenticated;
-- notify_owner_self_service is internal — only the RPCs above call it (as definer). Not granted.
