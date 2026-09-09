// Состояние канала WhatsApp: что мы знаем о подключении салона и что из этого следует.
//
// ЗАЧЕМ. До этого файла «подключён» означало «в двух колонках непусто». Этого мало: строка с
// отозванным токеном выглядит ровно так же, как рабочее подключение, и разница обнаруживается
// только тем, что ассистент молчит третий день. Здесь появляется то, что можно проверить заранее
// и показать владельцу словами, а не кодом ошибки.
//
// РАЗДЕЛЕНИЕ. Две половины, и они намеренно не смешаны:
//   • computeWaStatus — чистая функция от строки БД. Ничего не спрашивает у Meta, работает
//     мгновенно, годится для рендера экрана и для списка салонов.
//   • refreshWaConnection — ходит в Graph API и обновляет строку. Медленно, стоит лимита запросов,
//     вызывается по кнопке и по расписанию.
// Экран рисуется первой, кнопка «проверить» дёргает вторую. Если бы это была одна функция, каждый
// рендер стоил бы четырёх запросов в Meta.
import { graphCall, humanGraphError, type GraphError } from "@/lib/meta-graph.server";
import { NOTIFICATION_TEMPLATES } from "@/lib/wa-onboarding.server";

// ---------------------------------------------------------------------------
// Что мы знаем о подключении
// ---------------------------------------------------------------------------

export type WaTemplateState = {
  name: string;
  lang: string;
  /** То, что ответила Meta. Созданный шаблон приходит PENDING, а не APPROVED. */
  status?: string | null;
  status_at?: string | null;
  reason?: string | null;
};

/** Строка salon_secrets в том объёме, который нужен для суждения о канале. */
export type WaConnectionRow = {
  whatsapp_cloud_phone_number_id?: string | null;
  whatsapp_cloud_token?: string | null;
  whatsapp_cloud_waba_id?: string | null;
  whatsapp_cloud_templates?: Record<string, WaTemplateState | undefined> | null;
  wa_connection_kind?: string | null;
  wa_connected_at?: string | null;
  wa_token_status?: string | null;
  wa_last_health_check_at?: string | null;
  wa_last_error?: string | null;
  wa_last_error_at?: string | null;
  wa_display_phone_number?: string | null;
  wa_verified_name?: string | null;
  wa_quality_rating?: string | null;
  wa_messaging_limit?: string | null;
  wa_platform_type?: string | null;
  wa_account_review_status?: string | null;
  wa_payment_ready?: boolean | null;
  wa_templates_synced_at?: string | null;
};

/**
 * Что делать владельцу. Не список кнопок интерфейса, а список ИСХОДОВ: интерфейс сам решает, как
 * их рисовать, но придумывать новые не может — иначе через месяц одно и то же состояние в двух
 * местах предлагает разное.
 */
export type WaAction =
  | { kind: "connect"; label: string }
  | { kind: "reconnect"; label: string }
  | { kind: "add_payment"; label: string; url: string }
  | { kind: "recreate_templates"; label: string }
  | { kind: "recheck"; label: string }
  | { kind: "wait"; label: string }
  | { kind: "support"; label: string };

export type WaStatus = {
  connected: boolean;
  /** ok — работает; warn — работает не полностью; error — не работает; idle — не подключён. */
  level: "ok" | "warn" | "error" | "idle";
  /** Машинный код состояния. По нему считают статистику и пишут тесты, а не по заголовку. */
  code:
    | "not_connected"
    | "healthy"
    | "templates_pending"
    | "templates_rejected"
    | "needs_payment"
    | "token_invalid"
    | "account_restricted"
    | "quality_low"
    | "never_checked";
  /** Заголовок для владельца. Бизнес-язык: «WhatsApp подключён», а не «WABA attached». */
  title: string;
  body: string;
  action?: WaAction;
  /** Подробности для экрана: номер, имя, качество. Всё уже человекочитаемое. */
  facts: {
    phone: string | null;
    verifiedName: string | null;
    quality: string | null;
    messagingLimit: string | null;
    coexistence: boolean;
    templatesApproved: number;
    templatesTotal: number;
    lastCheckedAt: string | null;
  };
};

const META_BILLING_URL = "https://business.facebook.com/billing_hub/payment_settings";

/** Сколько шаблонов из нашего комплекта одобрено. */
function countTemplates(row: WaConnectionRow): {
  approved: number;
  total: number;
  rejected: number;
} {
  const map = row.whatsapp_cloud_templates ?? {};
  let approved = 0;
  let rejected = 0;
  for (const tpl of NOTIFICATION_TEMPLATES) {
    const st = map[tpl.kind]?.status?.toUpperCase();
    if (st === "APPROVED") approved++;
    // PAUSED и DISABLED — не отказ модерации, но отправлять по ним всё равно нельзя, и чинится
    // это тем же действием. Разделять их на экране значило бы объяснять владельцу разницу,
    // которая ничего не меняет.
    if (st === "REJECTED" || st === "DISABLED") rejected++;
  }
  return { approved, total: NOTIFICATION_TEMPLATES.length, rejected };
}

/** Качество номера у Meta: GREEN / YELLOW / RED / UNKNOWN. */
function qualityLabel(raw: string | null | undefined): string | null {
  switch ((raw ?? "").toUpperCase()) {
    case "GREEN":
      return "хорошее";
    case "YELLOW":
      return "среднее";
    case "RED":
      return "низкое";
    default:
      return null;
  }
}

/**
 * Состояние канала по тому, что уже лежит в базе.
 *
 * ПОРЯДОК ПРОВЕРОК — это и есть вся логика. Он идёт от «совсем не работает» к «работает не
 * полностью», потому что владельцу надо назвать ОДНУ причину: ту, которая мешает больше всех.
 * Сказать про шаблоны на модерации салону с отозванным токеном — значит отправить его чинить не то.
 */
export function computeWaStatus(row: WaConnectionRow | null | undefined): WaStatus {
  const r = row ?? {};
  const tpl = countTemplates(r);
  const facts = {
    phone: r.wa_display_phone_number ?? null,
    verifiedName: r.wa_verified_name ?? null,
    quality: qualityLabel(r.wa_quality_rating),
    messagingLimit: r.wa_messaging_limit ?? null,
    coexistence: (r.wa_platform_type ?? "").toUpperCase() === "ON_BIZ_APP",
    templatesApproved: tpl.approved,
    templatesTotal: tpl.total,
    lastCheckedAt: r.wa_last_health_check_at ?? null,
  };

  const connected = Boolean(r.whatsapp_cloud_phone_number_id && r.whatsapp_cloud_token);

  if (!connected) {
    return {
      connected: false,
      level: "idle",
      code: "not_connected",
      title: "WhatsApp не подключён",
      body: "Клиенты, которые пишут вам в WhatsApp, остаются без ответа, а подтверждения и напоминания о записи не отправляются.",
      action: { kind: "connect", label: "Подключить WhatsApp" },
      facts,
    };
  }

  if (r.wa_token_status === "invalid") {
    return {
      connected: true,
      level: "error",
      code: "token_invalid",
      title: "Доступ к WhatsApp потерян",
      body: "Qabyl больше не может отвечать от вашего имени — скорее всего, доступ отозвали в настройках Meta. Подключите WhatsApp заново, переписка и записи при этом сохранятся.",
      action: { kind: "reconnect", label: "Подключить заново" },
      facts,
    };
  }

  const review = (r.wa_account_review_status ?? "").toUpperCase();
  if (review === "DISABLED" || review === "REJECTED" || review === "RESTRICTED") {
    return {
      connected: true,
      level: "error",
      code: "account_restricted",
      title: "Meta ограничила ваш аккаунт WhatsApp",
      body: "Отправка сообщений приостановлена на стороне Meta. Обычно это решается в кабинете Meta Business — мы поможем разобраться.",
      action: { kind: "support", label: "Написать в поддержку" },
      facts,
    };
  }

  // Платёжка проверяется ПОСЛЕ доступа и бана, но ДО шаблонов: без неё Meta не выпустит вообще
  // ничего, включая ответ ассистента внутри окна 24 часов. Шаблоны на этом фоне — мелочь.
  if (r.wa_payment_ready === false) {
    return {
      connected: true,
      level: "error",
      code: "needs_payment",
      title: "Нужен способ оплаты в Meta",
      body: "WhatsApp Business берёт плату за сообщения напрямую с вас. Пока карта не привязана, Meta не отправит ни одного сообщения — ни ответа клиенту, ни напоминания.",
      action: { kind: "add_payment", label: "Привязать карту в Meta", url: META_BILLING_URL },
      facts,
    };
  }

  if (!r.wa_last_health_check_at) {
    return {
      connected: true,
      level: "warn",
      code: "never_checked",
      title: "Подключение ещё не проверено",
      body: "Реквизиты сохранены, но мы ни разу не спросили у Meta, работает ли канал. Проверка занимает пару секунд.",
      action: { kind: "recheck", label: "Проверить подключение" },
      facts,
    };
  }

  if (tpl.rejected > 0) {
    return {
      connected: true,
      level: "warn",
      code: "templates_rejected",
      title: "Часть уведомлений Meta не пропустила",
      body: `Одобрено ${tpl.approved} из ${tpl.total}. Напоминания и подтверждения не дойдут до клиентов, которые писали больше суток назад. Обычно помогает создать их заново.`,
      action: { kind: "recreate_templates", label: "Создать заново" },
      facts,
    };
  }

  if (tpl.approved < tpl.total) {
    return {
      connected: true,
      level: "warn",
      code: "templates_pending",
      title: "WhatsApp работает, уведомления на проверке",
      body: `Ассистент уже отвечает клиентам. Meta проверяет тексты подтверждений и напоминаний — одобрено ${tpl.approved} из ${tpl.total}, обычно это занимает от нескольких минут до часа.`,
      action: { kind: "wait", label: "Обновить" },
      facts,
    };
  }

  if ((r.wa_quality_rating ?? "").toUpperCase() === "RED") {
    return {
      connected: true,
      level: "warn",
      code: "quality_low",
      title: "Клиенты часто блокируют ваш номер",
      body: "Meta снизила рейтинг номера. Если так продолжится, лимит сообщений в сутки уменьшится. Проверьте, не уходят ли рассылки тем, кто их не ждёт.",
      facts,
    };
  }

  return {
    connected: true,
    level: "ok",
    code: "healthy",
    title: "WhatsApp подключён",
    body: facts.coexistence
      ? "Ассистент отвечает клиентам, а WhatsApp Business на телефоне продолжает работать как раньше."
      : "Ассистент принимает сообщения клиентов и отправляет подтверждения и напоминания.",
    facts,
  };
}

// ---------------------------------------------------------------------------
// Разговор с Meta
// ---------------------------------------------------------------------------

export type WaSnapshot = {
  /** Ответила ли Meta вообще. false — ниже лежит причина, и остальные поля бессмысленны. */
  ok: boolean;
  error?: GraphError;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  qualityRating?: string | null;
  platformType?: string | null;
  accountReviewStatus?: string | null;
  businessId?: string | null;
  messagingLimit?: string | null;
  /** Имя шаблона → его статус у Meta. Пусто, если WABA не спросили или спросили неудачно. */
  templateStatus?: Map<string, { status: string; reason: string | null }>;
};

/**
 * Спрашивает Meta обо всём разом: номер, аккаунт, шаблоны.
 *
 * Три запроса, а не один: у Graph API нет способа взять поля номера и поля WABA одним вызовом.
 * Идут параллельно — последовательно это три круга по сети там, где хватает одного.
 *
 * Неудача ЛЮБОГО из них не отменяет остальные: протухший токен виден по первому же, а вот
 * отсутствие прав на шаблоны (частый случай у салона со своим приложением) не должно скрывать
 * рабочий номер.
 */
export async function fetchWaSnapshot(creds: {
  phoneNumberId: string;
  token: string;
  wabaId?: string | null;
}): Promise<WaSnapshot> {
  const phoneReq = graphCall<any>(creds.phoneNumberId, {
    token: creds.token,
    query: {
      fields:
        "display_phone_number,verified_name,quality_rating,platform_type,throughput,code_verification_status",
    },
  });

  const wabaReq = creds.wabaId
    ? graphCall<any>(creds.wabaId, {
        token: creds.token,
        query: {
          fields: "id,name,account_review_status,business_verification_status,owner_business_info",
        },
      })
    : Promise.resolve(null);

  const tplReq = creds.wabaId
    ? graphCall<any>(`${creds.wabaId}/message_templates`, {
        token: creds.token,
        query: { fields: "name,status,language,rejected_reason", limit: "200" },
      })
    : Promise.resolve(null);

  const [phone, waba, tpl] = await Promise.all([phoneReq, wabaReq, tplReq]);

  if (!phone.ok) {
    // Номер — единственный обязательный вызов: без него мы не знаем даже, жив ли токен.
    return { ok: false, error: phone.error };
  }

  const snapshot: WaSnapshot = {
    ok: true,
    displayPhoneNumber: phone.data?.display_phone_number ?? null,
    verifiedName: phone.data?.verified_name ?? null,
    qualityRating: phone.data?.quality_rating ?? null,
    platformType: phone.data?.platform_type ?? null,
    // throughput.level — 'STANDARD' | 'HIGH'. Для владельца это «сколько сообщений в секунду»,
    // а не messaging tier; сам tier Graph отдаёт только в другом поле и не всем, поэтому берём то,
    // что отдаётся стабильно.
    messagingLimit: phone.data?.throughput?.level ?? null,
  };

  if (waba && waba.ok) {
    snapshot.accountReviewStatus = waba.data?.account_review_status ?? null;
    snapshot.businessId = waba.data?.owner_business_info?.id ?? null;
  }

  if (tpl && tpl.ok && Array.isArray(tpl.data?.data)) {
    const map = new Map<string, { status: string; reason: string | null }>();
    for (const t of tpl.data.data) {
      if (!t?.name) continue;
      map.set(String(t.name), {
        status: String(t.status ?? "UNKNOWN").toUpperCase(),
        reason:
          t.rejected_reason && t.rejected_reason !== "NONE" ? String(t.rejected_reason) : null,
      });
    }
    snapshot.templateStatus = map;
  }

  return snapshot;
}

/**
 * Проверяет подключение и записывает результат в базу.
 *
 * Единственная функция, которая меняет представление о здоровье канала. Её зовут три места:
 * кнопка «проверить» в панели, фоновая проверка по расписанию и конец подключения. Больше никто
 * не должен писать в wa_token_status — иначе состояние начинает зависеть от того, кто последний
 * что подумал.
 *
 * ЧТО НЕ ДЕЛАЕТ: не чинит. Отозванный токен остаётся отозванным, шаблон на модерации — на
 * модерации. Она только приводит запись в базе в соответствие с тем, что на самом деле.
 */
export async function refreshWaConnection(salonId: string): Promise<WaStatus> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: row } = await supabaseAdmin
    .from("salon_secrets")
    .select("*")
    .eq("salon_id", salonId)
    .maybeSingle();

  const r = (row ?? {}) as Record<string, any>;
  const phoneNumberId = r.whatsapp_cloud_phone_number_id ?? "";
  const token = r.whatsapp_cloud_token ?? "";
  const wabaId = r.whatsapp_cloud_waba_id ?? null;

  // Не подключён — проверять нечего, и ходить в Meta незачем.
  if (!phoneNumberId || !token) return computeWaStatus(r as WaConnectionRow);

  const snap = await fetchWaSnapshot({ phoneNumberId, token, wabaId });
  const now = new Date().toISOString();

  if (!snap.ok) {
    const err = snap.error!;
    // Различие принципиальное. `auth` означает «токен больше не наш» — состояние канала меняется,
    // владельца надо звать. Всё остальное — «Meta сейчас не ответила»: записываем причину, но НЕ
    // объявляем подключение сломанным, иначе пятиминутный сбой Meta покажет семи салонам красный
    // экран «доступ потерян» и заставит их переподключаться на ровном месте.
    const patch: Record<string, any> = {
      salon_id: salonId,
      wa_last_health_check_at: now,
      wa_last_error: humanGraphError(err),
      wa_last_error_at: now,
      ...(err.kind === "auth" ? { wa_token_status: "invalid" } : {}),
    };
    await supabaseAdmin.from("salon_secrets").upsert(patch as any, { onConflict: "salon_id" });
    await logOnboardingEvent(salonId, crypto.randomUUID(), {
      step: "health",
      ok: false,
      detail: humanGraphError(err),
      details: { code: err.code, subcode: err.subcode, status: err.status, raw: err.message },
    });
    return computeWaStatus({ ...(r as WaConnectionRow), ...patch });
  }

  // Шаблоны: наши имена сверяем с тем, что реально лежит у Meta. Имя, которого там нет, теряет
  // статус — это ровно случай «владелец удалил шаблон в WhatsApp Manager», и молча оставлять ему
  // APPROVED значит отправлять по несуществующему.
  const templates: Record<string, WaTemplateState> = {};
  const existing = (r.whatsapp_cloud_templates ?? {}) as Record<
    string,
    WaTemplateState | undefined
  >;
  if (snap.templateStatus) {
    for (const [kind, tpl] of Object.entries(existing)) {
      if (!tpl?.name) continue;
      const hit = snap.templateStatus.get(tpl.name);
      templates[kind] = {
        ...tpl,
        status: hit?.status ?? "MISSING",
        status_at: now,
        reason: hit?.reason ?? null,
      };
    }
  }

  const patch: Record<string, any> = {
    salon_id: salonId,
    wa_token_status: "valid",
    wa_last_health_check_at: now,
    wa_last_error: null,
    wa_last_error_at: null,
    wa_display_phone_number: snap.displayPhoneNumber ?? null,
    wa_verified_name: snap.verifiedName ?? null,
    wa_quality_rating: snap.qualityRating ?? null,
    wa_platform_type: snap.platformType ?? null,
    wa_messaging_limit: snap.messagingLimit ?? null,
    ...(snap.accountReviewStatus ? { wa_account_review_status: snap.accountReviewStatus } : {}),
    ...(snap.businessId ? { wa_business_id: snap.businessId } : {}),
    ...(snap.templateStatus
      ? { whatsapp_cloud_templates: templates, wa_templates_synced_at: now }
      : {}),
  };

  await supabaseAdmin.from("salon_secrets").upsert(patch as any, { onConflict: "salon_id" });

  const merged = { ...(r as WaConnectionRow), ...patch } as WaConnectionRow;

  // Флаг «шаблоны готовы» синхронизируем ЗДЕСЬ и только здесь. Раньше его поднимали по факту
  // создания шаблона — а созданный шаблон приходит PENDING, и отправка по нему падает с 132000.
  // Теперь он ровно отражает ответ Meta.
  if (snap.templateStatus) {
    const { approved, total } = countTemplates(merged);
    await supabaseAdmin
      .from("salons")
      .update({ wa_cloud_templates_ready: approved === total } as any)
      .eq("id", salonId);
  }

  return computeWaStatus(merged);
}

// ---------------------------------------------------------------------------
// Журнал
// ---------------------------------------------------------------------------

/**
 * Пишет один шаг подключения в журнал.
 *
 * НИКОГДА не бросает. Журнал существует, чтобы разбираться в поломках; падение самого журнала не
 * должно становиться ещё одной поломкой поверх той, которую он записывает.
 */
export async function logOnboardingEvent(
  salonId: string,
  attemptId: string,
  event: { step: string; ok: boolean; detail?: string | null; details?: unknown },
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin.from("wa_onboarding_events" as any) as any).insert({
      salon_id: salonId,
      attempt_id: attemptId,
      step: event.step,
      ok: event.ok,
      detail: event.detail ?? null,
      details: (event.details ?? null) as any,
    } as any);
  } catch {
    /* журнал не обязан работать, чтобы работало подключение */
  }
}
