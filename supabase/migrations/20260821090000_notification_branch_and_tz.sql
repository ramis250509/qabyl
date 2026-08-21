-- ---------------------------------------------------------------------------
-- Уведомления: возврат branch_id и локального времени салона
-- ---------------------------------------------------------------------------
-- Регрессия приехала с 20260801130000_prepayment_schema.sql: там
-- notify_appointment_event() переписали целиком, потеряв две вещи, которые были
-- в функции с 20260615041620:
--
--   1. INSERT INTO notifications больше не передавал branch_id → у всех новых
--      уведомлений branch_id IS NULL. Любой читатель, который фильтрует
--      `.eq("branch_id", x)`, получает ПУСТОЙ список: в SQL NULL никогда не
--      равен значению. Салон с выбранным филиалом переставал видеть колокольчик
--      вообще — ровно то, на что пожаловался «Эркеайым» 21.08.2026.
--
--   2. Время в теле уведомления форматировалось `AT TIME ZONE 'UTC'` вместо
--      таймзоны салона. Для Asia/Bishkek (UTC+6) запись на 14:00 приезжала в
--      колокольчик как «08:00» — расхождение с календарём на 6 часов.
--
-- Обе правки восстанавливают поведение до 01.08, не трогая то, что было
-- добавлено правильно (тишина для pending_payment и для source='import').
-- ---------------------------------------------------------------------------

-- Одно место, где живёт правило «таймзона салона, а если её нет — Бишкек».
-- Совпадает с DEFAULT_TZ в src/lib/tz.ts. Колоночный default 'Europe/Moscow'
-- сюда сознательно не тянем: ни один салон в нём не работает, а молчаливый
-- сдвиг на 3 часа отлаживается ровно так же тяжело, как сдвиг на 6.
CREATE OR REPLACE FUNCTION public.salon_local_tz(_salon_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _tz text;
BEGIN
  SELECT NULLIF(btrim(timezone), '') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN RETURN 'Asia/Bishkek'; END IF;
  -- Неизвестное имя зоны роняет AT TIME ZONE, а вместе с ним и всю запись
  -- клиента. Уведомление никогда не должно стоить салону брони.
  PERFORM now() AT TIME ZONE _tz;
  RETURN _tz;
EXCEPTION WHEN OTHERS THEN
  RETURN 'Asia/Bishkek';
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_appointment_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _service_name text; _tz text;
BEGIN
  _tz := public.salon_local_tz(NEW.salon_id);

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending_payment' THEN
      RETURN NEW; -- silent while awaiting prepayment
    END IF;
    -- A bulk import is not "a new booking from a client" — one bell entry per imported row
    -- would bury every real notification the owner has.
    IF NEW.source = 'import' THEN
      RETURN NEW;
    END IF;
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.created',
      'Новая запись от клиента',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.cancelled',
      'Клиент отменил запись',
      COALESCE(NEW.client_name,'Клиент') || ' отменил(а) запись на ' ||
        to_char(OLD.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending_payment' AND NEW.status = 'confirmed' THEN
    SELECT name INTO _service_name FROM services WHERE id = NEW.service_id;
    INSERT INTO public.notifications (salon_id, branch_id, appointment_id, type, title, body)
    VALUES (
      NEW.salon_id, NEW.branch_id, NEW.id, 'appointment.created',
      'Новая запись с оплатой',
      COALESCE(NEW.client_name,'Клиент') || ' — ' || COALESCE(_service_name,'услуга') ||
        ' на ' || to_char(NEW.starts_at AT TIME ZONE _tz, 'DD.MM HH24:MI') || ' (оплачено)'
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- Историю чиним там, где источник истины ещё жив: у уведомления есть запись,
-- у записи есть филиал. Строки без appointment_id остаются NULL — это
-- законное «на весь салон», и читатели обязаны трактовать NULL именно так.
UPDATE public.notifications n
SET branch_id = a.branch_id
FROM public.appointments a
WHERE n.appointment_id = a.id
  AND n.branch_id IS NULL
  AND a.branch_id IS NOT NULL;

-- Тела уведомлений тоже чиним: время в них заморожено на момент вставки, и у
-- строк, созданных сломанной версией, оно на 6 часов расходится с календарём.
-- Пересобираем только сам штамп «DD.MM HH:MM» из живой записи. На строках,
-- созданных ДО регрессии, значение уже правильное — операция идемпотентна.
UPDATE public.notifications n
SET body = regexp_replace(
      n.body,
      '\d{2}\.\d{2} \d{2}:\d{2}',
      to_char(a.starts_at AT TIME ZONE public.salon_local_tz(n.salon_id), 'DD.MM HH24:MI')
    )
FROM public.appointments a
WHERE n.appointment_id = a.id
  AND n.body ~ '\d{2}\.\d{2} \d{2}:\d{2}';
