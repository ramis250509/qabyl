// Один вход в Graph API на весь проект: версия, разбор ошибки, ретраи.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. До него каждый вызывающий писал свои три строки — свою `graphBase()`, свою
// проверку `json?.error`, свою формулировку. Их стало четыре штуки, и они уже разъехались: где-то
// версия v25.0, где-то v23.0, где-то ошибка Meta с HTTP 200 проходила как успех.
//
// ЧТО ЗДЕСЬ ВАЖНО ЗНАТЬ ПРО GRAPH API
//
//   • Ошибка приезжает с HTTP 200 не реже, чем с 4xx. Судить по `res.ok` нельзя, и это главная
//     причина, по которой сырой fetch сюда не годится.
//   • Коды ошибок делятся на три сорта, и лечатся они по-разному: временные (переживают ретрай),
//     постоянные (ретрай только тратит время и лимит запросов) и «токен больше не действует»
//     (ретраить бессмысленно, надо звать владельца переподключаться). Различение живёт в
//     classifyGraphError и больше нигде.
//   • Лимит запросов у Meta — 200–5000 в час на приложение в зависимости от статуса аккаунта.
//     Поэтому ретраим только то, что имеет шанс, и с паузами, а не подряд.

/** Версия Graph API. Одно место на весь проект — иначе половина вызовов уезжает в прошлое. */
export function graphVersion(): string {
  return process.env.WA_CLOUD_API_VERSION || "v25.0";
}

export function graphBase(): string {
  return `https://graph.facebook.com/${graphVersion()}`;
}

/** Во что превращается любой неудачный ответ Meta. */
export type GraphError = {
  /** Числовой код Meta. null — сети не было вовсе или ответ не разобрался. */
  code: number | null;
  subcode: number | null;
  /** Сообщение Meta как есть. Для логов и поддержки, НЕ для показа владельцу. */
  message: string;
  /** HTTP-статус, если ответ вообще пришёл. */
  status: number | null;
  /**
   * Что с этим делать:
   *   retryable — повторить позже, само пройдёт (сеть, 429, 5xx, «попробуйте ещё раз»);
   *   auth     — токен отозван или прав не хватает: ретрай не поможет, нужен человек;
   *   fatal    — запрос неправильный по существу: ретрай не поможет, нужен код.
   */
  kind: "retryable" | "auth" | "fatal";
};

export type GraphResult<T = any> = { ok: true; data: T } | { ok: false; error: GraphError };

/**
 * Коды Meta, означающие «токен больше не действует».
 *
 * 190 — общий OAuthException: отозван, протух, сменился пароль, бизнес удалил приложение.
 * 102 — сессия не действительна.
 * 10 / 200 / 299 — прав не хватает. Формально это не протухший токен, но лечится тем же:
 *   владелец проходит подключение заново и выдаёт то, чего не хватило. Ретрай не поможет ни при
 *   каком из них, и это единственное, что важно для решения.
 */
const AUTH_CODES = new Set([10, 102, 190, 200, 299]);

/**
 * Коды, которые проходят сами.
 *
 * 1 / 2 — «неизвестная» и «временная» ошибки Meta, их официальная рекомендация — повторить.
 * 4 / 17 / 32 / 613 — исчерпан лимит запросов приложения, пользователя или бизнеса.
 * 80007 — лимит бизнес-вызовов WhatsApp.
 * 131016 — сервис временно недоступен.
 * 131047 сюда НЕ входит намеренно: это «вне окна 24 часов», и повтор через минуту его не чинит.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613, 80007, 131016]);

function classifyGraphError(code: number | null, status: number | null): GraphError["kind"] {
  if (code !== null && AUTH_CODES.has(code)) return "auth";
  if (code !== null && RETRYABLE_CODES.has(code)) return "retryable";
  // 429 и всё пятисотое — временные по определению, каким бы ни был код внутри тела.
  if (status === 429 || (status !== null && status >= 500)) return "retryable";
  return "fatal";
}

/** Разбирает ответ Graph API. Ошибка Meta с HTTP 200 — штатный случай, а не исключение. */
async function parseGraph<T>(res: Response): Promise<GraphResult<T>> {
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    // Тело не разобралось. Если статус успешный — считаем пустым успехом (так отвечают некоторые
    // POST без полей); если нет — это ошибка без подробностей.
    if (res.ok) return { ok: true, data: {} as T };
    return {
      ok: false,
      error: {
        code: null,
        subcode: null,
        message: `HTTP ${res.status}`,
        status: res.status,
        kind: classifyGraphError(null, res.status),
      },
    };
  }

  const err = json?.error;
  if (!res.ok || err) {
    const code = Number.isFinite(Number(err?.code)) ? Number(err.code) : null;
    const subcode = Number.isFinite(Number(err?.error_subcode)) ? Number(err.error_subcode) : null;
    return {
      ok: false,
      error: {
        code,
        subcode,
        // error_user_msg — то, что Meta сама считает пригодным для показа. Берём его первым.
        message: String(err?.error_user_msg || err?.message || `HTTP ${res.status}`),
        status: res.status,
        kind: classifyGraphError(code, res.status),
      },
    };
  }

  return { ok: true, data: json as T };
}

export type GraphCallOptions = {
  method?: "GET" | "POST" | "DELETE";
  /** Токен. Отсутствие — не исключение: часть вызовов идёт по app-токену в query. */
  token?: string | null;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /**
   * Сколько раз повторить при `retryable`. По умолчанию два повтора: три попытки всего.
   * Ноль — для вызовов, где повтор дороже отказа (например, создание, которое не идемпотентно).
   */
  retries?: number;
  /** Потолок ожидания одного запроса. Meta иногда держит соединение минутами. */
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Вызов Graph API с ретраями.
 *
 * Пауза растёт экспоненциально и с разбросом: 400 мс, 900 мс, 1900 мс ± 25 %. Разброс не
 * украшение — без него десять салонов, у которых подключение упало на одном и том же 429,
 * повторяют запрос в одну и ту же миллисекунду и получают 429 снова.
 */
export async function graphCall<T = any>(
  path: string,
  opts: GraphCallOptions = {},
): Promise<GraphResult<T>> {
  const { method = "GET", token, body, query, retries = 2, timeoutMs = 20000 } = opts;

  const url = new URL(`${graphBase()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  let last: GraphResult<T> = {
    ok: false,
    error: {
      code: null,
      subcode: null,
      message: "запрос не выполнялся",
      status: null,
      kind: "fatal",
    },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const base = 400 * Math.pow(2.2, attempt - 1);
      await sleep(Math.round(base * (0.75 + Math.random() * 0.5)));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      last = await parseGraph<T>(res);
    } catch (e) {
      // Сеть не дошла или сработал таймаут. Ретраим: это ровно тот случай, ради которого ретраи и
      // существуют, и отличить «Meta лежит» от «у воркера моргнула сеть» отсюда всё равно нельзя.
      const aborted = (e as Error)?.name === "AbortError";
      last = {
        ok: false,
        error: {
          code: null,
          subcode: null,
          message: aborted ? `Meta не ответила за ${timeoutMs} мс` : (e as Error).message,
          status: null,
          kind: "retryable",
        },
      };
    } finally {
      clearTimeout(timer);
    }

    if (last.ok) return last;
    if (last.error.kind !== "retryable") return last;
  }

  return last;
}

/**
 * Причина отказа на языке владельца салона.
 *
 * Сознательно НЕ показывает код и не пересказывает Meta дословно: «(#100) Tried accessing
 * nonexisting field» ничего не объясняет тому, кто не открывал Graph Explorer. Задача строки —
 * сказать, что делать дальше. Код и оригинал уходят в журнал, где им и место.
 */
export function humanGraphError(err: GraphError): string {
  if (err.kind === "auth") {
    return "Qabyl больше не имеет доступа к вашему WhatsApp. Скорее всего, доступ отозвали в настройках Meta. Подключите WhatsApp заново.";
  }
  if (err.kind === "retryable") {
    return "Meta сейчас не отвечает. Мы повторили запрос несколько раз — попробуйте ещё раз через минуту.";
  }
  // Частые «постоянные» коды, у которых есть внятное человеческое объяснение.
  switch (err.code) {
    case 131042:
      return "К вашему аккаунту WhatsApp не привязан способ оплаты. Пока его нет, Meta не отправит ни одного сообщения.";
    case 131047:
      return "С момента последнего сообщения клиента прошло больше 24 часов. Написать первым можно только заранее одобренным шаблоном.";
    case 131026:
      return "У этого номера нет WhatsApp — сообщение доставить некуда.";
    case 132000:
      return "Шаблон не совпадает с тем, что одобрила Meta: изменилось число переменных. Создайте шаблоны заново.";
    case 133010:
      return "Номер ещё не зарегистрирован в WhatsApp Business API. Подключите его заново.";
    default:
      return err.message;
  }
}
