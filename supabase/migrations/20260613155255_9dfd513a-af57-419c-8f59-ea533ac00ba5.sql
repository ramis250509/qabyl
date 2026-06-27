CREATE OR REPLACE FUNCTION public.notify_appointment_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _service_name text; _tz text;
BEGIN
  SELECT COALESCE(timezone, 'UTC') INTO _tz FROM salons WHERE id = NEW.salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.created',
      'Новая запись от клиента',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    INSERT INTO public.notifications (salon_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.id, 'appointment.cancelled',
      'Клиент отменил запись',
      COALESCE(NEW.client_name,'Клиент') || ' отменил(а) запись'
    );
  END IF;
  RETURN NEW;
END;
$function$;