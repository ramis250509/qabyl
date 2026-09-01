// Как ассистент разговаривает с клиентом в WhatsApp — отдельно от того, ЧТО он говорит.
//
// Зачем это существует. Пока App Review не одобрен, наше приложение имеет Standard Access, а он
// по правилам Meta покрывает только WABA, принадлежащие нашему бизнес-портфолио: обращение к
// чужой возвращает ошибку 200. Значит подключить салон к Cloud API напрямую мы не можем, и на
// время ожидания между нами и Meta встаёт Make — у него своё одобренное приложение.
//
// Соблазн был скопировать маршрут и заменить в копии отправку. Это худший вариант из возможных:
// в облачном маршруте живёт весь пайплайн — блокировка диалога, слив накопившихся сообщений,
// один ход агента на пачку, распознавание голоса, оценка по фото, QR предоплаты. Две копии
// разъезжаются на первой же правке, и разъезжаются молча.
//
// Поэтому пайплайн остаётся один, а меняется только транспорт: четыре функции, которыми маршрут
// трогает внешний мир. Cloud-реализация ходит в Graph API, Make-реализация — в сценарий Make.
// Когда придёт Advanced Access, Make-транспорт удаляется одним файлом, и маршрут этого не
// заметит.
import {
  splitForWhatsApp,
  toWaCloudRecipient,
  waCloudFetchMedia,
  waCloudMarkReadAndTyping,
  waCloudSendImage,
  waCloudSendMessage,
  type WaCloudCreds,
  type WaCloudSendResult,
} from "@/lib/wa-cloud.server";

export type WaMedia = { bytes: Uint8Array; mime: string };

export type WaTransport = {
  /** Чем транспорт представляется в логах и ошибках. */
  readonly kind: "cloud" | "make";
  /** Готов ли транспорт отправлять. Пустые реквизиты — не исключение, а штатное «не подключён». */
  readonly ready: boolean;
  /** Что именно не заполнено, если `ready === false`. Идёт владельцу в журнал ошибок. */
  readonly missing: string;
  sendText(toPhone: string, text: string): Promise<WaCloudSendResult>;
  sendImage(toPhone: string, imageUrl: string, caption?: string | null): Promise<WaCloudSendResult>;
  /** Косметика: «прочитано» и «печатает…». Никогда не бросает и никого не задерживает. */
  markReadAndTyping(messageId: string): Promise<void>;
  fetchMedia(ref: string, maxBytes: number): Promise<WaMedia | null>;
};

/** Транспорт поверх Cloud API — то, как работали все салоны до появления моста. */
export function cloudTransport(creds: WaCloudCreds): WaTransport {
  const missing = [
    creds.phoneNumberId ? null : "Phone Number ID",
    creds.token ? null : "токен Cloud API",
  ]
    .filter(Boolean)
    .join(" и ");

  return {
    kind: "cloud",
    ready: Boolean(creds.phoneNumberId && creds.token),
    missing,
    sendText: (to, text) => waCloudSendMessage(creds, to, text),
    sendImage: (to, url, caption) => waCloudSendImage(creds, to, url, caption),
    markReadAndTyping: (id) => waCloudMarkReadAndTyping(creds, id),
    fetchMedia: (id, max) => waCloudFetchMedia(creds, id, max),
  };
}

export type MakeTransportConfig = {
  /** Адрес custom webhook сценария Make, который умеет отправлять. */
  outboundUrl: string;
  /**
   * Общий секрет. Уходит заголовком, чтобы сценарий Make мог отбросить чужой запрос: адрес
   * вебхука Make не секрет — он попадает в историю браузера и в переписку при настройке.
   */
  token: string;
  /**
   * Медиа, которые Make уже скачал и приложил к входящему. Ключ — тот же идентификатор, что
   * лежит в событии.
   *
   * Через Make мы не можем забрать файл сами: токен доступа к Graph API остаётся внутри Make,
   * это и есть цена всей схемы. Поэтому картинки и голосовые приезжают в теле запроса, а карта
   * живёт ровно один запрос — держать чужие байты дольше незачем.
   */
  media?: Map<string, WaMedia>;
};

/**
 * Транспорт поверх Make.
 *
 * Отправка — это POST в custom webhook сценария, который на той стороне вызывает модуль
 * WhatsApp Business Cloud. Ответ Make приходит раньше, чем сообщение реально уходит, поэтому
 * `messageId` мы не получаем. Последствие honest: у салонов на мосту не работает сверка
 * статусов доставки — она сшивается по `confirmation_message_id`, которого здесь нет. Ради
 * временной схемы это дешевле, чем второй обмен ради одного идентификатора.
 */
export function makeTransport(cfg: MakeTransportConfig): WaTransport {
  const missing = [cfg.outboundUrl ? null : "адрес вебхука Make", cfg.token ? null : "токен моста"]
    .filter(Boolean)
    .join(" и ");

  async function post(body: Record<string, unknown>): Promise<WaCloudSendResult> {
    if (!cfg.outboundUrl) return { ok: false, error: "Make outbound URL не задан" };
    try {
      const res = await fetch(cfg.outboundUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Qabyl-Token": cfg.token,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        return { ok: false, error: `Make ответил ${res.status}: ${detail || "без тела"}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Make недоступен: ${(e as Error).message}` };
    }
  }

  return {
    kind: "make",
    ready: Boolean(cfg.outboundUrl && cfg.token),
    missing,

    // Режем текст здесь, а не на стороне Make: лимит WhatsApp тот же самый, а сценарий, который
    // умеет резать по словам, пришлось бы собирать мышкой в каждом салоне.
    async sendText(toPhone, text) {
      const to = toWaCloudRecipient(toPhone);
      if (!to) return { ok: false, error: "empty recipient" };
      const chunks = splitForWhatsApp(text);
      if (chunks.length === 0) return { ok: false, error: "empty text" };

      let firstError: string | null = null;
      for (const chunk of chunks) {
        const res = await post({ type: "text", to, text: chunk });
        if (!res.ok && firstError === null) firstError = res.error;
      }
      return firstError ? { ok: false, error: firstError } : { ok: true };
    },

    async sendImage(toPhone, imageUrl, caption) {
      const to = toWaCloudRecipient(toPhone);
      if (!to) return { ok: false, error: "empty recipient" };
      return post({
        type: "image",
        to,
        url: imageUrl,
        ...(caption?.trim() ? { caption: caption.trim() } : {}),
      });
    },

    // Через мост «печатает…» не показать: у Make нет модуля для индикатора набора, а слать
    // ради него отдельный вызов — значит платить кредитами за анимацию. Молча ничего не делаем.
    async markReadAndTyping() {
      /* недоступно через Make */
    },

    async fetchMedia(ref, maxBytes) {
      const hit = cfg.media?.get(ref);
      if (!hit) return null;
      if (hit.bytes.byteLength > maxBytes) return null;
      return hit;
    },
  };
}
