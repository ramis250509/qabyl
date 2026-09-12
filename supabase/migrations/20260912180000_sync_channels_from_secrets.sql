-- Реквизиты канала сами доезжают из salon_secrets в salon_channels.
--
-- ═══ ПОЧЕМУ ТРИГГЕР, А НЕ ПРАВКИ В КОДЕ ══════════════════════════════════
--
-- Реквизиты WhatsApp и Instagram пишутся не в одном месте, а в пяти: подключение через окно
-- Meta, подключение своим приложением, ручной ввод в форме Instagram, отключение канала и
-- обновление токена health-check'ом. Дописать «а ещё сохрани это в salon_channels» в каждое из
-- них — значит завести пять мест, где об этом можно забыть, и шестое, которое появится завтра.
--
-- Триггер работает один раз и навсегда: что бы ни записало реквизиты, таблица каналов сходится
-- сама. Код о ней не знает и знать не обязан.
--
-- ═══ ЧТО ЧЬЁ ═════════════════════════════════════════════════════════════
--
-- Разделение простое и оно тут главное:
--
--   реквизиты (токен, номер, app secret) — ТЕХНИКА, приходит от Meta, пишет система;
--   область действия (вся сеть / одна точка) — РЕШЕНИЕ ВЛАДЕЛЬЦА, пишет только он.
--
-- Поэтому триггер трогает только техническую половину строки и никогда не трогает scope и
-- branch_id. Владелец выбрал «этот номер для точки на Чуй» — переподключение номера, смена
-- токена и health-check его выбор не собьют.
--
-- ═══ ОТКЛЮЧЕНИЕ КАНАЛА ═══════════════════════════════════════════════════
--
-- Строка НЕ удаляется — очищается external_id. Причина та же: выбор области переживает
-- отключение. Салон отключил номер и подключил другой — область осталась прежней, и
-- переспрашивать владельца незачем.

create or replace function public.sync_salon_channel_from_secrets()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _wa_external text := nullif(new.whatsapp_cloud_phone_number_id, '');
  _ig_external text := nullif(new.instagram_user_id, '');
begin
  -- ── WhatsApp ──────────────────────────────────────────────────────────────
  begin
    if _wa_external is not null then
      update public.salon_channels
         set external_id = _wa_external,
             credentials = jsonb_strip_nulls(jsonb_build_object(
               'phone_number_id', new.whatsapp_cloud_phone_number_id,
               'waba_id',         new.whatsapp_cloud_waba_id,
               'token',           new.whatsapp_cloud_token,
               'app_secret',      new.whatsapp_cloud_app_secret
             )),
             is_active = true,
             updated_at = now()
       where salon_id = new.salon_id and kind = 'whatsapp';

      if not found then
        insert into public.salon_channels
          (salon_id, kind, scope, external_id, credentials, display_name)
        values (
          new.salon_id, 'whatsapp', 'salon', _wa_external,
          jsonb_strip_nulls(jsonb_build_object(
            'phone_number_id', new.whatsapp_cloud_phone_number_id,
            'waba_id',         new.whatsapp_cloud_waba_id,
            'token',           new.whatsapp_cloud_token,
            'app_secret',      new.whatsapp_cloud_app_secret
          )),
          'WhatsApp'
        );
      end if;
    else
      -- Отключили: гасим маршрутизацию, область оставляем.
      update public.salon_channels
         set external_id = null, credentials = '{}'::jsonb, updated_at = now()
       where salon_id = new.salon_id and kind = 'whatsapp' and external_id is not null;
    end if;
  exception
    -- Номер уже привязан к другому салону: уникальный индекс не пускает, и это правильно —
    -- иначе переписки двух бизнесов смешались бы. Но валить из-за этого запись реквизитов
    -- нельзя: салон останется без связи вообще. Пропускаем; канал просто не смаршрутизируется,
    -- и это видно на экране состояния.
    when unique_violation then
      raise warning 'salon_channels: номер % уже привязан к другому салону', _wa_external;
  end;

  -- ── Instagram ─────────────────────────────────────────────────────────────
  begin
    if _ig_external is not null then
      update public.salon_channels
         set external_id = _ig_external,
             credentials = jsonb_strip_nulls(jsonb_build_object(
               'instagram_user_id', new.instagram_user_id,
               'token',             new.instagram_token,
               'app_secret',        new.instagram_app_secret,
               'verify_token',      new.instagram_verify_token
             )),
             is_active = true,
             updated_at = now()
       where salon_id = new.salon_id and kind = 'instagram';

      if not found then
        insert into public.salon_channels
          (salon_id, kind, scope, external_id, credentials, display_name)
        values (
          new.salon_id, 'instagram', 'salon', _ig_external,
          jsonb_strip_nulls(jsonb_build_object(
            'instagram_user_id', new.instagram_user_id,
            'token',             new.instagram_token,
            'app_secret',        new.instagram_app_secret,
            'verify_token',      new.instagram_verify_token
          )),
          'Instagram'
        );
      end if;
    else
      update public.salon_channels
         set external_id = null, credentials = '{}'::jsonb, updated_at = now()
       where salon_id = new.salon_id and kind = 'instagram' and external_id is not null;
    end if;
  exception
    when unique_violation then
      raise warning 'salon_channels: аккаунт Instagram % уже привязан к другому салону', _ig_external;
  end;

  return new;
end;
$$;

drop trigger if exists sync_salon_channel_from_secrets_trg on public.salon_secrets;
create trigger sync_salon_channel_from_secrets_trg
  after insert or update on public.salon_secrets
  for each row execute function public.sync_salon_channel_from_secrets();

-- Догнать то, что уже подключено: триггер срабатывает на записи, а существующие строки никто
-- не переписывал. Пустое обновление заставляет его пройтись по ним один раз.
update public.salon_secrets set updated_at = updated_at
 where whatsapp_cloud_phone_number_id is not null or instagram_user_id is not null;
