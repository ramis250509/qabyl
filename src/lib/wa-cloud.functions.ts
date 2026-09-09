// Серверные функции за разделом WhatsApp в панели салона.
//
// ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: секреты не покидают сервер.
//
// Раньше getWaCloudConfig отдавал в браузер токен доступа и app secret — их клали в React state,
// и по ним же определялось, подключён ли салон. Токен даёт полный доступ к переписке салона и
// право слать от его имени; общий app secret платформы позволяет подделать подпись вебхука для
// ЛЮБОГО салона. Хранить их в DOM ради проверки «поле не пустое» — плохая сделка.
//
// Теперь наружу уходят только идентификаторы (они не секрет) и булевы флаги. Всё, что нужно
// решить о подключении, решается на сервере: computeWaStatus в wa-connection.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertSalonAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

/**
 * Ручной ввод реквизитов — только для владельца платформы.
 *
 * Это путь для салона, у которого своё приложение Meta: он требует понимать, что такое WABA ID,
 * системный пользователь и app secret. Владелец салона такого знать не должен и не будет — для
 * него есть кнопка. Оставлять форму всем значит гарантированно получить салон, который вписал
 * туда что-то не то и не понимает, почему молчит.
 */
async function assertSuperAdmin(supabase: any, userId: string) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden: super_admin only");
}

function publicBaseUrl(): string {
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || "https://qabyl.com";
}

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Виды сообщений, которые могут выпасть из 24-часового окна и потому требуют шаблона. */
const TEMPLATE_KINDS = [
  "confirmation",
  "reminder",
  "reschedule",
  "cancellation",
  "owner_alert",
  "owner_change",
] as const;

/**
 * Настройки канала для экрана. Ни одного секрета.
 *
 * `verify_token` и `webhook_url` — исключение только на вид: это значения, которые владелец
 * ПЕРЕНОСИТ в чужой интерфейс при ручной настройке, и без них та ветка не работает вовсе. Оба
 * бесполезны в отрыве от нашего сервера: verify-токен участвует только в GET-рукопожатии, а адрес
 * вебхука и так публичен.
 */
export const getWaCloudConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { computeWaStatus } = await import("@/lib/wa-connection.server");

    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();

    const s = (row ?? {}) as Record<string, any>;

    // Генерируется при первом открытии, а не отдельной кнопкой: при ручной настройке владелец
    // обязан вставить его в кабинет Meta, и поле, которое начинается пустым, просто забывают.
    //
    // ЗАБИРАЕТСЯ УСЛОВНО И ПЕРЕЧИТЫВАЕТСЯ. Простое «прочитать и записать» проигрывает гонку на
    // самом первом рендере: React в разработке монтирует компонент дважды, оба вызова видят NULL,
    // оба генерируют РАЗНОЕ значение и оба пишут. На экране остаётся одно, в базе другое, и
    // владелец вставляет в Meta токен, который мы никогда не примем.
    let verifyToken = s.whatsapp_cloud_verify_token ?? null;
    if (!verifyToken) {
      await supabaseAdmin
        .from("salon_secrets")
        .upsert({ salon_id: data.salonId } as any, { onConflict: "salon_id" });
      await supabaseAdmin
        .from("salon_secrets")
        .update({ whatsapp_cloud_verify_token: genToken() } as any)
        .eq("salon_id", data.salonId)
        .is("whatsapp_cloud_verify_token", null);
      const { data: fresh } = await supabaseAdmin
        .from("salon_secrets")
        .select("whatsapp_cloud_verify_token")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      verifyToken = (fresh as any)?.whatsapp_cloud_verify_token ?? null;
    }

    // Имена шаблонов не секрет — они видны в кабинете Meta и нужны экрану, чтобы объяснить, что
    // именно на модерации. Статус приходит оттуда же, из синхронизации с Meta.
    const templates = (s.whatsapp_cloud_templates ?? {}) as Record<
      string,
      { name?: string; lang?: string; status?: string; reason?: string } | undefined
    >;

    return {
      status: computeWaStatus(s as any),
      // Идентификаторы. Не секреты: сами по себе не дают ничего без токена.
      phone_number_id: (s.whatsapp_cloud_phone_number_id ?? "") as string,
      waba_id: (s.whatsapp_cloud_waba_id ?? "") as string,
      // Флаги вместо значений. Экрану нужно знать, заполнено ли поле, а не что в нём.
      has_token: Boolean(s.whatsapp_cloud_token),
      has_app_secret: Boolean(s.whatsapp_cloud_app_secret),
      connection_kind: (s.wa_connection_kind ?? null) as string | null,
      templates,
      template_kinds: TEMPLATE_KINDS as unknown as string[],
      verify_token: (verifyToken ?? "") as string,
      webhook_url: `${publicBaseUrl()}/api/public/wacloud/${data.salonId}`,
      platform_webhook_url: `${publicBaseUrl()}/api/public/wacloud`,
    };
  });

/**
 * Ручное сохранение реквизитов. Только super_admin — см. assertSuperAdmin.
 *
 * Пустая строка в токене означает «не менять», а не «стереть»: форма не показывает текущее
 * значение (его больше нет в браузере), и трактовать пустое поле как удаление значило бы стирать
 * рабочий токен каждый раз, когда кто-то поправил рядом стоящий WABA ID.
 * Для удаления есть disconnectWa.
 */
export const upsertWaCloudConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        phone_number_id: z.string().max(64).nullable(),
        token: z.string().max(1024).nullable(),
        app_secret: z.string().max(128).nullable(),
        waba_id: z.string().max(64).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    await assertSuperAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const phoneNumberId = data.phone_number_id?.trim() || null;

    // Тот же запрет, что и на пути кнопки, и по той же причине: общий вебхук ищет салон ИМЕННО по
    // номеру и с двумя совпадениями не знает, кому адресовано сообщение. Раньше эта проверка
    // стояла только в finishWaOnboarding — то есть ручной путь её обходил.
    if (phoneNumberId) {
      const { data: taken } = await supabaseAdmin
        .from("salon_secrets")
        .select("salon_id")
        .eq("whatsapp_cloud_phone_number_id", phoneNumberId)
        .neq("salon_id", data.salonId)
        .limit(1);
      if (taken && taken.length > 0) {
        throw new Error("Этот номер WhatsApp уже подключён к другому салону.");
      }
    }

    const token = data.token?.trim() || null;
    const appSecret = data.app_secret?.trim() || null;

    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        whatsapp_cloud_phone_number_id: phoneNumberId,
        whatsapp_cloud_waba_id: data.waba_id?.trim() || null,
        wa_connection_kind: "own_app",
        ...(token ? { whatsapp_cloud_token: token, wa_token_status: "unknown" } : {}),
        ...(appSecret ? { whatsapp_cloud_app_secret: appSecret } : {}),
      } as any,
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Отвечает на единственный вопрос, который важен, когда сообщение клиента осталось без ответа:
 * а Meta вообще звонила в наш вебхук?
 *
 * Новых таблиц не требует, потому что у каждого из трёх исходов свой след:
 *   • Meta позвонила и мы приняли  → входящее сообщение на диалоге whatsapp_cloud
 *   • Meta позвонила и мы отказали → запись в error_logs от источника 'wacloud-webhook'
 *   • Meta не звонила вовсе        → ни того, ни другого
 * Третий — самый частый, и он всегда про настройку на стороне Meta (поле не подписано, приложение
 * в режиме разработки, номер не добавлен), то есть никогда не чинится на нашей стороне. Это ровно
 * то, что салону и надо сказать.
 */
export const getWaCloudDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: convs } = await supabaseAdmin
      .from("wa_conversations")
      .select("id")
      .eq("salon_id", data.salonId)
      .eq("channel", "whatsapp_cloud");
    const convIds = (convs ?? []).map((c: any) => c.id as string);

    const [inbound, outbound, webhookIssue] = await Promise.all([
      convIds.length
        ? supabaseAdmin
            .from("wa_messages")
            .select("created_at, text_body")
            .in("conversation_id", convIds)
            .eq("direction", "in")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // «Последний ответ» обязан означать последний ответ, который Meta ПРИНЯЛА, а не последний,
      // который мы сочинили. У отклонённой отправки строка тоже пишется (текст нужен панели), но
      // без идентификатора сообщения — считать её успехом значит показывать здоровый канал салону,
      // у которого отбивается каждый ответ.
      convIds.length
        ? supabaseAdmin
            .from("wa_messages")
            .select("created_at, text_body")
            .in("conversation_id", convIds)
            .eq("direction", "out")
            .eq("kind", "text")
            .not("green_api_message_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from("error_logs" as any)
        .select("ts, message")
        .eq("salon_id", data.salonId)
        .eq("source", "wacloud-webhook")
        .order("ts", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return {
      conversationCount: convIds.length,
      lastInboundAt: (inbound as any)?.data?.created_at ?? null,
      lastInboundText: ((inbound as any)?.data?.text_body ?? null) as string | null,
      lastOutboundAt: (outbound as any)?.data?.created_at ?? null,
      lastWebhookIssueAt: (webhookIssue as any)?.data?.ts ?? null,
      lastWebhookIssue: ((webhookIssue as any)?.data?.message ?? null) as string | null,
    };
  });
