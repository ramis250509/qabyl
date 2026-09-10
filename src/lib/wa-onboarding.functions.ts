// Серверные функции за кнопкой «Подключить WhatsApp» в панели салона.
//
// Тонкие по замыслу: права и запись в базу здесь, весь разговор с Graph API — в
// wa-onboarding.server.ts, состояние канала — в wa-connection.server.ts. Так подключение можно
// менять и проверять отдельно от того, кому и что мы разрешаем.
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

/** Шестизначный PIN двухфакторной защиты номера. Салон его не видит и не вводит. */
function genPin(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return String(100000 + (((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 900000));
}

/**
 * Не отдан ли этот номер или аккаунт другому салону.
 *
 * Проверяется ДО обмена кода, потому что после обмена мы уже потратили одноразовый код и время
 * владельца. В базе стоит уникальный индекс на номер — он последнее слово, а эта проверка нужна
 * для того, чтобы вместо «duplicate key value violates unique constraint» владелец услышал
 * причину и понял, что делать.
 */
async function assertNotTakenByAnotherSalon(
  supabaseAdmin: any,
  salonId: string,
  phoneNumberId: string,
) {
  const { data: taken } = await supabaseAdmin
    .from("salon_secrets")
    .select("salon_id")
    .eq("whatsapp_cloud_phone_number_id", phoneNumberId)
    .neq("salon_id", salonId)
    .limit(1);
  if (taken && taken.length > 0) {
    throw new Error(
      "Этот номер WhatsApp уже подключён к другому салону. Отключите его там или подключите сюда другой номер.",
    );
  }
}

/**
 * Завершает подключение салона после того, как владелец прошёл окно Embedded Signup.
 *
 * Браузер приносит три вещи: одноразовый код, WABA ID и Phone Number ID. Дальше всё делается на
 * сервере, потому что в обмене кода участвует app secret.
 *
 * ПОРЯДОК ШАГОВ НЕ СЛУЧАЕН.
 *   • Занятость номера — первой: она отменяет подключение целиком, и узнать об этом до того, как
 *     сгорел одноразовый код, дешевле.
 *   • Токен — второй и единственный, чья неудача обрывает всё: без него остальные шаги не имеют
 *     смысла.
 *   • Подписка на вебхуки — РАНЬШЕ сохранения. Салон, попавший в базу без подписки, выглядит
 *     подключённым и молчит; это худшее из состояний, потому что оно не выглядит поломкой.
 *   • Регистрация номера и шаблоны — не критичны в момент нажатия: номер из coexistence уже
 *     зарегистрирован, а шаблоны нужны только вне 24-часового окна. Их неудачи возвращаются
 *     владельцу списком, но подключение не отменяют.
 *
 * ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕ ПРОИСХОДИТ. Раньше в строку салона записывался META_APP_SECRET — секрет
 * ПЛАТФОРМЫ, одинаковый для всех. Он там не нужен: общий вебхук берёт его из окружения, а
 * пер-салонный секрет имеет смысл только у салона со своим приложением Meta. Копия секрета в
 * каждой строке означала лишь, что он утекал в браузер вместе с остальной конфигурацией.
 */
export const finishWaOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        code: z.string().min(10).max(1024),
        wabaId: z.string().min(1).max(64),
        // В Phone Number First flow (ES v4) при coexistence Meta может вернуть только waba_id.
        phoneNumberId: z.string().min(1).max(64).optional(),
        // Салон прошёл вариант coexistence: номер остаётся в приложении WhatsApp Business. От этого
        // зависит, каким вызовом привязывать аккаунт к кредитной линии YCloud.
        coexistence: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);

    const {
      exchangeCodeForToken,
      subscribeAppToWaba,
      registerPhoneNumber,
      createNotificationTemplates,
    } = await import("@/lib/wa-onboarding.server");
    const { refreshWaConnection, logOnboardingEvent, computeWaStatus } =
      await import("@/lib/wa-connection.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Одна попытка — один идентификатор на все её шаги. Без него события двух попыток подряд
    // склеиваются в кашу, а именно две попытки подряд и бывают, когда что-то не работает.
    const attemptId = crypto.randomUUID();
    const steps: { step: string; ok: boolean; detail?: string }[] = [];

    const record = async (s: { step: string; ok: boolean; detail?: string }, details?: unknown) => {
      steps.push(s);
      await logOnboardingEvent(data.salonId, attemptId, { ...s, details });
    };

    await record({ step: "start", ok: true });

    if (data.phoneNumberId) {
      await assertNotTakenByAnotherSalon(supabaseAdmin, data.salonId, data.phoneNumberId);
    }

    const exchanged = await exchangeCodeForToken(data.code);
    if (!exchanged.ok) {
      await record({ step: "token", ok: false, detail: exchanged.error });
      throw new Error(`Не удалось завершить подключение: ${exchanged.error}`);
    }
    await record({ step: "token", ok: true });

    // Phone Number First (ES v4): при coexistence Meta может вернуть только waba_id. Номер тогда
    // берём из самой WABA — у только что подключённого салона он там один. Без этого подключение
    // обрывалось бы на клиенте, а одноразовый код сгорал бы.
    let phoneNumberId = data.phoneNumberId ?? "";
    if (!phoneNumberId) {
      const { graphCall } = await import("@/lib/meta-graph.server");
      const list = await graphCall<{ data?: { id: string }[] }>(
        `${encodeURIComponent(data.wabaId)}/phone_numbers`,
        { token: exchanged.token, query: { fields: "id,display_phone_number,platform_type" } },
      );
      phoneNumberId = list.ok ? String(list.data?.data?.[0]?.id ?? "") : "";
      await record({
        step: "resolve-phone",
        ok: Boolean(phoneNumberId),
        detail: phoneNumberId ? undefined : "номер в аккаунте WhatsApp не найден",
      });
      if (!phoneNumberId) {
        throw new Error("Meta не вернула номер телефона. Попробуйте подключить ещё раз.");
      }
      await assertNotTakenByAnotherSalon(supabaseAdmin, data.salonId, phoneNumberId);
    }

    await record(await subscribeAppToWaba(data.wabaId, exchanged.token));
    // Coexistence определяем по самому номеру, а не только по событию окна. В Phone Number First
    // flow (ES v4) coexistence запускается автоматически по введённому номеру, и полагаться на то,
    // что событие называется FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING, нельзя. is_on_biz_app = true
    // значит, что номер живёт и в приложении WhatsApp Business, и в Cloud API.
    let coexistence = Boolean(data.coexistence);
    {
      const { graphCall } = await import("@/lib/meta-graph.server");
      const info = await graphCall<{ is_on_biz_app?: boolean; platform_type?: string }>(
        encodeURIComponent(phoneNumberId),
        { token: exchanged.token, query: { fields: "is_on_biz_app,platform_type" } },
      );
      if (info.ok && info.data?.is_on_biz_app === true) coexistence = true;
      await record(
        { step: "detect-coexistence", ok: info.ok, detail: coexistence ? "coexistence" : "cloud" },
        info.ok ? info.data : { error: info.error.message },
      );
    }

    // Номер из coexistence уже зарегистрирован в Cloud API — Meta прямо велит пропустить регистрацию.
    if (!coexistence) {
      await record(await registerPhoneNumber(phoneNumberId, exchanged.token, genPin()));
    }

    const { steps: tplSteps, templates } = await createNotificationTemplates(
      data.wabaId,
      exchanged.token,
    );
    for (const s of tplSteps) await record(s);

    const { error: saveErr } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        whatsapp_cloud_waba_id: data.wabaId,
        whatsapp_cloud_phone_number_id: phoneNumberId,
        whatsapp_cloud_token: exchanged.token,
        whatsapp_cloud_templates: templates,
        // Через приложение Qabyl: вебхук общий, подпись — секретом платформы из окружения.
        wa_connection_kind: "platform",
        wa_connected_at: new Date().toISOString(),
        wa_token_status: "valid",
        // Переподключение чинит прежнюю поломку — старая причина не должна пережить его на экране.
        wa_last_error: null,
        wa_last_error_at: null,
        // Секрет платформы сюда БОЛЬШЕ НЕ ПИШЕМ (см. шапку). Затираем и старое значение: салоны,
        // подключённые до этой правки, носят в строке копию общего секрета.
        whatsapp_cloud_app_secret: null,
      } as any,
      { onConflict: "salon_id" },
    );
    if (saveErr) {
      await record({ step: "save", ok: false, detail: saveErr.message });
      throw new Error(`Подключение прошло, но не сохранилось: ${saveErr.message}`);
    }
    await record({ step: "save", ok: true });

    // Кредитная линия платформы (YCloud). Неудача здесь НЕ отменяет подключение: WhatsApp уже
    // подключён, а оплату можно доделать без повторного окна Meta. Состояние оплаты записывается
    // в wa_payment_ready, и экран салона покажет «оплата не подключена», если не сработало.
    const { platformBillingEnabled, ycloudBindWaba } = await import("@/lib/ycloud.server");
    if (platformBillingEnabled()) {
      const bind = await ycloudBindWaba(data.wabaId, coexistence);
      await record(
        {
          step: "billing",
          ok: bind.ok && bind.paymentMethodAttached === true,
          detail: bind.ok
            ? bind.paymentMethodAttached
              ? "оплата подключена"
              : "аккаунт привязан, но оплата не подключена"
            : bind.error,
        },
        { coexistence, paymentMethodAttached: bind.paymentMethodAttached },
      );
      if (bind.ok && bind.paymentMethodAttached !== null) {
        await supabaseAdmin
          .from("salon_secrets")
          .update({ wa_payment_ready: bind.paymentMethodAttached } as any)
          .eq("salon_id", data.salonId);
      }
    }

    // Coexistence: у Meta 24 часа на синхронизацию контактов и истории, иначе салон придётся
    // отключить и провести через окно заново. Запросы разовые, данные приходят вебхуками
    // smb_app_state_sync и history. Неудача не отменяет подключение — только пишется в журнал.
    if (coexistence) {
      const { graphCall } = await import("@/lib/meta-graph.server");
      for (const syncType of ["smb_app_state_sync", "history"] as const) {
        const res = await graphCall(`${encodeURIComponent(phoneNumberId)}/smb_app_data`, {
          method: "POST",
          token: exchanged.token,
          retries: 1,
          body: { messaging_product: "whatsapp", sync_type: syncType },
        });
        await record({
          step: `sync:${syncType}`,
          ok: res.ok,
          detail: res.ok ? undefined : res.error.message,
        });
      }
    }

    // Реальное состояние спрашиваем у Meta, а не выводим из того, что все шаги вернули «ок».
    // Именно здесь выясняется, одобрены ли шаблоны (созданный приходит PENDING), живой ли номер и
    // что вообще Meta думает об этом аккаунте. Флаг wa_cloud_templates_ready ставит она же.
    let status;
    try {
      status = await refreshWaConnection(data.salonId);
      await record({ step: "verify", ok: true, detail: status.code });
    } catch (e: any) {
      // Проверка — не часть подключения. Салон уже подключён; не сумели опросить Meta — покажем
      // состояние по тому, что записали, и предложим проверить кнопкой.
      await record({ step: "verify", ok: false, detail: e?.message ?? "проверка не удалась" });
      status = computeWaStatus({
        whatsapp_cloud_phone_number_id: phoneNumberId,
        whatsapp_cloud_token: exchanged.token,
        whatsapp_cloud_waba_id: data.wabaId,
        whatsapp_cloud_templates: templates as any,
      });
    }

    return { ok: true, steps, status };
  });

/**
 * Заводит комплект шаблонов уведомлений на УЖЕ подключённом салоне.
 *
 * Тот же код, что отрабатывает внутри `finishWaOnboarding`, но с отдельной ручкой. До этой кнопки
 * шаблоны можно было создать ровно один раз — в момент прохождения Embedded Signup. Если Meta
 * отклонила шаблон, владелец удалил его в WhatsApp Manager или мы добавили ещё один, единственным
 * выходом было переподключить салон целиком.
 *
 * Реквизиты берём из базы, а не из формы: токен на клиент не отдаём вовсе.
 */
export const createWaTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);

    const { createNotificationTemplates } = await import("@/lib/wa-onboarding.server");
    const { refreshWaConnection, logOnboardingEvent } = await import("@/lib/wa-connection.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error: readErr } = await supabaseAdmin
      .from("salon_secrets")
      .select("whatsapp_cloud_waba_id, whatsapp_cloud_token, whatsapp_cloud_templates")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);

    const wabaId = (row as any)?.whatsapp_cloud_waba_id ?? "";
    const token = (row as any)?.whatsapp_cloud_token ?? "";
    if (!token || !wabaId) {
      throw new Error("Сначала подключите WhatsApp — без этого шаблоны создавать негде.");
    }

    const attemptId = crypto.randomUUID();
    const { steps, templates } = await createNotificationTemplates(wabaId, token);
    for (const s of steps) await logOnboardingEvent(data.salonId, attemptId, s);

    // Мержим, а не заменяем: за нашими видами может стоять ещё один, заведённый салоном под свою
    // отрасль. Он к этой кнопке отношения не имеет и переживать её должен.
    const merged = { ...((row as any)?.whatsapp_cloud_templates ?? {}), ...templates };

    const { error: saveErr } = await supabaseAdmin
      .from("salon_secrets")
      .upsert({ salon_id: data.salonId, whatsapp_cloud_templates: merged } as any, {
        onConflict: "salon_id",
      });
    if (saveErr) throw new Error(`Шаблоны созданы, но не сохранились: ${saveErr.message}`);

    // Статусы и флаг готовности — только из ответа Meta. Созданный шаблон это PENDING, и поднимать
    // по нему флаг значит слать напоминания по неодобренному шаблону и получать 132000.
    const status = await refreshWaConnection(data.salonId);
    return { ok: true, steps, status };
  });

/**
 * Подписывает наше приложение на события WABA уже подключённого салона.
 *
 * Один из шагов `finishWaOnboarding`, вынесенный наружу по той же причине, что и создание
 * шаблонов: салон, подключённый вручную, этот шаг пропускает целиком. Симптом при этом самый
 * неприятный из возможных — тишина. Сообщения клиентов уходят в Meta и до нас не доезжают,
 * в логах ни строчки, а салон выглядит подключённым.
 *
 * Повторный вызов безопасен: Meta возвращает успех на уже оформленную подписку.
 */
export const subscribeWaWebhooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);

    const { subscribeAppToWaba } = await import("@/lib/wa-onboarding.server");
    const { logOnboardingEvent } = await import("@/lib/wa-connection.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error } = await supabaseAdmin
      .from("salon_secrets")
      .select("whatsapp_cloud_waba_id, whatsapp_cloud_token")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const wabaId = (row as any)?.whatsapp_cloud_waba_id ?? "";
    const token = (row as any)?.whatsapp_cloud_token ?? "";
    if (!wabaId || !token) {
      throw new Error("Сначала подключите WhatsApp — подписывать нечего.");
    }

    const step = await subscribeAppToWaba(wabaId, token);
    await logOnboardingEvent(data.salonId, crypto.randomUUID(), step);
    if (!step.ok) throw new Error(step.detail ?? "Meta отказала в подписке");
    return { ok: true };
  });

/**
 * Состояние канала для экрана. Без запроса в Meta — только то, что уже в базе.
 *
 * Отдельно от `checkWaConnection` намеренно: этот вызов делает КАЖДОЕ открытие вкладки, и он
 * обязан быть дешёвым. Опрос Meta на каждый рендер стоил бы четырёх запросов и упирался бы в
 * лимит приложения на десятке салонов.
 */
export const getWaStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { computeWaStatus } = await import("@/lib/wa-connection.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();

    return computeWaStatus(row as any, {
      platformBilling: Boolean((process.env.YCLOUD_API_KEY ?? "").trim()),
    });
  });

/** Спрашивает Meta и обновляет состояние. За кнопкой «Проверить подключение». */
export const checkWaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { refreshWaConnection } = await import("@/lib/wa-connection.server");
    return await refreshWaConnection(data.salonId);
  });

/**
 * Отключает WhatsApp от салона.
 *
 * ЧТО УДАЛЯЕТСЯ: только реквизиты доступа. Переписка, записи и клиенты остаются — отключение
 * канала не должно означать потерю истории, иначе владелец боится нажать эту кнопку даже когда
 * она нужна (сменил номер, продал салон, ошибся аккаунтом при подключении).
 *
 * Подписку на вебхуки на стороне Meta тоже снимаем: без этого Meta продолжает слать нам события
 * отключённого салона, а общий вебхук отвечает «неизвестный номер» на каждое.
 */
export const disconnectWa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { logOnboardingEvent } = await import("@/lib/wa-connection.server");
    const { graphCall } = await import("@/lib/meta-graph.server");

    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("whatsapp_cloud_waba_id, whatsapp_cloud_token")
      .eq("salon_id", data.salonId)
      .maybeSingle();

    const wabaId = (row as any)?.whatsapp_cloud_waba_id ?? "";
    const token = (row as any)?.whatsapp_cloud_token ?? "";

    if (wabaId && token) {
      // Неудача здесь не отменяет отключение: токен мог уже протухнуть, и именно поэтому владелец
      // и отключается. Лишняя подписка на стороне Meta — меньшее зло, чем салон, который не может
      // отвязать сломанный аккаунт.
      const res = await graphCall(`${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: "DELETE",
        token,
        retries: 1,
      });
      await logOnboardingEvent(data.salonId, crypto.randomUUID(), {
        step: "unsubscribe",
        ok: res.ok,
        detail: res.ok ? undefined : "подписку снять не удалось",
      });
    }

    const { error } = await supabaseAdmin
      .from("salon_secrets")
      .update({
        whatsapp_cloud_phone_number_id: null,
        whatsapp_cloud_token: null,
        whatsapp_cloud_waba_id: null,
        whatsapp_cloud_app_secret: null,
        whatsapp_cloud_templates: null,
        wa_connection_kind: null,
        wa_connected_at: null,
        wa_token_status: null,
        wa_last_health_check_at: null,
        wa_last_error: null,
        wa_last_error_at: null,
        wa_display_phone_number: null,
        wa_verified_name: null,
        wa_quality_rating: null,
        wa_messaging_limit: null,
        wa_platform_type: null,
        wa_account_review_status: null,
        wa_payment_ready: null,
        wa_templates_synced_at: null,
      } as any)
      .eq("salon_id", data.salonId);
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("salons")
      .update({ wa_cloud_templates_ready: false } as any)
      .eq("id", data.salonId);

    return { ok: true as const };
  });

/**
 * Параметры окна подключения, которые живут на сервере.
 *
 * Solution ID отдаётся отсюда, а не зашивается в сборку: он появляется после одобрения YCloud, и
 * ради него не должно быть нужно пересобирать сайт. Пусто — окно открывается без партнёрского
 * решения, как раньше, и салон платит Meta сам.
 */
export const getWaSignupSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return {
      solutionId: (process.env.WA_ES_SOLUTION_ID ?? "").trim() || null,
      // Конфигурация окна Meta — тоже с сервера. Конфигурацию нельзя отредактировать (продукты,
      // тип токена «can't be changed later»), только создать новую, а проверять новую приходится на
      // живом салоне. Переменная в Cloudflare меняется за минуту, выкладка кода — дольше и рискованнее.
      configId: (process.env.WA_ES_CONFIG_ID ?? "").trim() || null,
    };
  });
