CREATE OR REPLACE FUNCTION public.dispatch_whatsapp_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net'
AS $$
DECLARE
  fn_url TEXT := 'https://kcmxbzsjizhrierakvkj.supabase.co/functions/v1/send-whatsapp';
  secret TEXT;
  wa_on BOOLEAN;
BEGIN
  IF NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;

  SELECT whatsapp_enabled INTO wa_on
  FROM public.salons
  WHERE id = NEW.salon_id;

  IF NOT COALESCE(wa_on, false) THEN
    RETURN NEW;
  END IF;

  SELECT public.internal_get_cron_secret() INTO secret;

  IF secret IS NULL OR length(secret) = 0 THEN
    RAISE WARNING 'dispatch_whatsapp_confirmation skipped: cron secret is missing';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('appointment_id', NEW.id, 'kind', 'confirmation'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_whatsapp_confirmation failed for appointment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_push_for_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net'
AS $$
DECLARE
  fn_url TEXT := 'https://kcmxbzsjizhrierakvkj.supabase.co/functions/v1/send-push';
  secret TEXT;
BEGIN
  SELECT public.internal_get_cron_secret() INTO secret;

  IF secret IS NULL OR length(secret) = 0 THEN
    RAISE WARNING 'dispatch_push_for_notification skipped: cron secret is missing';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := fn_url,
    body := jsonb_build_object('notification_id', NEW.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_push_for_notification failed for notification %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_guard_break ON public.appointments;
CREATE TRIGGER appointments_guard_break
BEFORE INSERT OR UPDATE OF starts_at, ends_at, status, master_id ON public.appointments
FOR EACH ROW
EXECUTE FUNCTION public.guard_appointment_break();

DROP TRIGGER IF EXISTS appointments_guard_restore ON public.appointments;
CREATE TRIGGER appointments_guard_restore
BEFORE UPDATE OF status ON public.appointments
FOR EACH ROW
EXECUTE FUNCTION public.guard_appointment_restore();

DROP TRIGGER IF EXISTS appointments_notify_event ON public.appointments;
CREATE TRIGGER appointments_notify_event
AFTER INSERT OR UPDATE OF status, starts_at ON public.appointments
FOR EACH ROW
EXECUTE FUNCTION public.notify_appointment_event();

DROP TRIGGER IF EXISTS appointments_dispatch_whatsapp_ins ON public.appointments;
CREATE TRIGGER appointments_dispatch_whatsapp_ins
AFTER INSERT ON public.appointments
FOR EACH ROW
EXECUTE FUNCTION public.dispatch_whatsapp_confirmation();

DROP TRIGGER IF EXISTS appointments_dispatch_whatsapp_upd ON public.appointments;
CREATE TRIGGER appointments_dispatch_whatsapp_upd
AFTER UPDATE OF status, starts_at ON public.appointments
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.starts_at IS DISTINCT FROM NEW.starts_at)
EXECUTE FUNCTION public.dispatch_whatsapp_confirmation();

DROP TRIGGER IF EXISTS notifications_dispatch_push ON public.notifications;
CREATE TRIGGER notifications_dispatch_push
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.dispatch_push_for_notification();

DROP TRIGGER IF EXISTS salons_guard_whatsapp_enabled ON public.salons;
CREATE TRIGGER salons_guard_whatsapp_enabled
BEFORE UPDATE OF whatsapp_enabled ON public.salons
FOR EACH ROW
EXECUTE FUNCTION public.guard_salon_whatsapp_enabled();