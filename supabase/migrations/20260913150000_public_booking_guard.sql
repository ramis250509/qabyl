-- Публичная запись больше не обходит график мастера и лимит частоты. Аудит 13.09.2026.
--
-- ЧТО БЫЛО СЛОМАНО. create_appointment открыта для anon (её зовёт страница /book/<slug>), а
-- параметр _source по умолчанию = 'manual'. Страница записи _source не передаёт, значит каждая
-- онлайн-запись считалась «ручной записью администратора», а для ручной записи функция:
--   • не вызывает assert_master_available — ни рабочего графика, ни выходного, ни отпуска,
--     ни «запись закрывается за N минут»;
--   • не проходит guard_appointment_rate_limit — лимит «6 записей с номера / 60 на салон в час»
--     действует только для 'widget' и 'ai_assistant'.
-- На странице это не видно: интерфейс показывает только свободные окна. Но любой, кто позовёт
-- /rest/v1/rpc/create_appointment напрямую с публичным ключом, мог без ограничений забить
-- календарь любого салона фейковыми записями — в ночь, в выходной мастера, сотнями.
-- Тем же путём _hold_minutes ставил «ожидает предоплаты» и держал окно до 12 часов без оплаты,
-- и тем же путём сотрудник салона А мог создавать записи в салоне Б.
--
-- ЧТО ТЕПЕРЬ. Триггер BEFORE INSERT смотрит, КТО вставляет. Если это запрос через публичный API
-- (роль anon или authenticated) и человек не сотрудник этого салона, запись считается онлайн-
-- записью: source = 'widget', без удержания под предоплату, с проверкой графика. Имя триггера
-- начинается с «appointments_aa_», поэтому он срабатывает раньше лимита частоты
-- (appointments_rate_limit_trg) — тот видит уже исправленный source.
--
-- ЧТО НЕ ЗАТРОНУТО.
--   • Ассистент, импорт расписания, cron и серверные функции ходят service-role — для них
--     auth.role() = 'service_role', триггер ничего не делает.
--   • Владелец, администратор и мастер своего салона создают записи как раньше: 'manual' без
--     проверки графика (у них есть право записать клиента вне сетки).
--   • Прямое подключение к базе (psql, SQL-редактор, supabase/tests/*.sql) — claims нет,
--     auth.role() = NULL, триггер пропускает.

create or replace function public.guard_public_appointment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _uid uuid := auth.uid();
  _is_staff boolean;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  _is_staff := _uid is not null and (
       public.has_salon_access(_uid, new.salon_id)
    or public.user_manager_salon_id(_uid) = new.salon_id
    or public.master_salon_id(_uid) = new.salon_id
  );
  if _is_staff then
    return new;
  end if;

  new.source := 'widget';
  if new.status is distinct from 'confirmed'::appointment_status or new.hold_expires_at is not null then
    raise exception 'Онлайн-запись не может ставить удержание под предоплату'
      using errcode = '42501';
  end if;

  perform public.assert_master_available(new.master_id, new.service_id, new.starts_at, new.ends_at);
  return new;
end;
$$;

revoke all on function public.guard_public_appointment_insert() from public, anon, authenticated;

drop trigger if exists appointments_aa_public_guard on public.appointments;
create trigger appointments_aa_public_guard
  before insert on public.appointments
  for each row execute function public.guard_public_appointment_insert();

-- Служебные функции, которые наружу открывать незачем. Все их зовут cron (роль postgres) или
-- сервер (service_role) — отзыв у anon/authenticated их не задевает.
--   wa_run_reconciliation   — снимала ai_paused с переписок, где ответил человек: любой аноним
--                             мог вернуть ИИ в разговор, который администратор забрал себе.
--   notify_owner_self_service — дёргает отправку WhatsApp по id записи.
--   prune_error_logs / prune_rate_limit_counters / archive_old_appointments — чистка по cron.
--   create_appointment_with_prepayment — зовёт только ассистент через service-role; снаружи
--                             давала удержание слота под предоплату без оплаты.
revoke execute on function public.wa_run_reconciliation() from public, anon, authenticated;
revoke execute on function public.notify_owner_self_service(uuid, text) from public, anon, authenticated;
revoke execute on function public.prune_error_logs() from public, anon, authenticated;
revoke execute on function public.prune_rate_limit_counters() from public, anon, authenticated;
revoke execute on function public.archive_old_appointments() from public, anon, authenticated;
revoke execute on function public.create_appointment_with_prepayment(
  uuid, uuid, uuid, timestamptz, text, text, text, uuid, uuid[], text, numeric, integer
) from public, anon, authenticated;

-- Две служебные функции без закреплённого search_path (замечание советника Supabase).
alter function public.touch_excluded_contacts_updated_at() set search_path = public;
alter function public.touch_instagram_comment_triggers_updated_at() set search_path = public;

-- Замок разговора не продлевался. chat-lock.server.ts раз в 45 с зовёт wa_try_acquire_lock со
-- СВОИМ lock_id, чтобы продлить замок на время долгого хода ассистента, и комментарий там говорит
-- «succeeds when ... OR already ours». Функция же брала замок только свободный или истёкший — своё
-- продление всегда получало false. Ход дольше 180 с (три итерации слива очереди с повторными
-- проходами модели) терял замок, и stillHoldingConversationLock выбрасывал готовый ответ клиенту.
create or replace function public.wa_try_acquire_lock(
  _conversation_id uuid,
  _lock_id uuid,
  _ttl_seconds integer default 25
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  _ok int;
begin
  update public.wa_conversations
     set processing_lock_id = _lock_id,
         processing_lock_until = now() + make_interval(secs => _ttl_seconds)
   where id = _conversation_id
     and (processing_lock_until is null
          or processing_lock_until < now()
          or processing_lock_id = _lock_id);
  get diagnostics _ok = row_count;
  return _ok > 0;
end;
$$;
revoke all on function public.wa_try_acquire_lock(uuid, uuid, integer) from public, anon, authenticated;

-- ОТКАТ:
--   drop trigger appointments_aa_public_guard on public.appointments;
--   grant execute on function public.<имя>(...) to anon, authenticated;
