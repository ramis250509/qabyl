-- Поведенческие тесты записи / расписания / предоплаты.
--
-- ⚠ ЭТОТ ФАЙЛ ПИШЕТ В БАЗУ. На проде не запускать: на INSERT в appointments висит
-- триггер dispatch_whatsapp_confirmation, который реально отправляет WhatsApp.
-- Триггеры глушатся внутри транзакции, но полагаться на это как на единственную
-- защиту нельзя — поэтому вверху стоит явный предохранитель.
--
-- Запуск на ветке или в локальном стеке:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -c "SET qabyl.allow_write_tests = 'yes'" \
--     -f supabase/tests/booking_integrity.sql
--
-- Вся работа идёт в транзакции, которая в конце откатывается: после прогона в
-- базе не остаётся ни одной тестовой строки. Результат читается в NOTICE:
-- «PASS: …» / «FAIL: …», в конце — итог.

BEGIN;

DO $guard$
BEGIN
  IF current_setting('qabyl.allow_write_tests', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION
      'Отказ: тесты пишут в appointments. Запускать только на тестовой базе, задав SET qabyl.allow_write_tests = ''yes''.';
  END IF;
END
$guard$;

-- Исходящие уведомления не должны срабатывать от фикстур.
ALTER TABLE public.appointments DISABLE TRIGGER appointments_dispatch_whatsapp_ins;
ALTER TABLE public.appointments DISABLE TRIGGER dispatch_whatsapp_on_appointment_change;
ALTER TABLE public.appointments DISABLE TRIGGER appointments_notify_event;

-- ── Мини-фреймворк ──────────────────────────────────────────────────────────
CREATE TEMP TABLE _results (label text, passed boolean, detail text);

CREATE FUNCTION pg_temp.ok(_passed boolean, _label text, _detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _results VALUES (_label, COALESCE(_passed, false), _detail);
  IF COALESCE(_passed, false) THEN
    RAISE NOTICE 'PASS: %', _label;
  ELSE
    RAISE WARNING 'FAIL: % — %', _label, COALESCE(_detail, 'условие не выполнено');
  END IF;
END $$;

-- Ожидаем, что _sql упадёт, и в тексте ошибки встретится _fragment.
CREATE FUNCTION pg_temp.expect_error(_sql text, _fragment text, _label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE _sql;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ok(SQLERRM ILIKE '%' || _fragment || '%', _label,
                       format('ожидали «%s», получили «%s»', _fragment, SQLERRM));
    RETURN;
  END;
  PERFORM pg_temp.ok(false, _label, 'запрос выполнился, хотя должен был упасть');
END $$;

CREATE FUNCTION pg_temp.expect_ok(_sql text, _label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  PERFORM pg_temp.ok(true, _label);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.ok(false, _label, SQLERRM);
END $$;

-- ── Фикстуры ────────────────────────────────────────────────────────────────
-- Салон в Бишкеке. Все времена ниже считаются от «завтра 10:00 по Бишкеку»,
-- чтобы тест не зависел от того, в какой час суток его запустили.
CREATE FUNCTION pg_temp.fx() RETURNS TABLE(
  salon uuid, master uuid, master2 uuid, svc uuid, svc_buf uuid, base timestamptz
) LANGUAGE plpgsql AS $$
DECLARE
  _salon uuid; _master uuid; _master2 uuid; _svc uuid; _svc_buf uuid;
  _tz text := 'Asia/Bishkek'; _d date; _base timestamptz; _dow smallint;
BEGIN
  INSERT INTO salons(slug, name, timezone)
  VALUES ('t-' || substr(gen_random_uuid()::text, 1, 8), 'Тестовый салон', _tz)
  RETURNING id INTO _salon;

  INSERT INTO masters(salon_id, name) VALUES (_salon, 'Мастер А') RETURNING id INTO _master;
  INSERT INTO masters(salon_id, name) VALUES (_salon, 'Мастер Б') RETURNING id INTO _master2;

  -- 60 минут, без буфера.
  INSERT INTO services(salon_id, name, duration_min, price)
  VALUES (_salon, 'Маникюр', 60, 1000) RETURNING id INTO _svc;
  -- 60 минут + 30 минут уборки: проверяем, что буфер реально блокирует соседа.
  INSERT INTO services(salon_id, name, duration_min, price, buffer_after_min)
  VALUES (_salon, 'Окрашивание', 60, 3000, 30) RETURNING id INTO _svc_buf;

  INSERT INTO master_services(master_id, service_id)
  VALUES (_master, _svc), (_master, _svc_buf), (_master2, _svc);

  -- Завтрашний день, 10:00 по местному.
  _d := ((now() AT TIME ZONE _tz)::date + 1);
  _base := ((_d::text || ' 10:00')::timestamp AT TIME ZONE _tz);
  _dow := EXTRACT(DOW FROM _d)::smallint;

  -- График 09:00–18:00 на все дни недели, чтобы тест не падал по субботам.
  INSERT INTO master_schedules(master_id, weekday, start_time, end_time)
  SELECT m, w, '09:00'::time, '18:00'::time
  FROM unnest(ARRAY[_master, _master2]) m, generate_series(0, 6) w;

  RETURN QUERY SELECT _salon, _master, _master2, _svc, _svc_buf, _base;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
DO $tests$
DECLARE
  f record;
  _id uuid;
  _tz text := 'Asia/Bishkek';
  _cnt int;
BEGIN
  SELECT * INTO f FROM pg_temp.fx();

  -- ── B. ЗАПИСЬ КЛИЕНТОВ ────────────────────────────────────────────────────

  PERFORM pg_temp.expect_ok(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc, f.base, 'Клиент 1', '+996700111222'),
    'B1a первая запись создаётся');

  -- B1. Пересечение через RPC.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc, f.base + interval '30 min', 'Клиент 2', '+996700111333'),
    'no longer available', 'B1 пересечение у того же мастера отклоняется');

  -- B2. Пересечение ПРЯМЫМ INSERT (обход RPC). Держится на EXCLUDE-ограничении —
  -- единственной защите, которую нельзя обойти.
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO appointments(salon_id,master_id,service_id,client_name,client_phone,starts_at,ends_at,price,status,source)
     VALUES (%L,%L,%L,''Обход'',''+996700111444'',%L,%L,0,''confirmed'',''widget'')',
    f.salon, f.master, f.svc, f.base + interval '15 min', f.base + interval '75 min'),
    'conflict', 'B2 прямой INSERT поверх записи отклоняется ограничением');

  -- B3. Буфер после услуги.
  PERFORM pg_temp.expect_ok(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc_buf, f.base + interval '2 hours', 'Клиент 3', '+996700111555'),
    'B3a запись на услугу с буфером создаётся');
  -- Услуга 12:00–13:00 + 30 мин уборки → 13:15 занято.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc, f.base + interval '3 hours 15 min', 'Клиент 4', '+996700111666'),
    'no longer available', 'B3 буфер уборки блокирует соседний слот');

  -- B4. Холд предоплаты занимает слот как подтверждённая запись.
  SELECT create_appointment(f.salon, f.master2, f.svc, f.base + interval '5 hours',
    'Держит холд', '+996700111777', NULL, NULL, '{}'::uuid[], 'widget', NULL, NULL, 30)
  INTO _id;
  PERFORM pg_temp.ok(
    (SELECT status FROM appointments WHERE id = _id)::text = 'pending_payment',
    'B4a холд создаётся в статусе pending_payment');
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master2, f.svc, f.base + interval '5 hours', 'Перебивает', '+996700111888'),
    'no longer available', 'B4 живой холд предоплаты занимает слот');
  -- И прямой INSERT поверх холда тоже: это про потерю денег клиента,
  -- поэтому проверяется отдельно от RPC-пути.
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO appointments(salon_id,master_id,service_id,client_name,client_phone,starts_at,ends_at,price,status,source)
     VALUES (%L,%L,%L,''Обход холда'',''+996700111999'',%L,%L,0,''confirmed'',''widget'')',
    f.salon, f.master2, f.svc, f.base + interval '5 hours', f.base + interval '6 hours'),
    'conflict', 'B4b прямой INSERT поверх холда отклоняется');

  -- B5. Прошлое.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc, now() - interval '1 hour', 'Вчерашний', '+996700112000'),
    'past', 'B5 запись в прошлое отклоняется');

  -- B6. Мастер не оказывает услугу.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master2, f.svc_buf, f.base + interval '8 hours', 'Не та услуга', '+996700112111'),
    'cannot perform', 'B6 мастер без услуги отклоняется');

  -- B8. Телефон.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc, f.base + interval '9 hours', 'Короткий', '+99670'),
    'phone', 'B8 телефон короче 10 цифр отклоняется');

  -- ── S. РАСПИСАНИЕ ─────────────────────────────────────────────────────────

  -- S1. Выходной мастера.
  INSERT INTO master_day_overrides(master_id, date, kind, is_off)
  VALUES (f.master2, (f.base AT TIME ZONE _tz)::date, 'off', true);
  SELECT count(*) INTO _cnt
  FROM get_available_slots(f.master2, f.svc, (f.base AT TIME ZONE _tz)::date);
  PERFORM pg_temp.ok(_cnt = 0, 'S1 в выходной мастера слотов нет', format('получено %s', _cnt));

  -- S6 + B9/B10. Ключевая инвариантность: то, что нельзя выбрать, нельзя и записать.
  -- До миграции 20260813120000 этот тест падает — create_appointment не смотрит
  -- на график вообще.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master2, f.svc, f.base + interval '1 hour', 'В выходной', '+996700112222'),
    'выходн', 'S6 нельзя записаться на выходной мастера через виджет');

  -- Ручная запись администратора в тот же выходной — разрешена (walk-in).
  PERFORM pg_temp.expect_ok(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''manual'')',
    f.salon, f.master2, f.svc, f.base + interval '1 hour', 'Walk-in', '+996700112333'),
    'S6b администратор всё ещё может записать вручную в выходной');

  -- S2. Отпуск.
  INSERT INTO master_time_off(master_id, starts_at, ends_at)
  VALUES (f.master, f.base + interval '20 hours', f.base + interval '30 hours');
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc, f.base + interval '25 hours', 'В отпуск', '+996700112444'),
    'не работает', 'S2 нельзя записаться на время отпуска мастера');

  -- S3. Ночь вне графика 09:00–18:00.
  PERFORM pg_temp.expect_error(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master, f.svc,
    ((((f.base AT TIME ZONE _tz)::date)::text || ' 03:00')::timestamp AT TIME ZONE _tz),
    'Ночью', '+996700112555'),
    'график', 'S3 нельзя записаться в 3 часа ночи через виджет');

  -- ── P. ПРЕДОПЛАТА ─────────────────────────────────────────────────────────

  -- P5. Истёкший холд освобождает слот.
  UPDATE appointments SET hold_expires_at = now() - interval '1 minute'
   WHERE id = _id AND status = 'pending_payment';
  PERFORM prepayment_expire_holds();
  PERFORM pg_temp.ok(
    (SELECT status FROM appointments WHERE id = _id)::text = 'payment_expired',
    'P5 истёкший холд переводится в payment_expired');
  PERFORM pg_temp.expect_ok(format(
    'SELECT create_appointment(%L,%L,%L,%L,%L,%L,NULL,NULL,''{}''::uuid[],''widget'')',
    f.salon, f.master2, f.svc, f.base + interval '5 hours', 'После истечения', '+996700112666'),
    'P5b слот освобождается после истечения холда');

END
$tests$;

-- ── Итог ────────────────────────────────────────────────────────────────────
DO $summary$
DECLARE _total int; _failed int; _list text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT passed) INTO _total, _failed FROM _results;
  SELECT string_agg('  • ' || label, E'\n') INTO _list FROM _results WHERE NOT passed;
  RAISE NOTICE '─────────────────────────────────────────';
  IF _failed = 0 THEN
    RAISE NOTICE 'ИТОГ: % из % проверок пройдено.', _total, _total;
  ELSE
    RAISE NOTICE 'ИТОГ: % из % провалено:%s', _failed, _total, E'\n' || _list;
  END IF;
END
$summary$;

ROLLBACK;
