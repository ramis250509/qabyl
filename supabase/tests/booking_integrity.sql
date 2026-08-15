-- Поведенческие тесты записи / расписания / предоплаты.
--
-- Прогнан 2026-08-15 на полигоне в Токио: 22 пройдено, 0 провалено.
-- Именно этот набор нашёл асимметрию буфера уборки (B3b–B3d), которую не увидел
-- ни статический аудит, ни один из предыдущих проходов по коду.
--
-- ⚠ ПИШЕТ В БАЗУ. На проде не запускать: на INSERT в appointments висит триггер
-- отправки WhatsApp. Триггеры глушатся внутри транзакции, но полагаться на это
-- как на единственную защиту нельзя — поэтому вверху стоит предохранитель.
--
-- Всё выполняется в транзакции, которая гарантированно откатывается: набор
-- заканчивается RAISE EXCEPTION с итогом. Исключение и печатает результат, и
-- отменяет транзакцию — так после прогона в базе физически не может остаться
-- тестовых данных, даже если кто-то забудет ROLLBACK.
--
-- Запуск (только на тестовой базе):
--   psql "$TEST_DB_URL" -v ON_ERROR_STOP=0 \
--     -c "SET qabyl.allow_write_tests = 'yes'" \
--     -f supabase/tests/booking_integrity.sql

BEGIN;

DO $guard$
BEGIN
  IF current_setting('qabyl.allow_write_tests', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION
      'Отказ: тесты пишут в appointments. Только тестовая база, задав SET qabyl.allow_write_tests = ''yes''.';
  END IF;
END
$guard$;

ALTER TABLE public.appointments DISABLE TRIGGER appointments_dispatch_whatsapp_ins;
ALTER TABLE public.appointments DISABLE TRIGGER dispatch_whatsapp_on_appointment_change;
ALTER TABLE public.appointments DISABLE TRIGGER appointments_notify_event;

DO $t$
DECLARE
  _out text:=''; _fail int:=0; _pass int:=0;
  _salon uuid; _m1 uuid; _m2 uuid; _m3 uuid; _m4 uuid; _svc uuid; _svcbuf uuid;
  _tz text:='Asia/Bishkek'; _d date; _base timestamptz; _id uuid; _cnt int; _i int; _slot timestamptz;
BEGIN
  -- ── Фикстуры ──────────────────────────────────────────────────────────────
  -- Четыре мастера, чтобы тесты не мешали друг другу: у каждого своя тема.
  INSERT INTO salons(slug,name,timezone) VALUES ('t-'||substr(gen_random_uuid()::text,1,8),'Тест',_tz) RETURNING id INTO _salon;
  INSERT INTO masters(salon_id,name) VALUES (_salon,'А') RETURNING id INTO _m1;
  INSERT INTO masters(salon_id,name) VALUES (_salon,'Б') RETURNING id INTO _m2;
  INSERT INTO masters(salon_id,name) VALUES (_salon,'В') RETURNING id INTO _m3;
  INSERT INTO masters(salon_id,name) VALUES (_salon,'Г') RETURNING id INTO _m4;
  INSERT INTO services(salon_id,name,duration_min,price) VALUES (_salon,'Маникюр',60,1000) RETURNING id INTO _svc;
  INSERT INTO services(salon_id,name,duration_min,price,buffer_after_min) VALUES (_salon,'Окрашивание',60,3000,30) RETURNING id INTO _svcbuf;
  INSERT INTO master_services(master_id,service_id) VALUES (_m1,_svc),(_m1,_svcbuf),(_m2,_svc),(_m3,_svc),(_m4,_svc),(_m4,_svcbuf);
  _d := ((now() AT TIME ZONE _tz)::date + 1);
  _base := ((_d::text||' 10:00')::timestamp AT TIME ZONE _tz);
  INSERT INTO master_schedules(master_id,weekday,start_time,end_time)
  SELECT m,w,'09:00'::time,'20:00'::time FROM unnest(ARRAY[_m1,_m2,_m3,_m4]) m, generate_series(0,6) w;
  INSERT INTO salon_ai_assistant(salon_id) VALUES (_salon) ON CONFLICT DO NOTHING;

  -- ── B. Двойная запись ─────────────────────────────────────────────────────
  BEGIN PERFORM create_appointment(_salon,_m1,_svc,_base,'К1','+996700111222',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  PASS  B1a первая запись создаётся'; _pass:=_pass+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  FAIL  B1a: '||SQLERRM; _fail:=_fail+1; END;

  BEGIN PERFORM create_appointment(_salon,_m1,_svc,_base+interval '30 min','К2','+996700111333',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  B1 пересечение прошло'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B1 пересечение отклонено'; _pass:=_pass+1; END;

  -- Держится на EXCLUDE-ограничении — единственной защите, которую нельзя обойти.
  BEGIN INSERT INTO appointments(salon_id,master_id,service_id,client_name,client_phone,starts_at,ends_at,price,status,source)
    VALUES (_salon,_m1,_svc,'Обход','+996700111444',_base+interval '15 min',_base+interval '75 min',0,'confirmed','widget');
    _out:=_out||E'\n  FAIL  B2 прямой INSERT прошёл'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B2 прямой INSERT отклонён ограничением'; _pass:=_pass+1; END;

  -- ── B3. Буфер уборки — обе стороны ────────────────────────────────────────
  -- Ради этих четырёх проверок и стоило поднимать полигон. До 20260815120000
  -- буфер работал только при обратном порядке бронирования, то есть на практике
  -- не работал вообще, а слоты внутри уборки клиенту ещё и предлагались.
  BEGIN PERFORM create_appointment(_salon,_m4,_svcbuf,_base,'Б1','+996700115001',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  PASS  B3a окрашивание 10:00-11:00 (+30 уборки) создано'; _pass:=_pass+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  FAIL  B3a: '||SQLERRM; _fail:=_fail+1; END;
  IF EXISTS (SELECT 1 FROM get_available_slots(_m4,_svc,_d) g WHERE g.slot_start=_base+interval '75 min')
    THEN _out:=_out||E'\n  FAIL  B3b слоты ПРЕДЛАГАЮТ 11:15 внутри уборки'; _fail:=_fail+1;
    ELSE _out:=_out||E'\n  PASS  B3b слоты не предлагают 11:15 внутри уборки'; _pass:=_pass+1; END IF;
  BEGIN PERFORM create_appointment(_salon,_m4,_svc,_base+interval '75 min','Б2','+996700115002',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  B3c запись на 11:15 внутри уборки ПРОШЛА'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B3c запись на 11:15 внутри уборки отклонена'; _pass:=_pass+1; END;
  BEGIN PERFORM create_appointment(_salon,_m3,_svc,_base+interval '75 min','Б3','+996700115003',NULL,NULL,'{}'::uuid[],'widget');
    PERFORM create_appointment(_salon,_m3,_svcbuf,_base,'Б4','+996700115004',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  B3d обратный порядок пустил'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B3d обратный порядок отклонён (симметрия)'; _pass:=_pass+1; END;

  -- ── B4. Холд предоплаты занимает слот ─────────────────────────────────────
  BEGIN SELECT create_appointment(_salon,_m2,_svc,_base+interval '5 hours','Холд','+996700111777',NULL,NULL,'{}'::uuid[],'widget',NULL,NULL,30) INTO _id;
    IF (SELECT status FROM appointments WHERE id=_id)::text='pending_payment'
      THEN _out:=_out||E'\n  PASS  B4a холд в статусе pending_payment'; _pass:=_pass+1;
      ELSE _out:=_out||E'\n  FAIL  B4a неверный статус'; _fail:=_fail+1; END IF;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  FAIL  B4a: '||SQLERRM; _fail:=_fail+1; END;
  BEGIN PERFORM create_appointment(_salon,_m2,_svc,_base+interval '5 hours','Перебив','+996700111888',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  B4 холд не занял слот'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B4 холд занимает слот'; _pass:=_pass+1; END;
  -- Про потерю денег клиента: он платит, а слот тем временем занимают.
  BEGIN INSERT INTO appointments(salon_id,master_id,service_id,client_name,client_phone,starts_at,ends_at,price,status,source)
    VALUES (_salon,_m2,_svc,'ОбходХолда','+996700111999',_base+interval '5 hours',_base+interval '6 hours',0,'confirmed','widget');
    _out:=_out||E'\n  FAIL  B4b прямой INSERT поверх холда прошёл'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B4b прямой INSERT поверх холда отклонён'; _pass:=_pass+1; END;

  BEGIN PERFORM create_appointment(_salon,_m1,_svc,now()-interval '1 hour','Вчера','+996700112000',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  B5 запись в прошлое прошла'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  PASS  B5 запись в прошлое отклонена'; _pass:=_pass+1; END;

  -- ── S. Расписание ─────────────────────────────────────────────────────────
  BEGIN PERFORM create_appointment(_salon,_m1,_svc,((_d::text||' 03:00')::timestamp AT TIME ZONE _tz),'Ночь','+996700112555',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  S3 запись в 3 ночи ПРОШЛА'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%график%' THEN _out:=_out||E'\n  PASS  S3 запись в 3 ночи отклонена'; _pass:=_pass+1;
    ELSE _out:=_out||E'\n  FAIL  S3 не та причина: '||SQLERRM; _fail:=_fail+1; END IF; END;

  INSERT INTO master_day_overrides(master_id,date,kind,is_off) VALUES (_m2,_d,'off',true);
  SELECT count(*) INTO _cnt FROM get_available_slots(_m2,_svc,_d);
  IF _cnt=0 THEN _out:=_out||E'\n  PASS  S1 в выходной слотов нет'; _pass:=_pass+1;
  ELSE _out:=_out||E'\n  FAIL  S1 выдано слотов: '||_cnt; _fail:=_fail+1; END IF;
  BEGIN PERFORM create_appointment(_salon,_m2,_svc,_base+interval '1 hour','Выходной','+996700112222',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  S6 запись в выходной ПРОШЛА'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%выходн%' THEN _out:=_out||E'\n  PASS  S6 запись в выходной отклонена'; _pass:=_pass+1;
    ELSE _out:=_out||E'\n  FAIL  S6 не та причина: '||SQLERRM; _fail:=_fail+1; END IF; END;
  -- Обратная сторона: нельзя было починить дыру ценой обычной работы салона.
  BEGIN PERFORM create_appointment(_salon,_m2,_svc,_base+interval '1 hour','WalkIn','+996700112333',NULL,NULL,'{}'::uuid[],'manual');
    _out:=_out||E'\n  PASS  S6b админ вручную в выходной МОЖЕТ'; _pass:=_pass+1;
  EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  FAIL  S6b админа заблокировало: '||SQLERRM; _fail:=_fail+1; END;

  INSERT INTO master_time_off(master_id,starts_at,ends_at) VALUES (_m1,_base+interval '20 hours',_base+interval '30 hours');
  BEGIN PERFORM create_appointment(_salon,_m1,_svc,_base+interval '25 hours','Отпуск','+996700112444',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  S2 запись в отпуск ПРОШЛА'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%не работает%' THEN _out:=_out||E'\n  PASS  S2 запись в отпуск отклонена'; _pass:=_pass+1;
    ELSE _out:=_out||E'\n  FAIL  S2 не та причина: '||SQLERRM; _fail:=_fail+1; END IF; END;

  -- ── L. Упреждение записи ──────────────────────────────────────────────────
  -- Берём РЕАЛЬНЫЙ ближайший слот, а не выдуманное время: первая версия теста
  -- целилась на 25 часов вперёд при пороге 24 и «проваливалась» на исправном коде.
  SELECT min(slot_start) INTO _slot FROM get_available_slots(_m1,_svc,_d);
  IF _slot IS NULL OR _slot > now()+interval '24 hours' THEN
    _out:=_out||E'\n  SKIP  L1 ближайший слот дальше 24ч, порог не проверить';
  ELSE
    UPDATE salon_ai_assistant SET min_lead_minutes=1440 WHERE salon_id=_salon;
    IF EXISTS (SELECT 1 FROM get_available_slots(_m1,_svc,_d) g WHERE g.slot_start=_slot)
      THEN _out:=_out||E'\n  FAIL  L1a слот всё ещё предлагается'; _fail:=_fail+1;
      ELSE _out:=_out||E'\n  PASS  L1a упреждение убирает слот из выдачи'; _pass:=_pass+1; END IF;
    BEGIN PERFORM create_appointment(_salon,_m1,_svc,_slot,'Скоро','+996700114000',NULL,NULL,'{}'::uuid[],'widget');
      _out:=_out||E'\n  FAIL  L1b запись прошла вопреки упреждению'; _fail:=_fail+1;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM ILIKE '%закрывается%' THEN _out:=_out||E'\n  PASS  L1b упреждение блокирует запись'; _pass:=_pass+1;
      ELSE _out:=_out||E'\n  FAIL  L1b не та причина: '||SQLERRM; _fail:=_fail+1; END IF; END;
    BEGIN PERFORM create_appointment(_salon,_m1,_svc,_slot,'Админ','+996700114001',NULL,NULL,'{}'::uuid[],'manual');
      _out:=_out||E'\n  PASS  L1c админ вручную не ограничен упреждением'; _pass:=_pass+1;
    EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  FAIL  L1c админа заблокировало: '||SQLERRM; _fail:=_fail+1; END;
    UPDATE salon_ai_assistant SET min_lead_minutes=0 WHERE salon_id=_salon;
  END IF;

  -- ── R. Ограничение частоты ────────────────────────────────────────────────
  FOR _i IN 0..5 LOOP
    BEGIN PERFORM create_appointment(_salon,_m3,_svc,_base+((_i+3)||' hours')::interval,'Спам','+996700113000',NULL,NULL,'{}'::uuid[],'widget');
    EXCEPTION WHEN OTHERS THEN _out:=_out||E'\n  FAIL  R1 подготовка #'||_i||': '||SQLERRM; _fail:=_fail+1; END;
  END LOOP;
  BEGIN PERFORM create_appointment(_salon,_m3,_svc,_base+interval '9 hours','Спам7','+996700113000',NULL,NULL,'{}'::uuid[],'widget');
    _out:=_out||E'\n  FAIL  R1 седьмая запись с номера ПРОШЛА'; _fail:=_fail+1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%много записей%' THEN _out:=_out||E'\n  PASS  R1 седьмая запись с номера отклонена'; _pass:=_pass+1;
    ELSE _out:=_out||E'\n  FAIL  R1 не та причина: '||SQLERRM; _fail:=_fail+1; END IF; END;

  -- ── P. Предоплата ─────────────────────────────────────────────────────────
  UPDATE appointments SET hold_expires_at=now()-interval '1 minute' WHERE status='pending_payment';
  PERFORM prepayment_expire_holds();
  IF (SELECT status FROM appointments WHERE id=_id)::text='payment_expired'
    THEN _out:=_out||E'\n  PASS  P5 истёкший холд → payment_expired'; _pass:=_pass+1;
    ELSE _out:=_out||E'\n  FAIL  P5 статус: '||(SELECT status FROM appointments WHERE id=_id)::text; _fail:=_fail+1; END IF;

  SELECT count(*) INTO _cnt FROM appointment_audit WHERE salon_id=_salon;
  IF _cnt>0 THEN _out:=_out||E'\n  PASS  AUDIT журнал пишется ('||_cnt||' записей)'; _pass:=_pass+1;
  ELSE _out:=_out||E'\n  FAIL  AUDIT журнал пуст'; _fail:=_fail+1; END IF;

  -- Исключение печатает итог И откатывает всё, что натворили фикстуры.
  RAISE EXCEPTION E'РЕЗУЛЬТАТ: % пройдено, % провалено.%', _pass, _fail, _out;
END $t$;

ROLLBACK;
