// Управление приложением Gupshup: подписки на события. Не отправка — настройка.
//
// Отдельно от wa-gupshup.server.ts намеренно. Тот файл живёт на горячем пути: его функции
// вызываются на каждое сообщение клиента. Здесь всё наоборот — вызывается раз при подключении
// салона и потом изредка по кнопке. Смешивать их значит тащить провижининг в каждый ответ
// ассистента и мешать при чтении две разные скорости жизни.
//
// ЗАЧЕМ ЭТО ВООБЩЕ АВТОМАТИЗИРОВАТЬ. Без подписки приложение подключено и молчит: Gupshup
// принимает сообщения клиентов и никому о них не сообщает. Раньше её заводили руками в кабинете —
// на каждый салон отдельно, пятью полями. Двадцать салонов это двадцать шансов промахнуться
// адресом, и промах выглядит не как ошибка, а как «салон подключён, ассистент не отвечает».
//
// Устаревший «Callback URL API» не используется: Gupshup вывел его из эксплуатации. Только
// Subscription API.
import { gupshupBase } from "@/lib/wa-gupshup.server";

export type GupshupSubscription = {
  id: string;
  tag: string;
  url: string;
  version: number;
  modes: string;
  active: boolean;
};

/**
 * ПОЧЕМУ ПОДПИСОК ДВЕ, а не одна.
 *
 *   • Версия 3 отдаёт входящие и статусы в формате Meta — на ней держится весь пайплайн, потому
 *     что этот формат уже разбирают parseWaCloudWebhook и parseWaCloudEchoes.
 *   • Версия 2 нужна ровно ради одного: только в её событии `sent` приезжают `pricing` и
 *     `conversation`, из которых считается стоимость разговора. В формате Meta этих полей нет.
 *
 * Gupshup предупреждает, что при двух подписках событие придёт дважды и дедупликация — на нашей
 * стороне. Она уже есть: частичный уникальный индекс на (salon_id, green_api_message_id).
 */
const V3_MODES = "MESSAGE,SENT,DELIVERED,READ,DELETED,TEMPLATE,ACCOUNT,OTHERS";
/** Только деньги. Всё остальное на этой версии — дубль того, что уже пришло по версии 3. */
const V2_MODES = "BILLING";

/** Метки наших подписок. По ним же они ищутся при повторной настройке и при отключении салона. */
export const QABYL_V3_TAG = "qabyl-v3";
export const QABYL_V2_TAG = "qabyl-billing";

async function subscriptionRequest(
  apiKey: string,
  appId: string,
  init: { method: string; path?: string; form?: Record<string, string> },
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  if (!apiKey) return { ok: false, error: "Не заполнен API-ключ Gupshup" };
  if (!appId) return { ok: false, error: "Не заполнен App ID Gupshup" };

  const url = `${gupshupBase()}/app/${encodeURIComponent(appId)}/subscription${init.path ?? ""}`;
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        apikey: apiKey,
        Accept: "application/json",
        ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      signal: AbortSignal.timeout(15000),
    });

    const raw = await res.text();
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* не JSON — сырой текст уйдёт в сообщение об ошибке */
    }

    if (!res.ok) {
      return { ok: false, error: `Gupshup ${res.status}: ${json?.message ?? raw.slice(0, 200)}` };
    }
    // Тот же приём, что и на отправке: у Gupshup неуспех приезжает и с кодом 200.
    if (json?.status && String(json.status).toLowerCase() === "error") {
      return { ok: false, error: `Gupshup отклонил запрос: ${json?.message ?? "без причины"}` };
    }
    return { ok: true, json };
  } catch (e: any) {
    return { ok: false, error: `Gupshup недоступен: ${e?.message ?? String(e)}` };
  }
}

export async function gupshupListSubscriptions(
  apiKey: string,
  appId: string,
): Promise<{ ok: true; subscriptions: GupshupSubscription[] } | { ok: false; error: string }> {
  const res = await subscriptionRequest(apiKey, appId, { method: "GET" });
  if (!res.ok) return res;

  const raw = Array.isArray(res.json?.subscriptions) ? res.json.subscriptions : [];
  return {
    ok: true,
    subscriptions: raw.map((s: any) => ({
      id: String(s?.id ?? s?.subscriptionId ?? ""),
      tag: String(s?.tag ?? ""),
      url: String(s?.url ?? ""),
      version: Number(s?.version ?? 0),
      modes: String(s?.modes ?? ""),
      active: s?.active !== false,
    })),
  };
}

export async function gupshupDeleteSubscription(
  apiKey: string,
  appId: string,
  subscriptionId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!subscriptionId) return { ok: false, error: "Не указан идентификатор подписки" };
  const res = await subscriptionRequest(apiKey, appId, {
    method: "DELETE",
    path: `/${encodeURIComponent(subscriptionId)}`,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export type SubscriptionSyncStep = {
  step: string;
  ok: boolean;
  /** Шаг прошёл потому, что делать было нечего — подписка уже была нужной. */
  existed?: boolean;
  detail?: string;
};

/**
 * Привести подписки приложения к тому, что нужно Qabyl. Идемпотентно.
 *
 * Не «создать», а именно «привести»: функция вызывается повторно — при переподключении салона,
 * при смене адреса вебхука, просто по кнопке «проверить». Поэтому подписка с нашей меткой и
 * верным адресом считается успехом, а с неверным — удаляется и создаётся заново.
 *
 * Плодить дубли нельзя: у Gupshup потолок в пять подписок на приложение, и список, забитый
 * нашими же неудачными попытками, означает, что настоящую подписку добавить уже некуда.
 *
 * Чужие подписки (без нашей метки) не трогаются никогда. Приложение может обслуживать не только
 * нас, и снести чужой адрес — значит сломать то, о чём мы ничего не знаем.
 */
export async function gupshupSyncSubscriptions(
  apiKey: string,
  appId: string,
  webhookUrl: string,
): Promise<{ ok: boolean; steps: SubscriptionSyncStep[] }> {
  const steps: SubscriptionSyncStep[] = [];

  const listed = await gupshupListSubscriptions(apiKey, appId);
  if (!listed.ok) {
    return { ok: false, steps: [{ step: "Список подписок", ok: false, detail: listed.error }] };
  }
  steps.push({
    step: "Список подписок",
    ok: true,
    detail: `сейчас настроено: ${listed.subscriptions.length}`,
  });

  const wanted = [
    { tag: QABYL_V3_TAG, version: 3, modes: V3_MODES, label: "Входящие и статусы" },
    { tag: QABYL_V2_TAG, version: 2, modes: V2_MODES, label: "События тарификации" },
  ];

  let allOk = true;

  for (const w of wanted) {
    const existing = listed.subscriptions.filter((s) => s.tag === w.tag);

    // Уже есть и указывает куда надо — ничего не делаем. Самый частый исход при повторном
    // запуске, и он не должен ни жечь лимит, ни выглядеть как проделанная работа.
    const good = existing.find((s) => s.url === webhookUrl && s.version === w.version && s.active);
    if (good && existing.length === 1) {
      steps.push({ step: w.label, ok: true, existed: true, detail: "уже настроена" });
      continue;
    }

    // Всё, что помечено нашей меткой, но настроено иначе, — сносим. Включая дубли: они появляются,
    // если предыдущий запуск оборвался между созданием и проверкой.
    for (const stale of existing) {
      const del = await gupshupDeleteSubscription(apiKey, appId, stale.id);
      if (!del.ok) {
        steps.push({ step: `${w.label}: очистка`, ok: false, detail: del.error });
        allOk = false;
      }
    }

    const created = await subscriptionRequest(apiKey, appId, {
      method: "POST",
      form: {
        url: webhookUrl,
        tag: w.tag,
        version: String(w.version),
        modes: w.modes,
        // Пусть Gupshup сам отсечёт повтор, если наш список успел устареть между чтением и
        // записью. Дешевле, чем разбирать потом переполненный лимит.
        doCheck: "true",
      },
    });

    if (created.ok) {
      steps.push({ step: w.label, ok: true, detail: "подписка создана" });
    } else {
      steps.push({ step: w.label, ok: false, detail: created.error });
      allOk = false;
    }
  }

  return { ok: allOk, steps };
}

/**
 * Снять наши подписки. Вызывается при отключении салона.
 *
 * Оставить их — значит продолжать получать события салона, который считается отключённым:
 * маршрут исправно сложит их в карантин, а владелец будет недоумевать, почему в журнале что-то
 * шевелится у выключенного канала. Чужие подписки, как и при настройке, не трогаются.
 */
export async function gupshupRemoveOurSubscriptions(
  apiKey: string,
  appId: string,
): Promise<{ ok: boolean; removed: number; error?: string }> {
  const listed = await gupshupListSubscriptions(apiKey, appId);
  if (!listed.ok) return { ok: false, removed: 0, error: listed.error };

  const ours = listed.subscriptions.filter((s) => s.tag === QABYL_V3_TAG || s.tag === QABYL_V2_TAG);

  let removed = 0;
  let firstError: string | undefined;
  for (const s of ours) {
    const del = await gupshupDeleteSubscription(apiKey, appId, s.id);
    if (del.ok) removed++;
    else if (!firstError) firstError = del.error;
  }

  return { ok: !firstError, removed, ...(firstError ? { error: firstError } : {}) };
}
