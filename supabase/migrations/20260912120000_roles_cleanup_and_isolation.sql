-- Две дыры, найденные при подготовке к запуску.
--
-- ═══ 1. Удаление салона оставляло людей с доступом в никуда ═══════════════
--
-- У user_roles.salon_id НЕ БЫЛО внешнего ключа на salons. Салон удаляли — строки ролей
-- оставались и продолжали указывать на несуществующий идентификатор. Для человека это выглядело
-- так: он заходит, useAuth видит роль salon_admin, кабинет открывается и он пустой. В мастер
-- настройки его не отправляет (роль-то есть), выйти из этого состояния нельзя ничем, кроме
-- ручной правки базы. На момент миграции таких строк в проде четыре.
--
-- CASCADE, а не SET NULL. Роль без салона бессмысленна: salon_admin без салона — это и есть тот
-- самый тупик. А доступы того же человека в ДРУГИХ салонах — отдельные строки с другим salon_id,
-- их каскад не трогает. Ровно это и требовалось: удаляя салон, не ломать аккаунт человека,
-- который состоит и в других.
--
-- branch_id тоже CASCADE. Роль мастера привязана к точке; удалили точку — область действия роли
-- исчезла. SET NULL здесь опаснее: по всему коду branch_id IS NULL означает «во всех точках»
-- (см. master_branch_id и политики notifications), то есть удаление филиала молча РАСШИРИЛО бы
-- мастеру доступ на всю сеть. Потерять доступ и переспросить владельца — поправимо; получить
-- чужой — нет.

delete from public.user_roles ur
where ur.salon_id is not null
  and not exists (select 1 from public.salons s where s.id = ur.salon_id);

delete from public.user_roles ur
where ur.branch_id is not null
  and not exists (select 1 from public.branches b where b.id = ur.branch_id);

alter table public.user_roles
  drop constraint if exists user_roles_salon_id_fkey;
alter table public.user_roles
  add constraint user_roles_salon_id_fkey
  foreign key (salon_id) references public.salons(id) on delete cascade;

alter table public.user_roles
  drop constraint if exists user_roles_branch_id_fkey;
alter table public.user_roles
  add constraint user_roles_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete cascade;

-- ═══ 2. «Мастер видит только свои записи» не работал ══════════════════════
--
-- Переключатель salons.staff_isolation существовал, политики под него были написаны — и не
-- действовали. Политики RLS складываются по ИЛИ, а позже (при починке branch_id IS NULL) рядом
-- появилась политика «Master reads scoped appointments» без проверки изоляции. Достаточно было
-- одной такой, чтобы мастер по-прежнему читал все записи филиала: в медицинской клинике это
-- утечка чужих приёмов, ради которой переключатель и заводили.
--
-- То же самое на уведомлениях: в них лежат имя клиента, услуга и время, то есть ровно то, что
-- изоляция обязана скрывать. Скрыть записи и оставить уведомления о них — не скрыть ничего.

drop policy if exists "Master reads scoped appointments" on public.appointments;
create policy "Master reads scoped appointments" on public.appointments
  for select using (
    salon_id = public.master_salon_id(auth.uid())
    and not coalesce(
      (select staff_isolation from public.salons where id = appointments.salon_id), false
    )
    and (
      (public.master_branch_id(auth.uid()) is not null and branch_id = public.master_branch_id(auth.uid()))
      or (
        public.master_branch_id(auth.uid()) is null
        and branch_id is null
        and not exists (
          select 1 from public.branches b
          where b.salon_id = appointments.salon_id and b.is_active = true
        )
      )
    )
  );

drop policy if exists "Master reads salon notifications" on public.notifications;
create policy "Master reads salon notifications" on public.notifications
  for select using (
    salon_id = public.master_salon_id(auth.uid())
    and not coalesce(
      (select staff_isolation from public.salons where id = notifications.salon_id), false
    )
    and (
      public.master_branch_id(auth.uid()) is null
      or branch_id is null
      or branch_id = public.master_branch_id(auth.uid())
    )
  );

drop policy if exists "Master updates salon notifications" on public.notifications;
create policy "Master updates salon notifications" on public.notifications
  for update using (
    salon_id = public.master_salon_id(auth.uid())
    and not coalesce(
      (select staff_isolation from public.salons where id = notifications.salon_id), false
    )
    and (
      public.master_branch_id(auth.uid()) is null
      or branch_id is null
      or branch_id = public.master_branch_id(auth.uid())
    )
  );

-- Своё мастер видит всегда, независимо от изоляции: «Master reads own appointments» и
-- «Master reads own notifications» уже существуют и остаются без изменений. Изоляция скрывает
-- чужое, а не собственную работу.

-- ═══ 3. Переключатель изоляции нельзя было ни включить, ни выключить ══════
--
-- Триггер guard_salon_staff_isolation требует, чтобы auth.uid() был владельцем салона. Серверная
-- функция setStaffIsolation писала под service-role, где auth.uid() = NULL, — и триггер честно
-- отказывал ВСЕМ, включая владельца. Наружу это выходило английской строкой
-- «Only owner (salon_admin) can change staff isolation» поверх русского интерфейса.
--
-- Сам вызов переведён на клиент пользователя (см. rbac.functions.ts), поэтому триггер остаётся в
-- силе. Здесь чинится только то, что видит человек: сообщение на его языке.
create or replace function public.guard_salon_staff_isolation()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.staff_isolation is distinct from old.staff_isolation
     and not public.has_role(auth.uid(), 'super_admin')
     and not exists (
       select 1 from public.user_roles
        where user_id = auth.uid() and role = 'salon_admin' and salon_id = new.id
     ) then
    raise exception 'Менять эту настройку может только владелец салона';
  end if;
  return new;
end;
$$;
