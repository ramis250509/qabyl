-- У карточки уведомления не было исторического снимка: после переноса UI видел только новое
-- время, а после удаления связанной записи — вообще ничего. Храним компактный JSON snapshot
-- прямо в событии и добавляем недостающие события переноса/восстановления. Старые строки
-- остаются валидными: metadata nullable, UI догружает живую запись или показывает старое body.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE OR REPLACE FUNCTION public.notify_appointment_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _service_name text;
  _master_name text;
  _branch_name text;
  _tz text;
  _type text;
  _title text;
  _body text;
  _previous timestamptz;
BEGIN
  _tz := public.salon_local_tz(NEW.salon_id);
  SELECT name INTO _service_name FROM public.services WHERE id = NEW.service_id;
  SELECT name INTO _master_name FROM public.masters WHERE id = NEW.master_id;
  SELECT name INTO _branch_name FROM public.branches WHERE id = NEW.branch_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending_payment' OR NEW.source = 'import' THEN RETURN NEW; END IF;
    _type := 'appointment.created';
    _title := CASE WHEN NEW.status = 'confirmed' THEN 'Новая запись от клиента' ELSE 'Новая запись' END;
  ELSIF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    _type := 'appointment.cancelled'; _title := 'Запись отменена'; _previous := OLD.starts_at;
  ELSIF OLD.status = 'cancelled' AND NEW.status = 'confirmed' THEN
    _type := 'appointment.restored'; _title := 'Запись восстановлена'; _previous := OLD.starts_at;
  ELSIF OLD.status = 'confirmed' AND NEW.status = 'confirmed'
        AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.master_id IS DISTINCT FROM OLD.master_id) THEN
    _type := 'appointment.rescheduled'; _title := 'Запись перенесена'; _previous := OLD.starts_at;
  ELSIF OLD.status = 'pending_payment' AND NEW.status = 'confirmed' THEN
    _type := 'appointment.created'; _title := 'Новая запись с оплатой';
  ELSE
    RETURN NEW;
  END IF;

  _body := COALESCE(NEW.client_name, 'Клиент') || ' — ' || COALESCE(_service_name, 'услуга') ||
    ' на ' || to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI');

  INSERT INTO public.notifications
    (salon_id, branch_id, appointment_id, type, title, body, metadata)
  VALUES (
    NEW.salon_id, NEW.branch_id, NEW.id, _type, _title, _body,
    jsonb_strip_nulls(jsonb_build_object(
      'client_name', NEW.client_name,
      'client_phone', NEW.client_phone,
      'service', _service_name,
      'specialist', _master_name,
      'branch', _branch_name,
      'starts_at', NEW.starts_at,
      'status', NEW.status,
      'previous_starts_at', _previous,
      'cancelled_by', CASE WHEN _type = 'appointment.cancelled'
        THEN CASE WHEN auth.uid() IS NULL THEN 'Клиент или система' ELSE 'Сотрудник' END END
    ))
  );
  RETURN NEW;
END;
$function$;

-- Восстановление — такой же transactional update, как перенос и отмена. Оно использует тот же
-- outbound pipeline и отдельный UTILITY template; ошибка доставки не откатывает саму запись.
CREATE OR REPLACE FUNCTION public.dispatch_whatsapp_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn_url text := 'https://bfxexnpyfslfuelfkhzr.supabase.co/functions/v1/send-whatsapp';
  secret text; wa_on boolean; _kind text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN _kind := 'cancellation';
  ELSIF OLD.status = 'cancelled' AND NEW.status = 'confirmed' THEN _kind := 'restoration';
  ELSIF OLD.status = 'confirmed' AND NEW.status = 'confirmed'
    AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.master_id IS DISTINCT FROM OLD.master_id)
    THEN _kind := 'reschedule';
  ELSE RETURN NEW;
  END IF;
  IF NEW.starts_at <= now() THEN RETURN NEW; END IF;
  SELECT whatsapp_enabled INTO wa_on FROM public.salons WHERE id = NEW.salon_id;
  IF NOT COALESCE(wa_on, false) THEN RETURN NEW; END IF;
  SELECT public.internal_get_cron_secret() INTO secret;
  IF secret IS NULL OR length(secret) = 0 THEN RETURN NEW; END IF;
  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('appointment_id', NEW.id, 'kind', _kind),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_whatsapp_appointment_change failed for appointment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
