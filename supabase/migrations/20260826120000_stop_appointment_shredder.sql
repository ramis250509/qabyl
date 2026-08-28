-- Остановить уничтожение записей и вернуть уже удалённые.
--
-- ЧТО БЫЛО. Миграция 20260611172833 завела archive_old_appointments(): она делала
-- DELETE ... RETURNING по всему, что закончилось больше 7 дней назад, и складывала строки
-- в один jsonb_agg на салон в appointment_archives. Ночной cron гонял её каждый день в 03:00 UTC.
--
-- Читателя у архива не написали никогда — на 2026-08-26 во всём src/ нет ни одного обращения
-- к appointment_archives, кроме сгенерированного типа. А статистика (src/routes/admin/stats.tsx)
-- считает выручку, конверсию и no-show прямо из appointments. То есть salon-owner видел не
-- «данные за неделю», а «мало клиентов»: потеря не выглядела как ошибка.
--
-- К моменту остановки в appointments оставалось 4 строки, в архиве — 128 за 23.07–18.08.
--
-- ПОЧЕМУ НЕ ПРОСТО «TTL 7 → 90 дней». При текущем объёме (~130 записей в месяц на 5 салонов)
-- удаление решает несуществующую проблему хранения ценой всей исторической аналитики.
-- Записи теперь не удаляются вообще; для ошибочных строк добавлен deleted_at.

-- 1) Снять cron -------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'archive-old-appointments-daily') THEN
    PERFORM cron.unschedule('archive-old-appointments-daily');
  END IF;
END $$;

-- 2) Обезвредить саму функцию -----------------------------------------------------------------
-- Не дропаем: на неё могут ссылаться внешние вызовы, и тихий no-op безопаснее, чем
-- «function does not exist» посреди чужого скрипта.
CREATE OR REPLACE FUNCTION public.archive_old_appointments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE NOTICE 'archive_old_appointments() отключена: записи больше не удаляются (см. миграцию 20260826120000)';
  RETURN 0;
END;
$$;

COMMENT ON FUNCTION public.archive_old_appointments() IS
  'Отключена 2026-08-26. Раньше удаляла записи старше 7 дней и уничтожила историю за июль-август. '
  'Оставлена как no-op ради обратной совместимости вызовов.';

COMMENT ON TABLE public.appointment_archives IS
  'Исторический артефакт удалявшего архиватора. С 2026-08-26 не пополняется. '
  'НЕ УДАЛЯТЬ: это единственная резервная копия строк, восстановленных миграцией 20260826120000.';

-- 3) Soft-delete вместо hard-delete ------------------------------------------------------------
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.appointments.deleted_at IS
  'Мягкое удаление. Записи из appointments не удаляются физически — аналитика зависит от полной истории.';

CREATE INDEX IF NOT EXISTS appointments_live_idx
  ON public.appointments (salon_id, starts_at)
  WHERE deleted_at IS NULL;

-- 4) Восстановление ---------------------------------------------------------------------------
DO $$
DECLARE
  _candidates int;
  _inserted   int;
  _relinked   int;
  _skipped    int;
BEGIN
  CREATE TEMP TABLE _restore ON COMMIT DROP AS
  WITH unpacked AS (
    SELECT a.salon_id, jsonb_array_elements(a.data) AS r
    FROM public.appointment_archives a
  )
  SELECT
    (r->>'id')::uuid                                   AS id,
    unpacked.salon_id                                  AS salon_id,
    (r->>'master_id')::uuid                            AS master_id,
    (r->>'service_id')::uuid                           AS service_id,
    NULLIF(r->>'branch_id', '')::uuid                  AS branch_id,
    r->>'client_name'                                  AS client_name,
    r->>'client_phone'                                 AS client_phone,
    r->>'client_notes'                                 AS client_notes,
    (r->>'starts_at')::timestamptz                     AS starts_at,
    (r->>'ends_at')::timestamptz                       AS ends_at,
    COALESCE((r->>'price')::numeric, 0)                AS price,
    (r->>'status')::public.appointment_status          AS status,
    (r->>'created_at')::timestamptz                    AS created_at,
    NULL::text                                         AS source
  FROM unpacked
  -- master_id → ON DELETE CASCADE, service_id → ON DELETE RESTRICT: строки, чьи мастер или
  -- услуга уже удалены, вставить физически нельзя. Они остаются в архиве (на 26.08 — ровно одна).
  WHERE (r->>'master_id')::uuid IN (SELECT id FROM public.masters)
    AND (r->>'service_id')::uuid IN (SELECT id FROM public.services)
    AND (r->>'id')::uuid NOT IN (SELECT id FROM public.appointments);

  SELECT count(*) INTO _candidates FROM _restore;

  -- Атрибуция ИИ. Архив не сохранял source, а stats.tsx и ops_salon_overview считают записи
  -- ассистента именно по source='ai_assistant'. Восстанавливаем её точно, а не эвристикой:
  -- wa_conversations.appointment_id проставляется ТОЛЬКО из result.appointmentId, то есть когда
  -- запись создал сам агент (src/routes/api/public/wa.$salonId.ts:1147, ig.$salonId.ts:1546).
  -- Архиватор обнулил эти ссылки каскадом, но last_appointment_at остался — по нему и телефону
  -- пара восстанавливается однозначно (проверено: 15 пар, 15 разных диалогов, 0 неоднозначных).
  UPDATE _restore t
     SET source = 'ai_assistant'
    FROM public.wa_conversations c
   WHERE c.appointment_id IS NULL
     AND c.last_appointment_at IS NOT NULL
     AND c.salon_id = t.salon_id
     AND regexp_replace(COALESCE(c.client_phone, ''), '[^0-9]', '', 'g')
       = regexp_replace(COALESCE(t.client_phone, ''), '[^0-9]', '', 'g')
     AND abs(extract(epoch FROM (c.last_appointment_at - t.created_at))) < 300;

  -- Остальным — честное 'restore'. Настоящий канал (widget/manual) невосстановим, и подставлять
  -- правдоподобный по умолчанию значит испортить атрибуцию тише, чем её потерять.
  UPDATE _restore SET source = 'restore' WHERE source IS NULL;

  -- На appointments висят триггеры, которые считают INSERT новой записью клиента:
  --   appointments_dispatch_whatsapp_ins → шлёт клиенту WhatsApp-подтверждение
  --   appointments_notify_event          → кладёт запись в колокольчик владельцу
  --   appointments_rate_limit_trg        → рубит массовую вставку по лимиту на телефон
  --   appointments_guard_break           → проверяет график мастера на сегодняшних правилах
  -- Без отключения восстановление разослало бы 34 реальных WhatsApp живым людям про записи,
  -- которые прошли месяц назад. source='restore' здесь не спасает: от WhatsApp-триггера
  -- освобождены только 'ai_assistant' и 'import'.
  ALTER TABLE public.appointments DISABLE TRIGGER USER;

  INSERT INTO public.appointments (
    id, salon_id, master_id, service_id, branch_id,
    client_name, client_phone, client_notes,
    starts_at, ends_at, price, status,
    created_at, updated_at, source, reminder_sent, confirmation_status
  )
  SELECT
    id, salon_id, master_id, service_id, branch_id,
    client_name, client_phone, client_notes,
    starts_at, ends_at, price, status,
    created_at, now(), source,
    true,        -- напоминание отправлять не надо: всё это прошедшие даты
    'skipped'    -- подтверждение тоже уже неактуально
  FROM _restore;

  GET DIAGNOSTICS _inserted = ROW_COUNT;

  ALTER TABLE public.appointments ENABLE TRIGGER USER;

  IF _inserted <> _candidates THEN
    RAISE EXCEPTION 'Восстановление: ожидалось % строк, вставлено %', _candidates, _inserted;
  END IF;

  -- Вернуть связь «диалог → запись»: без неё конверсия из переписки в запись не считается.
  UPDATE public.wa_conversations c
     SET appointment_id = t.id
    FROM _restore t
   WHERE c.appointment_id IS NULL
     AND c.last_appointment_at IS NOT NULL
     AND c.salon_id = t.salon_id
     AND regexp_replace(COALESCE(c.client_phone, ''), '[^0-9]', '', 'g')
       = regexp_replace(COALESCE(t.client_phone, ''), '[^0-9]', '', 'g')
     AND abs(extract(epoch FROM (c.last_appointment_at - t.created_at))) < 300;

  GET DIAGNOSTICS _relinked = ROW_COUNT;

  SELECT count(*) INTO _skipped
  FROM (SELECT jsonb_array_elements(data) FROM public.appointment_archives) x;
  _skipped := _skipped - _inserted;

  RAISE NOTICE 'Восстановлено записей: %; связей диалог→запись: %; осталось в архиве (битые FK): %',
    _inserted, _relinked, _skipped;
END $$;
