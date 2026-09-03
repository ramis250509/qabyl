// Транспорт WhatsApp через Gupshup — BSP-провайдер, третий способ доставить сообщение клиенту.
//
// ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ ДВУХ СОСЕДЕЙ. Прямой Cloud API (wa-cloud.server.ts) ходит в Graph API от
// имени салона: у нас его токен, мы сами всё умеем. Мост Make ходит в чужой сценарий, потому что
// токена у нас нет вовсе. Gupshup — середина: токена Meta у нас нет и не будет, но есть полноценный
// API самого Gupshup, который умеет ровно то же, что Graph, только своими словами.
//
// ЧТО ЭТО ЗНАЧИТ НА ПРАКТИКЕ, и почему файл не копия wa-cloud.server.ts:
//
//   1. ФОРМА ЗАПРОСА ДРУГАЯ. Не JSON, а application/x-www-form-urlencoded, и само сообщение едет
//      внутри поля `message` как СТРОКА с JSON внутри. Отправить его обычным объектом нельзя —
//      Gupshup вернёт 400 на структуру, которая в Graph API была бы правильной.
//
//   2. АУТЕНТИФИКАЦИЯ ЗАГОЛОВКОМ `apikey`, не `Authorization: Bearer`. Ключ принадлежит аккаунту
//      Qabyl целиком, а не салону, — это ровно та причина, по которой он не должен утечь никуда:
//      один ключ открывает все приложения аккаунта, а не одно.
//
//   3. АДРЕСАЦИЯ ПО ИМЕНИ ПРИЛОЖЕНИЯ. Кроме номера отправителя (`source`) Gupshup требует
//      `src.name` — имя приложения, к которому этот номер привязан. Номера мало: один аккаунт
//      держит по приложению на салон, и без имени Gupshup не знает, от чьего лица говорить.
//
//   4. МЕДИА ПРИХОДИТ ССЫЛКОЙ, А НЕ ИДЕНТИФИКАТОРОМ. У Meta в вебхуке лежит media id, который
//      надо отдельно разрешать через Graph с токеном. У Gupshup в событии сразу URL, и скачать
//      его можно без токена Meta — которого у нас всё равно нет. Это упрощение, а не потеря.
//
// Здесь только транспорт: ни состояния диалога, ни бизнес-правил. Пайплайн живёт в
// processWaCloudPayload и про Gupshup не знает.
import {
  splitForWhatsApp,
  toWaCloudRecipient,
  type WaCloudSendResult,
} from "@/lib/wa-cloud.server";

/**
 * Базовый адрес Access API.
 *
 * Читается лениво, а не на уровне модуля: файл попадает в Cloudflare Worker, где модульный код
 * выполняется на сборке, когда process.env ещё пуст. Ровно та же ловушка описана в waGraphBase().
 */
export function gupshupBase(): string {
  return (process.env.GUPSHUP_API_BASE || "https://api.gupshup.io/wa").replace(/\/$/, "");
}

export type GupshupCreds = {
  /** Ключ Access API аккаунта Qabyl. Заголовок `apikey`. */
  apiKey: string;
  /** Номер салона: только цифры, с кодом страны, без «+». Поле `source`. */
  sourceNumber: string;
  /** Имя приложения Gupshup, к которому привязан номер. Поле `src.name`. */
  appName: string;
};

/**
 * Единственное место, где формируется запрос к Gupshup.
 *
 * ОТВЕТ РАЗБИРАЕТСЯ ДВАЖДЫ, и это не перестраховка. Gupshup, как и Meta, умеет отвечать HTTP 200
 * на неуспех — со `status`, отличным от "submitted". Проверять только код ответа значит записать
 * себе в базу messageId, которого не существует, и потом искать по нему статус доставки, который
 * никогда не придёт.
 */
async function gupshupPost(
  creds: GupshupCreds,
  path: string,
  form: Record<string, string>,
): Promise<WaCloudSendResult> {
  if (!creds.apiKey) return { ok: false, error: "Gupshup: не заполнен API-ключ" };
  if (!creds.sourceNumber) return { ok: false, error: "Gupshup: не заполнен номер отправителя" };
  if (!creds.appName) return { ok: false, error: "Gupshup: не заполнено имя приложения" };

  const body = new URLSearchParams(form).toString();

  try {
    const res = await fetch(`${gupshupBase()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apikey: creds.apiKey,
        // Gupshup отвечает JSON и без этого, но явный Accept избавляет от html-страницы ошибки
        // в тех случаях, когда запрос не дошёл до самого API.
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* не JSON — оставим сырой текст для сообщения об ошибке */
    }

    if (!res.ok) {
      // Тело ошибки Gupshup режется: в нём иногда приезжает эхо запроса, а в запросе — номер
      // клиента. В журнал ошибок салона это попадать не должно.
      const detail = parsed?.message ?? parsed?.error ?? raw.slice(0, 200);
      return { ok: false, error: `Gupshup ${res.status}: ${detail || "без тела"}` };
    }

    // Успех у Gupshup — это status: "submitted". Всё остальное при HTTP 200 означает отказ,
    // который просто не оформили кодом ответа.
    const status = String(parsed?.status ?? "").toLowerCase();
    if (status && status !== "submitted") {
      return { ok: false, error: `Gupshup отклонил отправку: ${parsed?.message ?? status}` };
    }

    const messageId = parsed?.messageId ? String(parsed.messageId) : undefined;
    return { ok: true, messageId };
  } catch (e: any) {
    return { ok: false, error: `Gupshup недоступен: ${e?.message ?? String(e)}` };
  }
}

/**
 * Свободный текст. Работает только внутри 24-часового окна — как и у Meta, потому что окно
 * устанавливает Meta, а не провайдер.
 *
 * Длинный ответ уходит несколькими пузырями ПОСЛЕДОВАТЕЛЬНО. Параллельная отправка здесь стоила бы
 * порядка сообщений: WhatsApp доставляет в том порядке, в каком принял, и второй кусок обогнал бы
 * первый. Возвращается идентификатор ПЕРВОГО — на нём потом сходятся статусы доставки.
 */
export async function gupshupSendText(
  creds: GupshupCreds,
  toPhone: string,
  text: string,
): Promise<WaCloudSendResult> {
  const to = toWaCloudRecipient(toPhone);
  if (!to) return { ok: false, error: "empty recipient" };
  const chunks = splitForWhatsApp(text);
  if (chunks.length === 0) return { ok: false, error: "empty text" };

  let first: WaCloudSendResult | null = null;
  for (const chunk of chunks) {
    const res = await gupshupPost(creds, "/api/v1/msg", {
      channel: "whatsapp",
      source: creds.sourceNumber,
      destination: to,
      "src.name": creds.appName,
      message: JSON.stringify({ type: "text", text: chunk }),
    });
    if (!first) first = res;
    // Обрываемся на первой неудаче: хвост ответа без начала читается хуже, чем отсутствие ответа.
    if (!res.ok) return res;
  }
  return first ?? { ok: false, error: "no chunks sent" };
}

/**
 * Картинка по публичной ссылке, с подписью.
 *
 * `previewUrl` Gupshup требует отдельно от `originalUrl`, но в нашем случае это один и тот же файл:
 * QR предоплаты лежит в публичном бакете и уже маленький. Отдельное превью пришлось бы генерировать
 * и хранить ради поля, которое клиент не увидит.
 */
export async function gupshupSendImage(
  creds: GupshupCreds,
  toPhone: string,
  imageUrl: string,
  caption?: string | null,
): Promise<WaCloudSendResult> {
  const to = toWaCloudRecipient(toPhone);
  if (!to) return { ok: false, error: "empty recipient" };

  return gupshupPost(creds, "/api/v1/msg", {
    channel: "whatsapp",
    source: creds.sourceNumber,
    destination: to,
    "src.name": creds.appName,
    message: JSON.stringify({
      type: "image",
      originalUrl: imageUrl,
      previewUrl: imageUrl,
      ...(caption?.trim() ? { caption: caption.trim() } : {}),
    }),
  });
}

/**
 * Шаблон — единственный способ написать клиенту вне 24-часового окна.
 *
 * ПОРЯДОК `params` ЕСТЬ КОНТРАКТ. Он должен совпадать с {{1}}…{{n}} одобренного шаблона ровно, иначе
 * Meta отвечает отказом, а не подставляет что придётся. Тот же контракт уже зафиксирован в
 * supabase/functions/send-whatsapp/index.ts, и менять его надо в обоих местах разом.
 *
 * Обратите внимание: Gupshup адресует шаблон по ЕГО идентификатору, а не по имени, как Meta. Имя
 * шаблона, которое салон видит в кабинете, здесь не подойдёт.
 */
export async function gupshupSendTemplate(
  creds: GupshupCreds,
  toPhone: string,
  templateId: string,
  params: string[] = [],
): Promise<WaCloudSendResult> {
  const to = toWaCloudRecipient(toPhone);
  if (!to) return { ok: false, error: "empty recipient" };
  if (!templateId) return { ok: false, error: "Gupshup: не указан идентификатор шаблона" };

  return gupshupPost(creds, "/api/v1/template/msg", {
    source: creds.sourceNumber,
    destination: to,
    "src.name": creds.appName,
    template: JSON.stringify({ id: templateId, params }),
  });
}

/**
 * Скачать вложение по ссылке из события.
 *
 * Без токена Meta — и это правильно, а не упущение: токен принадлежит Gupshup, у нас его нет и по
 * условиям схемы не будет. Ссылка в событии уже подписана.
 *
 * Ограничение по размеру проверяется ДВАЖДЫ — по заголовку и по факту. Content-Length можно не
 * прислать или соврать, а решение «не тянуть 40 мегабайт в память воркера» принимать надо до
 * того, как они там окажутся.
 */
export async function gupshupFetchMedia(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > 0 && declared > maxBytes) return null;

    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;

    return {
      bytes: new Uint8Array(ab),
      mime: (res.headers.get("content-type") ?? "").split(";")[0].trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Проверка реквизитов живым вызовом.
 *
 * Отправлять ничего нельзя — проверка не должна писать клиентам, — поэтому спрашиваем у Gupshup
 * список шаблонов приложения. Это самый дешёвый вызов, который доказывает разом три вещи: ключ
 * действителен, приложение существует, и ключ имеет к нему доступ.
 *
 * Возвращает число шаблонов, потому что ноль — это не ошибка подключения, но это ровно то, из-за
 * чего потом не уйдёт подтверждение записи вне окна.
 */
export async function gupshupTestConnection(
  creds: GupshupCreds,
  appId: string,
): Promise<{ ok: true; templateCount: number } | { ok: false; error: string }> {
  if (!creds.apiKey) return { ok: false, error: "Не заполнен API-ключ" };
  if (!appId) return { ok: false, error: "Не заполнен App ID" };

  try {
    const res = await fetch(`${gupshupBase()}/app/${encodeURIComponent(appId)}/template`, {
      headers: { apikey: creds.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* см. ниже — сырой текст пойдёт в сообщение */
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Gupshup не принял ключ — проверьте API Key в кабинете" };
    }
    if (res.status === 404) {
      return { ok: false, error: "Gupshup не знает такой App ID" };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `Gupshup ответил ${res.status}: ${parsed?.message ?? raw.slice(0, 150)}`,
      };
    }

    const list = Array.isArray(parsed?.templates) ? parsed.templates : [];
    return { ok: true, templateCount: list.length };
  } catch (e: any) {
    return { ok: false, error: `Gupshup недоступен: ${e?.message ?? String(e)}` };
  }
}
