// Разбор событий Gupshup — граница, на которой чужой формат становится нашим.
//
// Все проверки здесь про одно: пайплайн написан под форму Meta и не должен узнать, что провайдер
// сменился. Если нормализация ошибётся, поломка будет выглядеть не как ошибка разбора, а как
// «ассистент отвечает дважды», «статусы доставки ни с чем не сходятся» или «ИИ спорит с
// владельцем» — то есть как что угодно, кроме своей настоящей причины.
//
// Run: bun test wa-gupshup-events.test.ts

import { describe, expect, test } from "bun:test";
import {
  anonymizeForFixture,
  normalizeGupshupEvent,
  redactForStorage,
} from "./src/lib/wa-gupshup-events.server";
import {
  mapWaCloudDeliveryStatus,
  parseWaCloudEchoes,
  parseWaCloudWebhook,
} from "./src/lib/wa-cloud.server";

/** Плоское событие Gupshup версии 2. */
function v2(type: string, payload: any, app = "QabylWA") {
  return { app, timestamp: 1_756_900_000_000, version: 2, type, payload };
}

describe("V3 passthrough — конверт Meta проходит насквозь", () => {
  const passthrough = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-77",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "77022968987" },
              contacts: [{ wa_id: "996707111726", profile: { name: "Айгуль" } }],
              messages: [
                {
                  from: "996707111726",
                  id: "wamid.ABC",
                  timestamp: "1756900000",
                  type: "text",
                  text: { body: "Здравствуйте, хочу записаться" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  test("существующий парсер Meta разбирает результат без единой правки", () => {
    const n = normalizeGupshupEvent(passthrough);

    // Это и есть вся экономия проекта: parseWaCloudWebhook переиспользуется как есть.
    const parsed = parseWaCloudWebhook(n.payload);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].fromPhone).toBe("996707111726");
    expect(parsed.events[0].wamid).toBe("wamid.ABC");
    expect(parsed.events[0].text).toBe("Здравствуйте, хочу записаться");
    expect(parsed.events[0].profileName).toBe("Айгуль");
  });

  test("вытаскивает WABA и номер — по ним салон подтверждается вторым признаком", () => {
    const n = normalizeGupshupEvent(passthrough);

    expect(n.wabaId).toBe("waba-77");
    expect(n.phoneNumberId).toBe("77022968987");
    expect(n.kinds).toContain("message");
  });

  test("собственный идентификатор Gupshup снимается со статуса отдельно от метовского", () => {
    const n = normalizeGupshupEvent({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-77",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "77022968987" },
                statuses: [
                  {
                    id: "wamid.OUT1",
                    gs_id: "gs-uuid-1",
                    status: "delivered",
                    recipient_id: "996707111726",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(n.gsIds.get("wamid.OUT1")).toBe("gs-uuid-1");
  });
});

describe("Коэкзистенс: эхо владельца", () => {
  const echo = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-77",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              metadata: { phone_number_id: "77022968987" },
              message_echoes: [
                {
                  from: "77022968987",
                  to: "996707111726",
                  id: "wamid.OWNER1",
                  type: "text",
                  timestamp: "1756900100",
                  text: { body: "Да, приходите к 15:00" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  test("эхо доходит до пайплайна — без него ИИ пишет параллельно с живым человеком", () => {
    const n = normalizeGupshupEvent(echo);

    expect(n.kinds).toContain("echo");
    expect(n.payload).not.toBeNull();

    const parsed = parseWaCloudEchoes(n.payload);
    expect(parsed.echoes).toHaveLength(1);
    // Диалог опознаётся по КЛИЕНТУ (to), а не по отправителю: на эхе отправитель — сам салон, и
    // ключ по нему повесил бы паузу не на тот диалог.
    expect(parsed.echoes[0].clientPhone).toBe("996707111726");
    expect(parsed.echoes[0].text).toBe("Да, приходите к 15:00");
  });
});

describe("Коэкзистенс: история и синхронизация состояния", () => {
  test("выгрузка истории сохраняется, но до ассистента НЕ доходит", () => {
    const n = normalizeGupshupEvent({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-77",
          changes: [
            {
              field: "history",
              value: {
                metadata: { phone_number_id: "77022968987" },
                messages: [
                  { from: "996707111726", id: "wamid.OLD", text: { body: "прошлогоднее" } },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(n.kinds).toContain("history");
    // Ключевое: payload пуст. Прогнать выгруженную переписку через агента значит ответить на всё,
    // что клиент писал до нашего появления.
    expect(n.payload).toBeNull();
  });

  test("синхронизация состояния приложения распознаётся и тоже не идёт в агента", () => {
    const n = normalizeGupshupEvent({
      object: "whatsapp_business_account",
      entry: [
        { id: "waba-77", changes: [{ field: "smb_app_state_sync", value: { metadata: {} } }] },
      ],
    });

    expect(n.kinds).toContain("app_state_sync");
    expect(n.payload).toBeNull();
  });

  test("смешанная доставка: эхо проходит, история из того же конверта отсекается", () => {
    // Meta пакует несколько изменений в один POST. Отдать такую пачку целиком значит скормить
    // историю тем же парсерам, которые про неё ничего не знают.
    const n = normalizeGupshupEvent({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-77",
          changes: [
            { field: "history", value: { metadata: {}, messages: [{ id: "wamid.OLD" }] } },
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: "77022968987" },
                message_echoes: [
                  { from: "77022968987", to: "996707111726", id: "wamid.O2", type: "text" },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(n.kinds).toEqual(expect.arrayContaining(["history", "echo"]));
    const fields = (n.payload as any).entry[0].changes.map((c: any) => c.field);
    expect(fields).toEqual(["smb_message_echoes"]);
  });
});

describe("V2 — входящие сообщения", () => {
  test("текст превращается в конверт Meta, который читает наш парсер", () => {
    const n = normalizeGupshupEvent(
      v2("message", {
        id: "wamid.IN1",
        source: "996707111726",
        type: "text",
        payload: { text: "Сколько стоит маникюр?" },
        sender: { phone: "996707111726", name: "Айгуль" },
      }),
    );

    const parsed = parseWaCloudWebhook(n.payload);
    expect(parsed.events[0].text).toBe("Сколько стоит маникюр?");
    expect(parsed.events[0].fromPhone).toBe("996707111726");
    expect(parsed.events[0].profileName).toBe("Айгуль");
    expect(n.appName).toBe("QabylWA");
  });

  test("картинка: ссылка уходит в карту вложений, а в сообщение подставляется идентификатор", () => {
    const n = normalizeGupshupEvent(
      v2("message", {
        id: "wamid.IN2",
        source: "996707111726",
        type: "image",
        payload: { url: "https://media.gupshup.io/a.jpg", caption: "вот такой хочу" },
      }),
    );

    const parsed = parseWaCloudWebhook(n.payload);
    const mediaId = parsed.events[0].imageMediaId!;
    expect(mediaId).toBeTruthy();
    // Транспорт спросит байты именно по этому ключу — связь между событием и загрузкой.
    expect(n.media.get(mediaId)).toBe("https://media.gupshup.io/a.jpg");
    expect(parsed.events[0].text).toBe("вот такой хочу");
  });

  test("голосовое распознаётся и как audio, и как voice", () => {
    for (const kind of ["audio", "voice"]) {
      const n = normalizeGupshupEvent(
        v2("message", {
          id: `wamid.${kind}`,
          source: "996707111726",
          type: kind,
          payload: { url: "https://media.gupshup.io/v.ogg" },
        }),
      );
      const parsed = parseWaCloudWebhook(n.payload);
      expect(parsed.events[0].audioMediaId).toBeTruthy();
    }
  });

  test("нажатие на кнопку доносит идентификатор, который мы сами задали при отправке", () => {
    const n = normalizeGupshupEvent(
      v2("message", {
        id: "wamid.IN3",
        source: "996707111726",
        type: "button_reply",
        payload: { id: "slot_14_00", title: "14:00" },
      }),
    );

    const parsed = parseWaCloudWebhook(n.payload);
    expect(parsed.events[0].interactiveReplyId).toBe("slot_14_00");
    // Заголовок — то, что клиент видел на кнопке; он же становится текстом хода.
    expect(parsed.events[0].text).toBe("14:00");
  });
});

describe("V2 — статусы доставки и ловушка двух идентификаторов", () => {
  test("в delivered поле id — метовский wamid, а gsId приезжает отдельно", () => {
    const n = normalizeGupshupEvent(
      v2("message-event", {
        id: "wamid.OUT1",
        gsId: "gs-uuid-1",
        type: "delivered",
        destination: "996707111726",
        payload: { ts: 1_756_900_200 },
      }),
    );

    expect(n.gsIds.get("wamid.OUT1")).toBe("gs-uuid-1");
    const parsed = parseWaCloudWebhook(n.payload);
    expect(parsed.statuses[0]).toMatchObject({ wamid: "wamid.OUT1", status: "delivered" });
  });

  test("в синхронном failed поле id — это gsId, и метовского нет вовсе", () => {
    // ЭТО ГЛАВНАЯ ЛОВУШКА GUPSHUP. Одно и то же поле payload.id означает разное в разных
    // событиях. Приняв gsId за wamid, мы однажды сочли бы событие о доставке дублем входящего
    // сообщения — и молча его проглотили.
    const n = normalizeGupshupEvent(
      v2("message-event", {
        id: "gs-uuid-2",
        type: "failed",
        destination: "996707111726",
        payload: { code: 1002, reason: "Number does not exist on WhatsApp" },
      }),
    );

    // Метовского идентификатора нет — привязать статус не к чему, в пайплайн он не идёт.
    expect(n.payload).toBeNull();
    expect(n.externalId).toBe("gs-uuid-2");
    expect(n.kinds).toContain("status");
  });

  test("в асинхронном failed есть оба — статус доходит и несёт код ошибки", () => {
    const n = normalizeGupshupEvent(
      v2("message-event", {
        id: "wamid.OUT2",
        gsId: "gs-uuid-3",
        type: "failed",
        destination: "996707111726",
        payload: { code: 131026, reason: "Receiver incapable" },
      }),
    );

    const parsed = parseWaCloudWebhook(n.payload);
    expect(parsed.statuses[0].wamid).toBe("wamid.OUT2");
    expect(parsed.statuses[0].errorCode).toBe(131026);
    expect(n.gsIds.get("wamid.OUT2")).toBe("gs-uuid-3");
  });

  test("enqueued пропускается: у Meta соответствия нет, и выдумывать его нельзя", () => {
    // mapWaCloudDeliveryStatus намеренно игнорирует «sent», чтобы пришедший не по порядку статус
    // не затирал более поздний «delivered». Лишний статус сломал бы эту защиту.
    const n = normalizeGupshupEvent(
      v2("message-event", { id: "gs-uuid-4", type: "enqueued", destination: "996707111726" }),
    );

    expect(n.payload).toBeNull();
    expect(n.kinds).toContain("status");
  });

  test("события, пришедшие в перепутанном порядке, не откатывают delivered назад", () => {
    // Порядок нарочно обратный: сначала доставлено, потом отправлено.
    const delivered = normalizeGupshupEvent(
      v2("message-event", {
        id: "wamid.X",
        gsId: "gs-x",
        type: "delivered",
        destination: "996707111726",
      }),
    );
    const sent = normalizeGupshupEvent(
      v2("message-event", {
        id: "wamid.X",
        gsId: "gs-x",
        type: "sent",
        destination: "996707111726",
      }),
    );

    expect(
      mapWaCloudDeliveryStatus(parseWaCloudWebhook(delivered.payload).statuses[0].status),
    ).toEqual({
      status: "delivered",
      detail: null,
    });
    // «sent» не отображается ни во что — значит записи в базе он не тронет.
    expect(
      mapWaCloudDeliveryStatus(parseWaCloudWebhook(sent.payload).statuses[0].status),
    ).toBeNull();
  });
});

describe("Неизвестное и служебное", () => {
  test("биллинг распознаётся отдельно и в агента не идёт", () => {
    const n = normalizeGupshupEvent(v2("billing-event", { deductions: { billable: true } }));

    expect(n.kinds).toEqual(["billing"]);
    expect(n.payload).toBeNull();
  });

  test("незнакомый тип не роняет разбор — он получает пометку unknown", () => {
    // Отказ здесь означал бы не-200 в ответ Gupshup'у и вечную пересылку одной пачки.
    const n = normalizeGupshupEvent(v2("какое-то-новое-событие", { foo: 1 }));

    expect(n.kinds).toEqual(["unknown"]);
    expect(n.eventType).toBe("какое-то-новое-событие");
    expect(n.payload).toBeNull();
  });

  test("мусор вместо события тоже не роняет разбор", () => {
    expect(normalizeGupshupEvent(null).kinds).toEqual(["unknown"]);
    expect(normalizeGupshupEvent("строка").kinds).toEqual(["unknown"]);
  });
});

describe("Безопасное хранение", () => {
  test("ключи вырезаются до записи в базу", () => {
    const out: any = redactForStorage({
      apikey: "sk_live_should_never_land_in_db",
      nested: { authorization: "Bearer xyz", token: "t" },
      text: "обычное сообщение",
    });

    expect(out.apikey).toBe("[redacted]");
    expect(out.nested.authorization).toBe("[redacted]");
    expect(out.nested.token).toBe("[redacted]");
    // Текст сообщения остаётся: без него карантин не отвечает на вопрос, ради которого заведён.
    expect(out.text).toBe("обычное сообщение");
  });

  test("подпись у ссылки на вложение срезается — это пропуск к чужой фотографии", () => {
    const out: any = redactForStorage({ url: "https://media.gupshup.io/a.jpg?sig=SECRET&exp=1" });

    expect(out.url).toBe("https://media.gupshup.io/a.jpg?[redacted]");
  });

  test("заготовка для репозитория обезличивается сильнее, чем строка в базе", () => {
    const out: any = anonymizeForFixture({
      payload: { source: "996707111726", sender: { phone: "996707111726", name: "Айгуль" } },
      text: "мой номер 996707111726",
      url: "https://media.gupshup.io/real.jpg",
    });

    // Файл уедет в git и будет виден всем, кто склонирует репозиторий.
    expect(out.payload.source).toBe("996700000000");
    expect(out.payload.sender.name).toBe("Тест");
    expect(out.text).toBe("тестовое сообщение");
    expect(out.url).toBe("https://example.invalid/media");
  });
});
