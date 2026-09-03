// Приведение событий Gupshup к конверту Meta — и решение, что из них вообще попадает в пайплайн.
//
// ЗАЧЕМ ЭТО СУЩЕСТВУЕТ. Весь разбор входящих у нас написан под форму Meta: parseWaCloudWebhook и
// parseWaCloudEchoes умеют object/entry/changes/value и ничего другого знать не должны. Gupshup
// доставляет события в ДВУХ формах сразу, и только одна из них совпадает с Meta:
//
//   • Подписка версии 3 («passthrough») отдаёт конверт Meta почти дословно — плюс своё поле gs_id
//     рядом с метовским id. Её и берём за основу: парсеры переиспользуются без единой правки.
//   • Подписка версии 2 отдаёт плоскую собственную форму. Она нужна не вместо, а ВДОБАВОК: только
//     в ней приезжают признаки тарификации (pricing, conversation), из которых на втором этапе
//     будет считаться стоимость разговора.
//
// Gupshup прямо предупреждает, что при двух подписках одно событие придёт дважды и дедупликация —
// на нашей стороне. Она у нас уже есть: частичный уникальный индекс на (salon_id,
// green_api_message_id). Поэтому нормализуем обе формы в одну и позволяем дублю честно упереться
// в базу, вместо того чтобы городить второй механизм.
//
// ЧТО НЕ ПОПАДАЕТ В ПАЙПЛАЙН, и это осознанно:
//
//   history            — выгрузка старой переписки после онбординга. Пропустить её через агента
//                        значит ответить на сообщения полугодовой давности. Сохраняем в карантин,
//                        разбор оставляем на этап 2.
//   smb_app_state_sync — синхронизация контактов и состояния приложения. Сообщений не содержит.
//   billing-event      — деньги. Учёт расходов — этап 2; пока копим сырьё.
//
// Единственное коэкзистенс-событие, которое ОБЯЗАНО дойти до пайплайна, — smb_message_echoes:
// это сигнал «владелец ответил сам», и без него ассистент будет писать клиенту параллельно с
// живым человеком.

/** Что мы поняли про пришедшее событие. Одна доставка может содержать несколько видов сразу. */
export type GupshupEventKind =
  | "message"
  | "status"
  | "echo"
  | "history"
  | "app_state_sync"
  | "billing"
  | "user_event"
  | "unknown";

export type GupshupNormalized = {
  /**
   * Конверт Meta для processWaCloudPayload, либо null — когда в доставке не было ничего, что
   * пайплайну положено видеть (только история, только биллинг, только служебное событие).
   */
  payload: Record<string, unknown> | null;
  /** Виды, найденные в этой доставке. Пустой массив невозможен: неопознанное даёт ["unknown"]. */
  kinds: GupshupEventKind[];
  /** Идентификатор вложения → ссылка, по которой его забирать. Живёт ровно один запрос. */
  media: Map<string, string>;
  /** Метовский wamid → собственный идентификатор Gupshup. Ложится в wa_messages.provider_message_id. */
  gsIds: Map<string, string>;
  /** Имя приложения Gupshup. Есть только в форме V2 — в конверте Meta его нет по определению. */
  appName: string | null;
  /** Идентификатор номера. В V3 приходит из metadata, в V2 подставляется из номера отправителя. */
  phoneNumberId: string | null;
  /** Идентификатор WABA — только из V3 (`entry[].id`). */
  wabaId: string | null;
  /** Чем это событие называется у провайдера. Идёт в карантин как есть. */
  eventType: string | null;
  /** За что зацепиться при разборе: wamid, gsId или идентификатор события. */
  externalId: string | null;
};

/** Статусы Gupshup, в которых `payload.id` означает метовский wamid, а не собственный gsId. */
const DLR_STATUSES = new Set(["sent", "delivered", "read", "deleted"]);

/** Статусы, у которых в форме Meta нет соответствия. Пропускаем молча, а не выдумываем перевод. */
const IGNORED_STATUSES = new Set(["enqueued"]);

function metaEnvelope(field: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field, value }] }],
  };
}

/**
 * Главный вход. Принимает то, что прислал Gupshup, отдаёт то, что понимает пайплайн.
 *
 * Никогда не бросает: неизвестная форма — это штатный исход, который должен закончиться записью в
 * карантин, а не пятисоткой в ответ Gupshup'у. Пятисотка заставила бы его слать ту же пачку по
 * кругу.
 */
export function normalizeGupshupEvent(body: any): GupshupNormalized {
  const media = new Map<string, string>();
  const gsIds = new Map<string, string>();

  const empty = (kind: GupshupEventKind, eventType: string | null): GupshupNormalized => ({
    payload: null,
    kinds: [kind],
    media,
    gsIds,
    appName: body?.app ? String(body.app) : null,
    phoneNumberId: null,
    wabaId: null,
    eventType,
    externalId: null,
  });

  if (!body || typeof body !== "object") return empty("unknown", null);

  // ---- Форма V3: конверт Meta. Пропускаем почти как есть.
  if (body?.object === "whatsapp_business_account" && Array.isArray(body?.entry)) {
    return normalizePassthrough(body, media, gsIds);
  }

  // ---- Форма V2: плоский конверт Gupshup.
  const type = body?.type ? String(body.type) : null;
  const payload = body?.payload;

  switch (type) {
    case "message":
      return normalizeV2Message(body, payload, media, gsIds);
    case "message-event":
      return normalizeV2Status(body, payload, media, gsIds);
    case "billing-event":
      return empty("billing", type);
    case "user-event":
      return empty("user_event", type);
    default:
      return empty("unknown", type);
  }
}

/**
 * Конверт Meta от подписки V3.
 *
 * Правки ровно две, и обе — вытаскивание того, чего у чистой Meta нет: собственного идентификатора
 * Gupshup из статусов и ссылок на вложения. Сама структура не трогается: любое «улучшение» здесь
 * означает, что parseWaCloudWebhook начнёт видеть не то, что видит на прямом Cloud API, и два
 * канала разъедутся молча.
 */
function normalizePassthrough(
  body: any,
  media: Map<string, string>,
  gsIds: Map<string, string>,
): GupshupNormalized {
  const kinds = new Set<GupshupEventKind>();
  let phoneNumberId: string | null = null;
  let wabaId: string | null = null;
  let externalId: string | null = null;
  const fields: string[] = [];

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    if (!wabaId && entry?.id) wabaId = String(entry.id);

    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const field = change?.field ? String(change.field) : "";
      const value = change?.value;
      if (field) fields.push(field);
      if (!value) continue;

      if (!phoneNumberId && value?.metadata?.phone_number_id) {
        phoneNumberId = String(value.metadata.phone_number_id);
      }

      switch (field) {
        case "messages": {
          if (Array.isArray(value.messages) && value.messages.length) kinds.add("message");
          if (Array.isArray(value.statuses) && value.statuses.length) kinds.add("status");

          for (const msg of Array.isArray(value.messages) ? value.messages : []) {
            if (!externalId && msg?.id) externalId = String(msg.id);
            // Вложение может приехать ссылкой вместо идентификатора: Gupshup держит токен Meta у
            // себя, и разрешать media id через Graph нам нечем. Регистрируем ссылку под тем же
            // ключом, по которому её потом спросит транспорт.
            registerMediaFromMetaMessage(msg, media);
          }

          for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
            const id = st?.id ? String(st.id) : null;
            const gsId = st?.gs_id ?? st?.gsId;
            if (id && gsId) gsIds.set(id, String(gsId));
            if (!externalId && id) externalId = id;
          }
          break;
        }
        case "smb_message_echoes": {
          kinds.add("echo");
          for (const e of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
            if (!externalId && e?.id) externalId = String(e.id);
          }
          break;
        }
        case "history":
          kinds.add("history");
          break;
        case "smb_app_state_sync":
          kinds.add("app_state_sync");
          break;
        default:
          kinds.add("unknown");
      }
    }
  }

  // История и синхронизация состояния до агента не доходят. Причина в шапке файла: прогнать
  // выгруженную переписку через ассистента значит ответить на всё, что клиент писал до нас.
  const forPipeline = [...kinds].some((k) => k === "message" || k === "status" || k === "echo");

  return {
    payload: forPipeline ? stripNonPipelineFields(body) : null,
    kinds: kinds.size ? [...kinds] : ["unknown"],
    media,
    gsIds,
    appName: body?.app ? String(body.app) : null,
    phoneNumberId,
    wabaId,
    eventType: fields.join(",") || null,
    externalId,
  };
}

/**
 * Выкинуть из конверта поля, которым в пайплайне делать нечего.
 *
 * Нужно потому, что одна доставка Meta может смешать эхо владельца с выгрузкой истории. Отдать
 * такую пачку целиком — значит скормить историю тем же парсерам, а они не обязаны про неё знать.
 */
function stripNonPipelineFields(body: any): Record<string, unknown> {
  const keep = new Set(["messages", "smb_message_echoes"]);
  return {
    ...body,
    entry: (Array.isArray(body.entry) ? body.entry : []).map((entry: any) => ({
      ...entry,
      changes: (Array.isArray(entry?.changes) ? entry.changes : []).filter((c: any) =>
        keep.has(String(c?.field ?? "")),
      ),
    })),
  };
}

/** Ссылка на вложение в сообщении формы Meta — если Gupshup положил её вместо идентификатора. */
function registerMediaFromMetaMessage(msg: any, media: Map<string, string>): void {
  for (const kind of ["image", "audio", "voice", "video", "document"] as const) {
    const node = msg?.[kind];
    if (!node) continue;
    const url = node?.url ?? node?.link;
    if (!url) continue;
    const id = node?.id ? String(node.id) : `${kind}-${msg?.id ?? "unknown"}`;
    // Идентификатор проставляем и обратно в сообщение: ниже по течению маршрут читает msg.image.id
    // и по нему просит у транспорта байты.
    node.id = id;
    media.set(id, String(url));
  }
}

/** Входящее сообщение клиента в плоской форме V2. */
function normalizeV2Message(
  body: any,
  p: any,
  media: Map<string, string>,
  gsIds: Map<string, string>,
): GupshupNormalized {
  const from = String(p?.source ?? p?.sender?.phone ?? "").replace(/\D/g, "");
  const messageId = p?.id ? String(p.id) : `gs-${Date.now()}`;
  const inner = p?.payload ?? {};
  const kind = String(p?.type ?? "text");

  const msg: Record<string, any> = {
    from,
    id: messageId,
    timestamp: body?.timestamp ? String(Math.floor(Number(body.timestamp) / 1000)) : undefined,
    type: "text",
  };

  switch (kind) {
    case "text":
      msg.text = { body: String(inner?.text ?? "") };
      break;

    case "image":
    case "audio":
    case "voice":
    case "video":
    case "file": {
      // Meta знает "document", Gupshup называет то же самое "file"; голосовое у Gupshup приезжает
      // как "audio" либо "voice" — вниз по течению разбираются оба.
      const metaKind = kind === "file" ? "document" : kind;
      const mediaId = `${metaKind}-${messageId}`;
      msg.type = metaKind;
      msg[metaKind] = {
        id: mediaId,
        ...(inner?.caption ? { caption: String(inner.caption) } : {}),
      };
      if (inner?.url) media.set(mediaId, String(inner.url));
      break;
    }

    case "button_reply":
    case "list_reply": {
      // Нажатие, а не текст: его идентификатор — то, что мы сами задали при отправке, а заголовок
      // — то, что клиент увидел на кнопке.
      msg.type = "interactive";
      const replyKey = kind === "button_reply" ? "button_reply" : "list_reply";
      msg.interactive = {
        [replyKey]: {
          id: String(inner?.id ?? inner?.postbackText ?? ""),
          title: String(inner?.title ?? inner?.reply ?? ""),
        },
      };
      break;
    }

    default:
      // Стикер, геометка, контакт. Текста нет — маршрут такое сообщение штатно пропускает, но
      // строку в карантине оно заслуживает.
      msg.text = inner?.text ? { body: String(inner.text) } : undefined;
  }

  const senderName = p?.sender?.name ? String(p.sender.name) : null;

  const value: Record<string, unknown> = {
    // В форме V2 идентификатора номера нет. Подставляем сам номер: маршрут использует это значение
    // только для сверки с реквизитами салона, а не для обращения к API.
    metadata: { phone_number_id: String(p?.source ?? "") },
    ...(senderName ? { contacts: [{ wa_id: from, profile: { name: senderName } }] } : {}),
    messages: [msg],
  };

  return {
    payload: metaEnvelope("messages", value),
    kinds: ["message"],
    media,
    gsIds,
    appName: body?.app ? String(body.app) : null,
    phoneNumberId: p?.source ? String(p.source) : null,
    wabaId: null,
    eventType: "message",
    externalId: messageId,
  };
}

/** Событие о судьбе отправленного сообщения в плоской форме V2. */
function normalizeV2Status(
  body: any,
  p: any,
  media: Map<string, string>,
  gsIds: Map<string, string>,
): GupshupNormalized {
  const status = String(p?.type ?? "").toLowerCase();

  // ЛОВУШКА, РАДИ КОТОРОЙ НАПИСАНА ЭТА ФУНКЦИЯ. Поле payload.id означает разное в разных событиях:
  // в sent/delivered/read/deleted это метовский wamid, а в enqueued/failed — собственный gsId
  // Gupshup. Сложить оба в одну колонку значит однажды принять событие о доставке за дубль
  // входящего сообщения и молча его проглотить.
  //
  // Правило устойчивее, чем список статусов: если gsId приехал отдельным полем, то id — метовский;
  // если отдельного поля нет, то id и есть gsId, а метовского мы просто ещё не знаем.
  const rawId = p?.id ? String(p.id) : null;
  const rawGsId = p?.gsId ?? p?.gs_id;
  const gsId = rawGsId ? String(rawGsId) : DLR_STATUSES.has(status) ? null : rawId;
  const wamid = rawGsId ? rawId : DLR_STATUSES.has(status) ? rawId : null;

  if (wamid && gsId) gsIds.set(wamid, gsId);

  const base: GupshupNormalized = {
    payload: null,
    kinds: ["status"],
    media,
    gsIds,
    appName: body?.app ? String(body.app) : null,
    phoneNumberId: null,
    wabaId: null,
    eventType: `message-event:${status || "unknown"}`,
    externalId: wamid ?? gsId,
  };

  // enqueued — внутреннее состояние очереди Gupshup, у Meta соответствия нет. Придумывать перевод
  // нельзя: mapWaCloudDeliveryStatus намеренно игнорирует "sent", чтобы более поздний "delivered"
  // не затирался пришедшим не по порядку событием, и лишний статус сломал бы эту защиту.
  if (!status || IGNORED_STATUSES.has(status)) return base;

  // Без метовского идентификатора статус не к чему привязать: вся сверка доставки построена на
  // wamid. Не теряем — отправляем в карантин через kinds/externalId.
  if (!wamid) return base;

  const errPayload = p?.payload;
  const errors =
    status === "failed"
      ? [
          {
            code: Number(errPayload?.code) || undefined,
            title: errPayload?.reason ? String(errPayload.reason) : undefined,
          },
        ]
      : undefined;

  const value: Record<string, unknown> = {
    metadata: { phone_number_id: String(p?.destination ?? "") },
    statuses: [
      {
        id: wamid,
        gs_id: gsId ?? undefined,
        status,
        recipient_id: p?.destination ? String(p.destination) : undefined,
        timestamp: errPayload?.ts ? String(errPayload.ts) : undefined,
        ...(errors ? { errors } : {}),
      },
    ],
  };

  return { ...base, payload: metaEnvelope("messages", value) };
}

// ---------------------------------------------------------------------------
// Безопасное хранение
// ---------------------------------------------------------------------------

/** Ключи, значение которых нельзя класть в базу ни при каких обстоятельствах. */
const SECRET_KEY_RE = /(api[-_]?key|apikey|token|secret|password|authorization|credential)/i;

/**
 * Убрать из полезной нагрузки всё, что не должно пережить запись в карантин.
 *
 * Две вещи, и обе не гипотетические:
 *
 *   1. КЛЮЧИ. Сам Gupshup ключа в теле не присылает, но событие иногда содержит эхо нашего же
 *      запроса, а в запросе живёт apikey. Полагаться на «он туда не попадёт» — значит однажды
 *      обнаружить ключ аккаунта в таблице, у которой другой срок жизни, чем у ключа.
 *
 *   2. ССЫЛКИ НА ВЛОЖЕНИЯ. Они подписаны: строка запроса и есть пропуск к чужой фотографии.
 *      Обрезаем её, оставляя путь — по нему видно, что файл был, но открыть его нельзя.
 *
 * Телефон и текст сообщения НЕ вырезаются намеренно. Они уже лежат в wa_messages под той же
 * защитой сервисной роли, а карантин без них перестаёт отвечать на единственный вопрос, ради
 * которого заведён: что именно пришло и почему это не обработалось.
 */
export function redactForStorage(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[too deep]";

  if (Array.isArray(value)) return value.map((v) => redactForStorage(v, depth + 1));

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      if (typeof v === "string" && /^https?:\/\//i.test(v) && v.includes("?")) {
        out[k] = `${v.slice(0, v.indexOf("?"))}?[redacted]`;
        continue;
      }
      out[k] = redactForStorage(v, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Обезличить событие для сохранения в репозиторий как тестовую заготовку.
 *
 * Отдельно от redactForStorage, и это важно. Та защищает строку в нашей базе, где телефон клиента
 * уместен. Эта готовит файл, который уедет в git и будет виден всем, кто когда-либо склонирует
 * репозиторий, — здесь настоящему номеру и настоящей переписке места нет.
 */
export function anonymizeForFixture(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[too deep]";

  if (Array.isArray(value)) return value.map((v) => anonymizeForFixture(v, depth + 1));

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[redacted]";
      } else if (/^(phone|source|destination|wa_id|recipient_id|from|to|dial_code)$/i.test(k)) {
        out[k] = "996700000000";
      } else if (/^(name|profile_name)$/i.test(k)) {
        out[k] = "Тест";
      } else if (/^(text|body|caption)$/i.test(k)) {
        out[k] = "тестовое сообщение";
      } else if (typeof v === "string" && /^https?:\/\//i.test(v)) {
        out[k] = "https://example.invalid/media";
      } else {
        out[k] = anonymizeForFixture(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}
