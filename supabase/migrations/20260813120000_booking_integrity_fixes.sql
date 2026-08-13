-- Аудит целостности записи/расписания/предоплаты, 2026-08-13.
--
-- НЕ ПРИМЕНЕНА АВТОМАТИЧЕСКИ. Сначала прогнать на ветке:
--   supabase/tests/schema_invariants.sql   (до  — 9 FAIL)
--   supabase/tests/booking_integrity.sql   (поведение RPC)
--   supabase/tests/schema_invariants.sql   (после — 0 FAIL)
--
-- Каждый блок закрывает конкретную дыру, найденную в проде. Порядок — по цене
-- ошибки для владельца салона, а не по сложности.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Предоплату нельзя подтвердить самому себе
-- ═════════════════════════════════════════════════════════════════════════════
-- confirm_prepayment(uuid) переводит запись pending_payment → confirmed и
-- обнуляет hold_expires_at. Единственный аргумент — appointment_id, никакой
-- авторизации внутри нет: она подразумевалась «функция вызывается только
-- сервером». Но EXECUTE достался anon и authenticated.
--
-- Клиент получает свой appointment_id легально: страница /manage/<token> зовёт
-- get_prepayment_by_token, тот возвращает appointment_id. Дальше один вызов
-- rpc('confirm_prepayment') из консоли браузера — и слот подтверждён без оплаты.
-- Миграция 20260801130000 сама писала «REVOKE ALL … FROM PUBLIC», то есть
-- нынешние гранты — регрессия, а не замысел.
--
-- Все легальные вызовы идут через supabaseAdmin (service_role):
--   src/lib/prepayment/process.server.ts:285
--   src/lib/prepayment.functions.ts:223
REVOKE EXECUTE ON FUNCTION public.confirm_prepayment(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.confirm_prepayment(uuid) TO service_role;

-- Служебная функция крона: за каждую истёкшую бронь шлёт net.http_post на
-- qabyl.com. Открытая для anon, она превращается в бесплатный генератор
-- исходящих запросов от имени нашей же БД.
REVOKE EXECUTE ON FUNCTION public.prepayment_expire_holds() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prepayment_expire_holds() TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Единственная дверь для создания записи — RPC
-- ═════════════════════════════════════════════════════════════════════════════
-- Политика «Anyone creates appointment» разрешала anon делать INSERT напрямую в
-- appointments. Вся защита create_appointment (advisory-lock, проверка
-- пересечений с буфером, перерывы мастера, филиал, клампы цены и длительности)
-- обходилась одним POST в PostgREST. Через эту же дверь:
--   • произвольный price → искажение выручки в статистике;
--   • произвольный client_phone + source='widget' → триггер
--     dispatch_whatsapp_confirmation отправляет WhatsApp на любой номер,
--     то есть салон становится ретранслятором спама за свой счёт;
--   • неограниченный объём строк → замусоренный календарь.
--
-- Ни один клиентский код в репозитории не пишет в appointments напрямую:
-- и виджет (PublicBooking.tsx:727), и админка (AppointmentDialogs.tsx:337)
-- зовут rpc('create_appointment'). Внутри SECURITY DEFINER права проверяются по
-- владельцу функции, поэтому снятие грантов у anon её не ломает.
DROP POLICY IF EXISTS "Anyone creates appointment" ON public.appointments;
REVOKE INSERT, UPDATE, DELETE ON public.appointments FROM anon;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Холд предоплаты защищён так же, как подтверждённая запись
-- ═════════════════════════════════════════════════════════════════════════════
-- EXCLUDE стоял только на status='confirmed'. Строка pending_payment вообще не
-- попадала в индекс, поэтому поверх оплачиваемого холда можно было создать
-- confirmed-запись. Сценарий потери денег: клиент А держит холд на 14:00 и
-- переводит предоплату; клиент Б занимает 14:00; А присылает чек →
-- confirm_prepayment пытается перевести строку в confirmed → нарушение
-- ограничения → ошибка. Деньги ушли, слота нет.
--
-- На 2026-08-13 в проде 0 пересекающихся пар (проверено A12), так что
-- расширение применяется без чистки данных.
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    master_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('confirmed', 'pending_payment'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Телефон проверяется и при изменении записи
-- ═════════════════════════════════════════════════════════════════════════════
-- Триггер висел только на INSERT: любой UPDATE мог записать мусор в
-- client_phone, после чего напоминания и подтверждения уходят в никуда.
DROP TRIGGER IF EXISTS validate_appointment_phone_trg ON public.appointments;
CREATE TRIGGER validate_appointment_phone_trg
  BEFORE INSERT OR UPDATE OF client_phone ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment_phone();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Перенос записи видит холды предоплаты
-- ═════════════════════════════════════════════════════════════════════════════
-- Асимметрия с create_appointment: тот считает занятыми ('confirmed',
-- 'pending_payment'), а перенос смотрел только на 'confirmed'. Итог — админ
-- переносит запись ровно на слот, который сейчас оплачивает другой клиент.
--
-- Заодно: при смене мастера branch_id записи оставался от прежнего мастера,
-- поэтому запись «уезжала» в чужой филиал в календаре и в правах доступа
-- мастеров (RLS у master-роли считает branch_id).
CREATE OR REPLACE FUNCTION public.reschedule_appointment_v2(
  _appointment_id uuid,
  _new_starts_at timestamp with time zone,
  _new_master_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _salon_id uuid; _master_id uuid; _service_id uuid; _status text;
  _duration int; _buffer int; _new_branch uuid;
  _ends_at timestamptz; _block_end timestamptz;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
BEGIN
  SELECT salon_id, master_id, service_id, status
    INTO _salon_id, _master_id, _service_id, _status
  FROM appointments WHERE id = _appointment_id;
  IF _salon_id IS NULL THEN RAISE EXCEPTION 'Appointment not found'; END IF;
  IF _status <> 'confirmed' THEN RAISE EXCEPTION 'Only confirmed appointments can be rescheduled'; END IF;
  IF _new_starts_at <= now() THEN RAISE EXCEPTION 'Cannot reschedule to the past'; END IF;

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

  -- Филиал всегда следует за мастером: иначе запись видна не тем людям.
  SELECT branch_id INTO _new_branch FROM masters WHERE id = _master_id;

  SELECT duration_min, COALESCE(buffer_after_min,0) INTO _duration, _buffer
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  _ends_at := _new_starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  PERFORM pg_advisory_xact_lock(hashtextextended(_master_id::text, 0));

  -- ИЗМЕНЕНО: живой холд предоплаты занимает слот наравне с подтверждённой записью.
  IF EXISTS (SELECT 1 FROM appointments
             WHERE master_id = _master_id
               AND status IN ('confirmed', 'pending_payment')
               AND id <> _appointment_id
               AND starts_at < _block_end AND ends_at > _new_starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_new_starts_at AT TIME ZONE _tz)::date,
      (_ends_at       AT TIME ZONE _tz)::date,
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

  -- Отпуск мастера: get_available_slots его учитывает, перенос — не учитывал.
  IF EXISTS (SELECT 1 FROM master_time_off
             WHERE master_id = _master_id
               AND starts_at < _block_end AND ends_at > _new_starts_at)
  THEN RAISE EXCEPTION 'Мастер не работает в это время'; END IF;

  UPDATE appointments
  SET starts_at = _new_starts_at, ends_at = _ends_at,
      master_id = _master_id, branch_id = COALESCE(_new_branch, branch_id)
  WHERE id = _appointment_id;

  RETURN _appointment_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reschedule_appointment_v2(uuid, timestamptz, uuid) TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Публичная запись уважает график мастера
-- ═════════════════════════════════════════════════════════════════════════════
-- get_available_slots честно фильтрует выходные, отпуска, перерывы и часы
-- филиала — но create_appointment ничего этого не проверяла. Список слотов был
-- рекомендацией, а не правилом: прямой вызов RPC записывал мастера на выходной,
-- в отпуск или в 3 часа ночи.
--
-- Проверка сформулирована через сам get_available_slots, а не переписыванием
-- его логики: два независимых движка расписания уже расходились однажды
-- (TS-зеркало classifyDayForService), плодить третий нельзя.
--
-- ДВА СОЗНАТЕЛЬНЫХ ИСКЛЮЧЕНИЯ:
--   • _source = 'manual' (админ из календаря) — walk-in вне графика legit,
--     это ровно то, ради чего в диалоге записи стоит выбор любого времени суток;
--   • мастер без единой строки в master_schedules и без workday-override —
--     расписание просто не заполнено. Отсутствие данных не равно «выходной»
--     (тот же принцип, что в DayVerdict='unknown'), иначе миграция мгновенно
--     положит запись у салонов, которые ещё не настроили график.
CREATE OR REPLACE FUNCTION public.assert_master_available(
  _master_id uuid, _service_id uuid, _starts_at timestamptz, _ends_at timestamptz
) RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _tz text; _date date; _has_schedule boolean;
BEGIN
  SELECT COALESCE(s.timezone,'UTC') INTO _tz
  FROM masters m JOIN salons s ON s.id = m.salon_id WHERE m.id = _master_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  _date := (_starts_at AT TIME ZONE _tz)::date;

  -- Отпуск — самая однозначная причина отказа, проверяем первой и всегда.
  IF EXISTS (SELECT 1 FROM master_time_off
             WHERE master_id = _master_id
               AND starts_at < _ends_at AND ends_at > _starts_at) THEN
    RAISE EXCEPTION 'Мастер не работает в это время (отпуск)';
  END IF;

  -- Явно проставленный выходной на эту дату.
  IF EXISTS (SELECT 1 FROM master_day_overrides
             WHERE master_id = _master_id AND date = _date
               AND (is_off OR kind = 'off')) THEN
    RAISE EXCEPTION 'У мастера выходной в этот день';
  END IF;

  -- Есть ли вообще заполненный график? Нет — судить не о чем, пропускаем.
  SELECT EXISTS (SELECT 1 FROM master_schedules WHERE master_id = _master_id)
      OR EXISTS (SELECT 1 FROM master_day_overrides
                 WHERE master_id = _master_id AND date = _date AND kind = 'workday')
    INTO _has_schedule;
  IF NOT _has_schedule THEN RETURN; END IF;

  -- Начало записи обязано совпадать с одним из слотов, которые салон реально
  -- предлагает на эту дату.
  IF NOT EXISTS (
    SELECT 1 FROM public.get_available_slots(_master_id, _service_id, _date) g
    WHERE g.slot_start = _starts_at
  ) THEN
    RAISE EXCEPTION 'Это время вне рабочего графика мастера';
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.assert_master_available(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- Врезаем вызов в create_appointment сразу после расчёта _ends_at и до вставки.
-- Полное тело переопределять не требуется — но CREATE OR REPLACE в Postgres
-- принимает только целую функцию, поэтому ниже она приведена целиком, и
-- единственное смысловое отличие от версии 20260807120000 помечено «ДОБАВЛЕНО».
CREATE OR REPLACE FUNCTION public.create_appointment(
  _salon_id uuid, _master_id uuid, _service_id uuid,
  _starts_at timestamp with time zone,
  _client_name text, _client_phone text,
  _client_notes text DEFAULT NULL::text,
  _branch_id uuid DEFAULT NULL::uuid,
  _addon_ids uuid[] DEFAULT '{}'::uuid[],
  _source text DEFAULT 'manual'::text,
  _price_override numeric DEFAULT NULL::numeric,
  _duration_override_min integer DEFAULT NULL::integer,
  _hold_minutes integer DEFAULT NULL::integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _duration int; _duration_max int; _buffer int; _price numeric;
  _price_type text; _price_max numeric;
  _final_price numeric;
  _addon_price numeric := 0;
  _ends_at timestamptz; _block_end timestamptz; _new_id uuid; _mb uuid;
  _tz text; _date date; _row record; _bstart timestamptz; _bend timestamptz;
  _status appointment_status; _hold_until timestamptz;
BEGIN
  IF length(trim(_client_name)) = 0 OR length(trim(_client_name)) > 100 THEN RAISE EXCEPTION 'Invalid client name'; END IF;
  IF length(trim(_client_phone)) < 5 OR length(trim(_client_phone)) > 20 THEN RAISE EXCEPTION 'Invalid client phone'; END IF;
  IF _source NOT IN ('manual','widget','ai_assistant') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;

  IF _hold_minutes IS NOT NULL THEN
    IF _hold_minutes < 5 OR _hold_minutes > 720 THEN
      RAISE EXCEPTION 'Hold minutes out of range';
    END IF;
    _status := 'pending_payment';
    _hold_until := now() + (_hold_minutes || ' minutes')::interval;
  ELSE
    _status := 'confirmed';
    _hold_until := NULL;
  END IF;

  SELECT duration_min, duration_max_min, price, COALESCE(buffer_after_min,0), price_type, price_max
    INTO _duration, _duration_max, _price, _buffer, _price_type, _price_max
  FROM services WHERE id = _service_id AND salon_id = _salon_id AND is_active = true;
  IF _duration IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;

  IF _duration_override_min IS NOT NULL AND _duration_max IS NOT NULL AND _duration_max > _duration THEN
    _duration := LEAST(GREATEST(_duration_override_min, _duration), _duration_max);
  END IF;

  SELECT branch_id INTO _mb FROM masters WHERE id = _master_id AND salon_id = _salon_id AND is_active = true;
  IF NOT EXISTS (SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id
                 WHERE m.id = _master_id AND m.salon_id = _salon_id AND m.is_active = true AND ms.service_id = _service_id)
  THEN RAISE EXCEPTION 'Master cannot perform this service'; END IF;
  IF _branch_id IS NOT NULL AND _mb IS NOT NULL AND _mb <> _branch_id THEN
    RAISE EXCEPTION 'Master does not work at this branch';
  END IF;

  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(price),0)
      INTO _addon_price
    FROM service_addons
    WHERE id = ANY(_addon_ids) AND salon_id = _salon_id AND is_active = true;
  END IF;

  IF _price_override IS NOT NULL THEN
    IF _price_type <> 'range' THEN
      RAISE EXCEPTION 'Price override allowed only for range-priced services';
    END IF;
    IF _price_max IS NULL OR _price_override < _price OR _price_override > _price_max THEN
      RAISE EXCEPTION 'Price override out of allowed range';
    END IF;
    _final_price := _price_override;
  ELSE
    _final_price := _price;
  END IF;

  _ends_at := _starts_at + (_duration || ' minutes')::interval;
  _block_end := _ends_at + (_buffer || ' minutes')::interval;

  IF _starts_at <= now() THEN RAISE EXCEPTION 'Cannot book in the past'; END IF;

  -- ДОБАВЛЕНО: публичные каналы обязаны попадать в реальный график мастера.
  -- Ручная запись администратора (_source='manual') намеренно не ограничена —
  -- это walk-in, владелец салона знает лучше.
  IF _source IN ('widget', 'ai_assistant') THEN
    PERFORM public.assert_master_available(_master_id, _service_id, _starts_at, _ends_at);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_master_id::text, 0));

  IF EXISTS (SELECT 1 FROM appointments WHERE master_id = _master_id
             AND status IN ('confirmed','pending_payment')
             AND starts_at < _block_end AND ends_at > _starts_at)
  THEN RAISE EXCEPTION 'Time slot is no longer available'; END IF;

  SELECT COALESCE(timezone,'UTC') INTO _tz FROM salons WHERE id = _salon_id;
  IF _tz IS NULL THEN _tz := 'UTC'; END IF;
  FOR _date IN
    SELECT d::date FROM generate_series(
      (_starts_at AT TIME ZONE _tz)::date,
      (_ends_at   AT TIME ZONE _tz)::date,
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
      IF _starts_at < _bend AND _ends_at > _bstart THEN
        RAISE EXCEPTION 'У мастера установлен перерыв с % до %',
          to_char(_bstart AT TIME ZONE _tz, 'HH24:MI'),
          to_char(_bend   AT TIME ZONE _tz, 'HH24:MI');
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO appointments(salon_id, master_id, service_id, client_name, client_phone, client_notes, starts_at, ends_at, price, branch_id, source, status, hold_expires_at)
  VALUES (_salon_id, _master_id, _service_id, trim(_client_name), trim(_client_phone), _client_notes, _starts_at, _ends_at, _final_price + _addon_price, COALESCE(_branch_id, _mb), _source, _status, _hold_until)
  RETURNING id INTO _new_id;

  IF _addon_ids IS NOT NULL AND array_length(_addon_ids, 1) > 0 THEN
    INSERT INTO appointment_addons (appointment_id, addon_id, name_snapshot, price_snapshot, duration_snapshot)
    SELECT _new_id, a.id, a.name, a.price, a.duration_min
    FROM service_addons a
    WHERE a.id = ANY(_addon_ids) AND a.salon_id = _salon_id AND a.is_active = true;
  END IF;

  RETURN _new_id;
END;
$function$;

-- Виджет и админка зовут функцию как anon/authenticated — гранты сохраняем.
GRANT EXECUTE ON FUNCTION public.create_appointment(uuid, uuid, uuid, timestamptz, text, text, text, uuid, uuid[], text, numeric, integer, integer)
  TO anon, authenticated, service_role;
