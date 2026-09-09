// Как ассистент разговаривает с клиентом в WhatsApp — отдельно от того, ЧТО он говорит.
//
// Зачем это существует. Пайплайн один: в нём живут блокировка диалога, слив накопившихся
// сообщений, один ход агента на пачку, распознавание голоса, оценка по фото, QR предоплаты.
// Копировать его ради второго способа отправки — значит завести две версии, которые разъедутся
// на первой же правке и разъедутся молча. Поэтому пайплайн остаётся один, а меняется только
// транспорт: четыре функции, которыми маршрут трогает внешний мир.
//
// Транспортов два. `cloud` — прямой Cloud API, основной путь после того, как Meta одобрила
// приложение Qabyl (07.09.2026). `gupshup` — путь через BSP для салона, которому Embedded Signup
// недоступен: например, потому что его WABA принадлежит нашему же бизнес-портфолио.
//
// Третьим был мост через Make — обход на время ожидания App Review. Удалён 09.09.2026 вместе с
// маршрутом /api/public/wamake: одобрение получено, ни один салон на мосту не стоял. Колонки
// salon_secrets.wa_make_* оставлены в базе, чтобы не трогать её ради этого.
import {
  WA_TEXT_LIMIT,
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
  readonly kind: "cloud" | "gupshup";
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

// ---------------------------------------------------------------------------
// Gupshup
// ---------------------------------------------------------------------------

export type GupshupTransportConfig = {
  /** Ключ Access API аккаунта Qabyl. Один на весь аккаунт — потому и не должен утекать. */
  apiKey: string;
  /** Номер салона: только цифры, с кодом страны. */
  sourceNumber: string;
  /** Имя приложения Gupshup, к которому привязан номер. */
  appName: string;
  /**
   * Ссылки на вложения, снятые с входящего события: идентификатор → URL.
   *
   * У Meta вебхук несёт media id, который разрешается через Graph с токеном. Здесь токен Meta
   * принадлежит Gupshup, у нас его нет, и разрешать нечем — но и не нужно: Gupshup кладёт ссылку
   * прямо в событие. Карта живёт один запрос: держать чужие ссылки дольше незачем, тем более что
   * они подписаны и протухают.
   */
  media?: Map<string, string>;
};

/**
 * Транспорт поверх Gupshup — то, чем будут говорить салоны на время ожидания Advanced Access.
 *
 * Отличий от облачного два, и оба видны прямо в реализации:
 *
 *   • `markReadAndTyping` не делает ничего. У Access API нет ни отметки о прочтении, ни индикатора
 *     набора. Плата за схему честная и известна заранее: ход агента занимает
 *     несколько секунд, и всё это время диалог выглядит пустым. Молча ничего не делаем, а не
 *     притворяемся, что получилось.
 *
 *   • `fetchMedia` ищет в карте ссылок, а не ходит в Graph. Проверка размера остаётся, потому что
 *     ссылка приходит снаружи и может указывать на что угодно.
 */
export function gupshupTransport(cfg: GupshupTransportConfig): WaTransport {
  const missing = [
    cfg.apiKey ? null : "API-ключ Gupshup",
    cfg.sourceNumber ? null : "номер отправителя",
    cfg.appName ? null : "имя приложения Gupshup",
  ]
    .filter(Boolean)
    .join(", ");

  const creds = { apiKey: cfg.apiKey, sourceNumber: cfg.sourceNumber, appName: cfg.appName };

  return {
    kind: "gupshup",
    ready: Boolean(cfg.apiKey && cfg.sourceNumber && cfg.appName),
    missing,

    async sendText(toPhone, text) {
      const { gupshupSendText } = await import("@/lib/wa-gupshup.server");
      return gupshupSendText(creds, toPhone, text);
    },

    async sendImage(toPhone, imageUrl, caption) {
      const { gupshupSendImage } = await import("@/lib/wa-gupshup.server");
      return gupshupSendImage(creds, toPhone, imageUrl, caption);
    },

    // Через Access API недоступно — см. комментарий выше.
    async markReadAndTyping() {
      /* недоступно через Gupshup */
    },

    async fetchMedia(ref, maxBytes) {
      const url = cfg.media?.get(ref);
      if (!url) return null;
      const { gupshupFetchMedia } = await import("@/lib/wa-gupshup.server");
      return gupshupFetchMedia(url, maxBytes);
    },
  };
}
