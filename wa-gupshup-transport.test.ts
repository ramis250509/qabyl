// Транспорт Gupshup — то, чем салон будет отвечать клиенту.
//
// Здесь закреплено ровно то, что ломается тихо. Транспорт стоит между агентом и клиентом: если он
// проглотит отказ и отчитается успехом, салон будет выглядеть подключённым, а клиент не получит
// ответа. Это ровно тот сценарий, которым уже была потеряна неделя на Green-API, и повторять его
// на третьем транспорте подряд не хочется.
//
// Run: bun test wa-gupshup-transport.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { gupshupTransport } from "./src/lib/wa-transport.server";
import {
  gupshupSendImage,
  gupshupSendTemplate,
  gupshupSendText,
  gupshupTestConnection,
} from "./src/lib/wa-gupshup.server";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CREDS = { apiKey: "sk_test", sourceNumber: "77022968987", appName: "QabylWA" };

type Captured = { url: string; headers: Record<string, string>; form: Record<string, string> };

/** Подменяет fetch и разбирает форму, которую транспорт отправил наружу. */
function captureFetch(response: { ok?: boolean; status?: number; text?: string } = {}): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const form: Record<string, string> = {};
    if (typeof init?.body === "string") {
      for (const [k, v] of new URLSearchParams(init.body)) form[k] = v;
    }
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as any, form });
    const ok = response.ok ?? true;
    return {
      ok,
      status: response.status ?? (ok ? 200 : 500),
      headers: new Headers(),
      text: async () => response.text ?? JSON.stringify({ status: "submitted", messageId: "gs-1" }),
    } as any;
  }) as any;
  return calls;
}

describe("gupshupSendText", () => {
  test("шлёт форму на актуальный эндпоинт с ключом в заголовке apikey", async () => {
    const calls = captureFetch();

    const res = await gupshupSendText(CREDS, "996707111726", "Привет!");

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // Именно /wa/api/v1/msg. Устаревшие /sm-эндпоинты выведены из эксплуатации, и попадание на
    // них означало бы канал, который однажды просто перестанет работать.
    expect(calls[0].url).toBe("https://api.gupshup.io/wa/api/v1/msg");
    expect(calls[0].headers.apikey).toBe("sk_test");
    expect(calls[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  test("сообщение уходит строкой JSON внутри поля message, а не объектом", async () => {
    const calls = captureFetch();

    await gupshupSendText(CREDS, "996707111726", "Привет!");

    // Обычный объект здесь дал бы 400: Gupshup ждёт именно строку.
    expect(JSON.parse(calls[0].form.message)).toEqual({ type: "text", text: "Привет!" });
    expect(calls[0].form["src.name"]).toBe("QabylWA");
    expect(calls[0].form.source).toBe("77022968987");
    expect(calls[0].form.destination).toBe("996707111726");
  });

  test("номер получателя нормализуется: плюсы, пробелы и суффикс Green-API отбрасываются", async () => {
    const calls = captureFetch();

    await gupshupSendText(CREDS, "+996 707 111 726@c.us", "Привет");

    expect(calls[0].form.destination).toBe("996707111726");
  });

  test("длинный ответ режется по словам — по одной отправке на кусок, по порядку", async () => {
    const calls = captureFetch();

    await gupshupSendText(CREDS, "996707111726", "слово ".repeat(2000));

    expect(calls.length).toBeGreaterThan(1);
    // Ни один кусок не должен превысить лимит WhatsApp — иначе клиент не получит НИЧЕГО.
    for (const c of calls) {
      expect(JSON.parse(c.form.message).text.length).toBeLessThanOrEqual(3900);
    }
  });

  test("HTTP 200 со статусом, отличным от submitted, считается ОТКАЗОМ", async () => {
    // Это главная ловушка Gupshup и повод, по которому ответ разбирается дважды. Приняв такой
    // ответ за успех, мы записали бы себе messageId, которого не существует, и потом искали по
    // нему статус доставки, который никогда не придёт.
    captureFetch({
      ok: true,
      text: JSON.stringify({ status: "error", message: "invalid source" }),
    });

    const res = await gupshupSendText(CREDS, "996707111726", "Привет");

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("invalid source");
  });

  test("отправка обрывается на первой неудаче, а не досылает хвост", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return {
        ok: n === 1,
        status: n === 1 ? 200 : 400,
        headers: new Headers(),
        text: async () =>
          n === 1 ? JSON.stringify({ status: "submitted", messageId: "gs-1" }) : "rate limited",
      } as any;
    }) as any;

    const res = await gupshupSendText(CREDS, "996707111726", "слово ".repeat(2000));

    expect(res.ok).toBe(false);
    // Хвост ответа без начала читается клиентом хуже, чем отсутствие ответа.
    expect(n).toBe(2);
  });

  test("пустые реквизиты — это отказ с человеческой причиной, а не исключение", async () => {
    const calls = captureFetch();

    const res = await gupshupSendText({ ...CREDS, apiKey: "" }, "996707111726", "Привет");

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("API-ключ");
    // И, что важнее, наружу ничего не ушло.
    expect(calls).toHaveLength(0);
  });
});

describe("gupshupSendImage и gupshupSendTemplate", () => {
  test("картинка уходит ссылкой с подписью в одном пузыре", async () => {
    const calls = captureFetch();

    await gupshupSendImage(
      CREDS,
      "996707111726",
      "https://cdn.qabyl.com/qr.png",
      "Оплатите 500 сом",
    );

    const msg = JSON.parse(calls[0].form.message);
    expect(msg.type).toBe("image");
    expect(msg.originalUrl).toBe("https://cdn.qabyl.com/qr.png");
    expect(msg.caption).toBe("Оплатите 500 сом");
  });

  test("шаблон идёт на свой эндпоинт, параметры сохраняют порядок", async () => {
    const calls = captureFetch();

    await gupshupSendTemplate(CREDS, "996707111726", "tpl-42", ["Айгуль", "12 сентября", "14:00"]);

    expect(calls[0].url).toBe("https://api.gupshup.io/wa/api/v1/template/msg");
    // Порядок — это контракт с одобренным шаблоном: {{1}}, {{2}}, {{3}}. Перестановка означает,
    // что клиент увидит время на месте имени.
    expect(JSON.parse(calls[0].form.template)).toEqual({
      id: "tpl-42",
      params: ["Айгуль", "12 сентября", "14:00"],
    });
  });
});

describe("gupshupTestConnection", () => {
  test("неверный ключ объясняется словами, а не кодом ответа", async () => {
    captureFetch({ ok: false, status: 401, text: "unauthorized" });

    const res = await gupshupTestConnection(CREDS, "app-1");

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("ключ");
  });

  test("успех сообщает число шаблонов: ноль — не ошибка связи, но и не готовность", async () => {
    captureFetch({ text: JSON.stringify({ templates: [{ id: "a" }, { id: "b" }] }) });

    const res = await gupshupTestConnection(CREDS, "app-1");

    expect(res).toEqual({ ok: true, templateCount: 2 });
  });
});

describe("gupshupTransport — реализация общего интерфейса", () => {
  test("без реквизитов транспорт не готов и сам называет, чего не хватает", () => {
    const tx = gupshupTransport({ apiKey: "", sourceNumber: "", appName: "QabylWA" });

    expect(tx.ready).toBe(false);
    // Строка уходит владельцу в журнал ошибок — она обязана быть понятной без чтения кода.
    expect(tx.missing).toContain("API-ключ");
    expect(tx.missing).toContain("номер отправителя");
  });

  test("«печатает…» не бросает и ничего не отправляет", async () => {
    const calls = captureFetch();
    const tx = gupshupTransport(CREDS);

    // У Access API индикатора набора нет. Молча ничего не делаем — это осознанная плата за схему,
    // а не забытая реализация.
    await tx.markReadAndTyping("wamid.X");

    expect(calls).toHaveLength(0);
  });

  test("вложение берётся по ссылке из события, а не через Graph API", async () => {
    const media = new Map([["image-1", "https://media.gupshup.io/x.jpg"]]);
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as any;

    const tx = gupshupTransport({ ...CREDS, media });
    const got = await tx.fetchMedia("image-1", 1024);

    expect(got?.mime).toBe("image/jpeg");
    expect(got?.bytes.byteLength).toBe(3);
  });

  test("незнакомое вложение — null, а не бросок", async () => {
    const tx = gupshupTransport({ ...CREDS, media: new Map() });

    expect(await tx.fetchMedia("нет-такого", 1024)).toBeNull();
  });

  test("файл больше лимита не попадает в память воркера", async () => {
    const media = new Map([["image-1", "https://media.gupshup.io/big.jpg"]]);
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg", "content-length": "99999999" }),
      arrayBuffer: async () => new Uint8Array(99999999).buffer,
    })) as any;

    const tx = gupshupTransport({ ...CREDS, media });

    // Решение «не тянуть 100 мегабайт» принимается по заголовку, ДО чтения тела.
    expect(await tx.fetchMedia("image-1", 1024)).toBeNull();
  });
});
