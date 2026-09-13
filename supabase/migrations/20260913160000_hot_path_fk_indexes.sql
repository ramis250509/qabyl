-- Индексы под внешние ключи на горячих путях записи и проверки прав. Аудит 13.09.2026.
--
-- ЗАЧЕМ. Советник производительности Supabase показал 21 внешний ключ без покрывающего индекса.
-- Большинство — на служебных журналах, где это не важно. Эти — нет:
--   • master_time_off.master_id    — читается в get_available_slots на КАЖДЫЙ 15-минутный слот и в
--                                    create_appointment / reschedule_appointment_v2;
--   • master_services.service_id   — «кто делает услугу», каждый ход ассистента и страница записи;
--   • appointments.service_id      — буфер уборки чужой записи в проверке пересечений;
--   • branches.salon_id            — список точек салона на каждой странице кабинета и записи;
--   • user_roles.salon_id          — has_salon_access() внутри RLS почти каждой таблицы;
--   • notifications.appointment_id — политика «мастер видит уведомления своих записей»;
--   • wa_conversations.appointment_id — удаление/архив записи проверяет ссылку.
-- Пока салонов три, это незаметно. На сотне салонов это полные сканы в самом частом запросе.
--
-- Индексы создаются CONCURRENTLY: таблицы не блокируются на запись. Поэтому миграция не должна
-- выполняться внутри транзакции — применять по одной команде (SQL Editor / psql), не через
-- apply_migration, который оборачивает всё в транзакцию.

create index concurrently if not exists master_time_off_master_time_idx
  on public.master_time_off (master_id, starts_at);

create index concurrently if not exists master_services_service_id_idx
  on public.master_services (service_id);

create index concurrently if not exists appointments_service_id_idx
  on public.appointments (service_id);

create index concurrently if not exists branches_salon_id_idx
  on public.branches (salon_id);

create index concurrently if not exists user_roles_salon_id_idx
  on public.user_roles (salon_id);

create index concurrently if not exists notifications_appointment_id_idx
  on public.notifications (appointment_id);

create index concurrently if not exists wa_conversations_appointment_id_idx
  on public.wa_conversations (appointment_id);

-- Дубликат: salons_slug_key (из UNIQUE-ограничения) и salons_slug_unique_idx одинаковые.
-- Ограничение оставляем, лишний индекс убираем — каждая запись в salons платит за оба.
drop index concurrently if exists public.salons_slug_unique_idx;

-- ОТКАТ: drop index concurrently if exists <имя>; для каждого индекса выше.
