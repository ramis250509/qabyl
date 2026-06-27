
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
    INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.created',
      'Новая запись',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
      INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
      VALUES (
        NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.cancelled',
        'Запись отменена — слот свободен',
        COALESCE(NEW.client_name,'Клиент') || ' — слот ' ||
          to_char(OLD.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI') || ' освобождён'
      );
    ELSIF NEW.status = 'confirmed' AND OLD.starts_at IS DISTINCT FROM NEW.starts_at THEN
      INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
      VALUES (
        NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.rescheduled',
        'Запись перенесена',
        COALESCE(NEW.client_name,'Клиент') || ': ' ||
          to_char(OLD.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI') || ' → ' ||
          to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI')
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
