-- Инварианты схемы Qabyl — ТОЛЬКО ЧТЕНИЕ. Безопасно запускать где угодно, включая прод.
--
-- Ловит класс багов, который дороже всего: не «функция посчитала не то», а
-- «функцию/таблицу может дёрнуть тот, кому нельзя». Такие дыры не видны ни в UI,
-- ни в сценарных тестах — только в системном каталоге.
--
-- Запуск:  psql "$SUPABASE_DB_URL" -f supabase/tests/schema_invariants.sql
-- Или вставить целиком в SQL Editor Supabase.
--
-- Каждая строка результата: check | status | detail.
-- Любой status = 'FAIL' — регрессия. Ожидаемое состояние после применения
-- 20260813120000_booking_integrity_fixes.sql: все PASS.

WITH checks AS (

  -- ── A1. Приватные RPC не должны быть доступны анонимам ────────────────────
  -- confirm_prepayment принимает ТОЛЬКО appointment_id и не проверяет ничего.
  -- Клиент знает свой appointment_id (его отдаёт get_prepayment_by_token по
  -- manage_token из ссылки) → может подтвердить предоплату, ничего не заплатив.
  SELECT
    'A1 confirm_prepayment закрыт для anon/authenticated' AS check_name,
    CASE WHEN bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) THEN 'FAIL' ELSE 'PASS' END AS status,
    string_agg(r.rolname, ', ') FILTER (WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS detail
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN pg_roles r
  WHERE n.nspname = 'public' AND p.proname = 'confirm_prepayment'
    AND r.rolname IN ('anon', 'authenticated')

  UNION ALL

  -- A2. Служебная функция крона. Anon не должен уметь её запускать: каждый
  -- прогон рассылает net.http_post на qabyl.com за строку.
  SELECT
    'A2 prepayment_expire_holds закрыт для anon/authenticated',
    CASE WHEN bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) THEN 'FAIL' ELSE 'PASS' END,
    string_agg(r.rolname, ', ') FILTER (WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN pg_roles r
  WHERE n.nspname = 'public' AND p.proname = 'prepayment_expire_holds'
    AND r.rolname IN ('anon', 'authenticated')

  UNION ALL

  -- ── A3. Единственная дверь для создания записи — RPC ──────────────────────
  -- Пока существует INSERT-политика для anon, вся валидация внутри
  -- create_appointment (advisory lock, пересечения, буфер, перерывы, цена)
  -- обходится одним POST в PostgREST.
  SELECT
    'A3 нет INSERT-политики на appointments для anon',
    CASE WHEN count(*) > 0 THEN 'FAIL' ELSE 'PASS' END,
    string_agg(policyname, ', ')
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'appointments' AND cmd = 'INSERT'
    AND 'anon' = ANY (string_to_array(trim(both '{}' FROM roles::text), ','))

  UNION ALL

  -- A4. Табличный грант — второй замок к тому же. Политики нет, но грант остался →
  -- достаточно кому-то добавить политику «для отладки», и дыра открыта снова.
  SELECT
    'A4 у anon нет табличного INSERT на appointments',
    CASE WHEN count(*) > 0 THEN 'FAIL' ELSE 'PASS' END,
    string_agg(privilege_type, ', ')
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'appointments'
    AND grantee = 'anon' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')

  UNION ALL

  -- ── A5. Ограничение пересечений должно покрывать холды предоплаты ─────────
  -- Если EXCLUDE стоит только на status='confirmed', то живой холд
  -- (pending_payment) не защищён: поверх него можно создать confirmed-запись,
  -- а когда клиент оплатит — confirm_prepayment упрётся в конфликт, и человек
  -- останется без слота, но с переведёнными деньгами.
  SELECT
    'A5 appointments_no_overlap покрывает pending_payment',
    CASE WHEN bool_or(pg_get_constraintdef(oid) LIKE '%pending_payment%') THEN 'PASS' ELSE 'FAIL' END,
    string_agg(pg_get_constraintdef(oid), ' | ')
  FROM pg_constraint
  WHERE conrelid = 'public.appointments'::regclass AND conname = 'appointments_no_overlap'

  UNION ALL

  -- A6. Само ограничение обязано существовать — это последний рубеж против
  -- двойной записи, единственный, который нельзя обойти прямым INSERT.
  SELECT
    'A6 appointments_no_overlap существует',
    CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END,
    count(*)::text
  FROM pg_constraint
  WHERE conrelid = 'public.appointments'::regclass AND contype = 'x'

  UNION ALL

  -- ── A7. Перенос должен видеть холды ───────────────────────────────────────
  -- reschedule_appointment_v2 исторически искал пересечения только среди
  -- status='confirmed', тогда как create_appointment смотрит и на
  -- pending_payment. Асимметрия = перенос поверх оплачиваемого холда.
  SELECT
    'A7 reschedule_appointment_v2 учитывает pending_payment',
    CASE WHEN bool_or(pg_get_functiondef(p.oid) LIKE '%pending_payment%') THEN 'PASS' ELSE 'FAIL' END,
    NULL
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reschedule_appointment_v2'

  UNION ALL

  -- A8. Перенос должен учитывать буфер уборки, как и создание записи.
  SELECT
    'A8 reschedule_appointment_v2 учитывает buffer_after_min',
    CASE WHEN bool_or(pg_get_functiondef(p.oid) LIKE '%buffer_after_min%') THEN 'PASS' ELSE 'FAIL' END,
    NULL
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reschedule_appointment_v2'

  UNION ALL

  -- ── A9. Публичная запись обязана уважать график мастера ───────────────────
  -- get_available_slots фильтрует по master_schedules / master_day_overrides /
  -- master_time_off, а create_appointment — нет. То есть список слотов честный,
  -- но записаться можно в обход: на выходной, в отпуск, в 3 часа ночи.
  SELECT
    'A9 create_appointment проверяет master_time_off',
    CASE WHEN bool_or(pg_get_functiondef(p.oid) LIKE '%master_time_off%') THEN 'PASS' ELSE 'FAIL' END,
    NULL
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_appointment'

  UNION ALL

  SELECT
    'A10 create_appointment проверяет master_schedules',
    CASE WHEN bool_or(pg_get_functiondef(p.oid) LIKE '%master_schedules%') THEN 'PASS' ELSE 'FAIL' END,
    NULL
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_appointment'

  UNION ALL

  -- ── A11. Телефон валидируется и при UPDATE, не только при INSERT ──────────
  SELECT
    'A11 validate_appointment_phone висит на INSERT и UPDATE',
    CASE WHEN bool_or(pg_get_triggerdef(t.oid) LIKE '%UPDATE%') THEN 'PASS' ELSE 'FAIL' END,
    string_agg(pg_get_triggerdef(t.oid), ' | ')
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.appointments'::regclass
    AND t.tgname = 'validate_appointment_phone_trg'

  UNION ALL

  -- ── A12. Живые данные: пересечений быть не должно ─────────────────────────
  -- Проверка на факт, а не на схему: если тут не ноль, значит какая-то дверь
  -- уже была открыта и через неё прошли.
  SELECT
    'A12 в данных нет пересекающихся записей',
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    count(*)::text
  FROM appointments a
  JOIN appointments b
    ON a.master_id = b.master_id AND a.id < b.id
   AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  WHERE a.status IN ('confirmed', 'pending_payment')
    AND b.status IN ('confirmed', 'pending_payment')

  UNION ALL

  -- ── A13. Живые данные: телефоны ───────────────────────────────────────────
  SELECT
    'A13 у всех непортированных записей телефон 10–15 цифр',
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    count(*)::text
  FROM appointments
  WHERE source <> 'import'
    AND length(regexp_replace(COALESCE(client_phone, ''), '[^0-9]', '', 'g')) NOT BETWEEN 10 AND 15

  UNION ALL

  -- ═══ Миграция 20260813130000 (упреждение, аудит, доставка) ═══════════════

  -- ── A14. Упреждение записи ────────────────────────────────────────────────
  SELECT
    'A14 salon_ai_assistant.min_lead_minutes существует',
    CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END,
    NULL
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'salon_ai_assistant'
    AND column_name = 'min_lead_minutes'

  UNION ALL

  -- Порог обязан действовать в ОБОИХ местах. Показывать слот, но запрещать его
  -- занять (или наоборот) — ровно тот класс расхождений, который аудит и нашёл.
  SELECT
    'A15 min_lead_minutes учитывается и в слотах, и в записи',
    CASE WHEN count(*) FILTER (WHERE pg_get_functiondef(p.oid) LIKE '%min_lead_minutes%') = 2
         THEN 'PASS' ELSE 'FAIL' END,
    string_agg(p.proname, ', ') FILTER (WHERE pg_get_functiondef(p.oid) LIKE '%min_lead_minutes%')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('get_available_slots', 'assert_master_available')

  UNION ALL

  -- ── A16. Аудит-лог ────────────────────────────────────────────────────────
  SELECT
    'A16 триггер аудита записей установлен',
    CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END,
    NULL
  FROM pg_trigger
  WHERE tgrelid = 'public.appointments'::regclass AND tgname = 'appointments_audit_trg'

  UNION ALL

  -- Журнал, который можно отредактировать из браузера, журналом не является.
  SELECT
    'A17 appointment_audit доступен только на чтение',
    CASE WHEN count(*) > 0 THEN 'FAIL' ELSE 'PASS' END,
    string_agg(grantee || ':' || privilege_type, ', ')
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'appointment_audit'
    AND grantee IN ('anon', 'authenticated')
    AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')

  UNION ALL

  -- ── A18. Статус доставки подтверждения ────────────────────────────────────
  SELECT
    'A18 колонки статуса доставки на месте',
    CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL' END,
    count(*)::text
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'appointments'
    AND column_name IN ('confirmation_status', 'confirmation_detail',
                        'confirmation_at', 'confirmation_message_id')
)
SELECT check_name, status, COALESCE(detail, '') AS detail
FROM checks
ORDER BY status DESC, check_name;
