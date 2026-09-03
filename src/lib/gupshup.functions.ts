// Серверные функции экрана «WhatsApp через Gupshup» в админке.
//
// ГЛАВНОЕ ОТЛИЧИЕ ОТ СОСЕДНЕГО getWaCloudConfig, и оно намеренное: отсюда ключ НЕ уходит в
// браузер. Никогда. Тот экран отдаёт токен и app secret целиком, и это его известный недостаток —
// достаточно скриншота настроек, чтобы отдать посторонним доступ к каналу салона. Здесь наружу
// идёт только маска вида `sk_4fe...e078`: её хватает, чтобы владелец узнал свой ключ и понял, что
// поле заполнено, и не хватает, чтобы им воспользоваться.
//
// Следствие для сохранения: пустое поле ключа означает «не менять», а не «стереть». Иначе первое
// же сохранение формы, куда ключ не вводили заново, обнулило бы рабочий канал.
//
// Ключ Gupshup принадлежит аккаунту Qabyl целиком, а не салону: один ключ открывает все
// приложения аккаунта, то есть переписку ВСЕХ салонов. Поэтому осторожность здесь не
// формальность.
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

function publicBaseUrl(): string {
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || "https://qabyl.com";
}

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Показать ключ так, чтобы он остался узнаваемым и остался бесполезным.
 *
 * Короткие значения маскируются целиком: у ключа в восемь символов «первые шесть и последние
 * четыре» — это сам ключ.
 */
function maskSecret(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v.length < 14) return "•".repeat(8);
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function webhookUrlFor(token: string): string {
  return `${publicBaseUrl()}/api/public/wagupshup/${token}`;
}

export const getGupshupConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    const s = (row ?? {}) as Record<string, any>;

    // Токен вебхука заводится при первом открытии экрана, а не отдельной кнопкой: поле, которое
    // надо не забыть нажать, обязательно забудут. Присваивается УСЛОВНО и перечитывается — иначе
    // на первом же рендере (React в разработке монтирует дважды) два вызова сгенерируют разные
    // токены, оба запишут, и владелец увидит один, а в базе окажется другой. Ровно эта ошибка
    // уже случалась с verify-токеном Cloud API.
    let hookToken = s.gupshup_webhook_token ?? null;
    if (!hookToken) {
      await supabaseAdmin
        .from("salon_secrets")
        .upsert({ salon_id: data.salonId } as any, { onConflict: "salon_id" });
      await supabaseAdmin
        .from("salon_secrets")
        .update({ gupshup_webhook_token: genToken() } as any)
        .eq("salon_id", data.salonId)
        .is("gupshup_webhook_token", null);
      const { data: fresh } = await supabaseAdmin
        .from("salon_secrets")
        .select("gupshup_webhook_token")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      hookToken = (fresh as any)?.gupshup_webhook_token ?? null;
    }

    return {
      app_id: (s.gupshup_app_id ?? "") as string,
      app_name: (s.gupshup_app_name ?? "") as string,
      source_number: (s.gupshup_source_number ?? "") as string,
      waba_id: (s.gupshup_waba_id ?? "") as string,
      // Ключ наружу не отдаётся — только маска и признак заполненности.
      api_key_masked: maskSecret(s.gupshup_api_key),
      has_api_key: Boolean(s.gupshup_api_key),
      enabled: Boolean(s.gupshup_enabled),
      webhook_url: hookToken ? webhookUrlFor(hookToken) : "",
      connected_at: (s.gupshup_connected_at ?? null) as string | null,
      last_event_at: (s.gupshup_last_event_at ?? null) as string | null,
      last_error: (s.gupshup_last_error ?? null) as string | null,
      last_error_at: (s.gupshup_last_error_at ?? null) as string | null,
    };
  });

export const upsertGupshupConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        app_id: z.string().max(128).nullable(),
        app_name: z.string().max(128).nullable(),
        source_number: z.string().max(32).nullable(),
        waba_id: z.string().max(64).nullable(),
        // Пусто = не менять. Стереть ключ можно только отключением канала.
        api_key: z.string().max(256).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Номер приводится к тому виду, в котором его ждёт и Gupshup, и наша сверка на вебхуке:
    // только цифры. Владелец вводит как привык — с плюсом, скобками и пробелами.
    const digits = (data.source_number ?? "").replace(/\D/g, "") || null;

    const patch: Record<string, any> = {
      salon_id: data.salonId,
      gupshup_app_id: data.app_id?.trim() || null,
      gupshup_app_name: data.app_name?.trim() || null,
      gupshup_source_number: digits,
      gupshup_waba_id: data.waba_id?.trim() || null,
    };
    const key = data.api_key?.trim();
    if (key) patch.gupshup_api_key = key;

    const { error } = await supabaseAdmin
      .from("salon_secrets")
      .upsert(patch as any, { onConflict: "salon_id" });
    if (error) {
      // Уникальный индекс на имени приложения: два салона с одним app_name означали бы, что
      // события одного уедут в переписку другого. Объясняем словами, а не кодом Postgres.
      if (/gupshup_app_uidx/i.test(error.message)) {
        throw new Error("Это имя приложения Gupshup уже занято другим салоном");
      }
      throw new Error(error.message);
    }
    return { ok: true as const };
  });

/**
 * Живая проверка реквизитов. Ходит в Gupshup, а не смотрит на заполненность полей.
 *
 * Иначе о протухшем ключе узнают по молчанию ассистента — то есть по жалобе клиента, а не по
 * красной надписи на экране.
 */
export const testGupshupConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    const s = (row ?? {}) as Record<string, any>;

    const { gupshupTestConnection } = await import("@/lib/wa-gupshup.server");
    const res = await gupshupTestConnection(
      {
        apiKey: s.gupshup_api_key ?? "",
        sourceNumber: s.gupshup_source_number ?? "",
        appName: s.gupshup_app_name ?? "",
      },
      s.gupshup_app_id ?? "",
    );

    // Результат проверки запоминается: экран должен показывать причину и после перезагрузки,
    // а не только в исчезающем всплывающем сообщении.
    await supabaseAdmin
      .from("salon_secrets")
      .update({
        gupshup_last_error: res.ok ? null : res.error,
        gupshup_last_error_at: res.ok ? null : new Date().toISOString(),
      } as any)
      .eq("salon_id", data.salonId);

    return res;
  });

/**
 * Настроить подписки Gupshup на наш вебхук. Это и есть автоматизация подключения.
 *
 * До неё подписку заводили руками в кабинете Gupshup: пять полей, на каждый салон отдельно.
 * Здесь — одна кнопка, идемпотентно, с понятным отчётом по шагам.
 */
export const syncGupshupSubscriptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    const s = (row ?? {}) as Record<string, any>;

    const hookToken = s.gupshup_webhook_token as string | null;
    if (!hookToken) throw new Error("Сначала откройте настройки заново — не создан адрес вебхука");
    if (!s.gupshup_api_key) throw new Error("Сначала заполните и сохраните API-ключ");
    if (!s.gupshup_app_id) throw new Error("Сначала заполните и сохраните App ID");

    const { gupshupSyncSubscriptions } = await import("@/lib/wa-gupshup-admin.server");
    const res = await gupshupSyncSubscriptions(
      s.gupshup_api_key,
      s.gupshup_app_id,
      webhookUrlFor(hookToken),
    );

    await supabaseAdmin
      .from("salon_secrets")
      .update({
        gupshup_last_error: res.ok
          ? null
          : (res.steps.find((x) => !x.ok)?.detail ?? "не удалось настроить подписки"),
        gupshup_last_error_at: res.ok ? null : new Date().toISOString(),
      } as any)
      .eq("salon_id", data.salonId);

    return res;
  });

/**
 * Включить или выключить канал.
 *
 * Включение проверяет реквизиты и сразу настраивает подписки — чтобы «включено» означало
 * «работает», а не «галочка стоит».
 *
 * Выключение снимает наши подписки на стороне Gupshup. Оставить их — значит продолжать получать
 * события салона, который считается отключённым. Реквизиты при этом НЕ стираются: это и есть
 * быстрый откат, к которому можно вернуться одним нажатием.
 */
export const setGupshupEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    const s = (row ?? {}) as Record<string, any>;

    if (data.enabled) {
      const missing: string[] = [];
      if (!s.gupshup_api_key) missing.push("API-ключ");
      if (!s.gupshup_app_id) missing.push("App ID");
      if (!s.gupshup_app_name) missing.push("имя приложения");
      if (!s.gupshup_source_number) missing.push("номер");
      if (missing.length) throw new Error(`Сначала заполните и сохраните: ${missing.join(", ")}`);

      await supabaseAdmin
        .from("salon_secrets")
        .update({ gupshup_enabled: true, gupshup_connected_at: new Date().toISOString() } as any)
        .eq("salon_id", data.salonId);

      const { gupshupSyncSubscriptions } = await import("@/lib/wa-gupshup-admin.server");
      const sync = await gupshupSyncSubscriptions(
        s.gupshup_api_key,
        s.gupshup_app_id,
        webhookUrlFor(s.gupshup_webhook_token),
      );
      return { ok: true as const, enabled: true, sync };
    }

    // Выключаем СНАЧАЛА в базе, и только потом снимаем подписки. Обратный порядок оставил бы
    // окно, в котором Gupshup уже не шлёт, а маршрут ещё считает салон включённым.
    await supabaseAdmin
      .from("salon_secrets")
      .update({ gupshup_enabled: false } as any)
      .eq("salon_id", data.salonId);

    let removed = 0;
    let cleanupError: string | undefined;
    if (s.gupshup_api_key && s.gupshup_app_id) {
      const { gupshupRemoveOurSubscriptions } = await import("@/lib/wa-gupshup-admin.server");
      const res = await gupshupRemoveOurSubscriptions(s.gupshup_api_key, s.gupshup_app_id);
      removed = res.removed;
      cleanupError = res.error;
    }
    return { ok: true as const, enabled: false, removed, cleanupError };
  });

/**
 * Ответ на единственный вопрос, который задают, когда «ассистент молчит»: а Gupshup вообще к нам
 * стучался?
 *
 * Новых таблиц не нужно — три исхода оставляют три разных следа:
 *   • достучался и мы приняли  → строка входящего на диалоге канала whatsapp_gupshup;
 *   • достучался и мы отказали → запись в карантине wa_webhook_events с причиной;
 *   • не достучался вовсе      → ни того, ни другого, и это всегда проблема настройки на стороне
 *     Gupshup (нет подписки, не тот адрес), а не то, что чинится у нас.
 */
export const getGupshupDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: convs } = await supabaseAdmin
      .from("wa_conversations")
      .select("id")
      .eq("salon_id", data.salonId)
      .eq("channel", "whatsapp_gupshup");
    const convIds = (convs ?? []).map((c: any) => c.id as string);

    const [inbound, outbound, quarantined, lastEvent] = await Promise.all([
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
      // «Последний ответ» должен означать ответ, который Gupshup ПРИНЯЛ. Отклонённая отправка
      // тоже пишет строку (текст владельцу пригодится), но с пустым идентификатором — считать её
      // успехом значит показать здоровый канал салону, у которого каждый ответ отбивается.
      convIds.length
        ? supabaseAdmin
            .from("wa_messages")
            .select("created_at")
            .in("conversation_id", convIds)
            .eq("direction", "out")
            .eq("kind", "text")
            .not("green_api_message_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from("wa_webhook_events" as any)
        .select("received_at, event_type, last_error")
        .eq("salon_id", data.salonId)
        .not("last_error", "is", null)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("wa_webhook_events" as any)
        .select("received_at, event_type")
        .eq("salon_id", data.salonId)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return {
      conversationCount: convIds.length,
      lastInboundAt: ((inbound as any)?.data?.created_at ?? null) as string | null,
      lastInboundText: ((inbound as any)?.data?.text_body ?? null) as string | null,
      lastOutboundAt: ((outbound as any)?.data?.created_at ?? null) as string | null,
      lastEventAt: ((lastEvent as any)?.data?.received_at ?? null) as string | null,
      lastEventType: ((lastEvent as any)?.data?.event_type ?? null) as string | null,
      lastIssueAt: ((quarantined as any)?.data?.received_at ?? null) as string | null,
      lastIssue: ((quarantined as any)?.data?.last_error ?? null) as string | null,
    };
  });
