// Мост Make — временный транспорт WhatsApp на время ожидания Advanced Access.
//
// Здесь закреплено ровно то, что ломается тихо. Мост живёт между агентом и клиентом: если он
// молча проглотит ошибку, салон будет выглядеть подключённым, а клиент не получит ответа — тот
// самый сценарий, которым мы уже потеряли неделю на Green-API. Поэтому каждый тест называет
// сообщение, которое обязано дойти, или отказ, который обязан быть виден.
//
// Run: bun test wa-make-transport.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { makeTransport, cloudTransport } from "./src/lib/wa-transport.server";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Captured = { url: string; headers: Record<string, string>; body: any };

/** Подменяет fetch и складывает всё, что мост отправил наружу. */
function captureFetch(response: { ok: boolean; status?: number; text?: string } = { ok: true }) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      text: async () => response.text ?? "",
    } as any;
  }) as any;
  return calls;
}

const CFG = { outboundUrl: "https://hook.eu2.make.com/abc", token: "s3cret" };

describe("makeTransport — отправка", () => {
  test("шлёт текст в вебхук Make с общим секретом в заголовке", async () => {
    const calls = captureFetch();
    const tx = makeTransport(CFG);

    const res = await tx.sendText("996700000001", "Привет!");

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hook.eu2.make.com/abc");
    // Без заголовка сценарий Make примет запрос от кого угодно: его адрес не секрет.
    expect(calls[0].headers["X-Qabyl-Token"]).toBe("s3cret");
    expect(calls[0].body).toMatchObject({ type: "text", to: "996700000001", text: "Привет!" });
  });

  test("длинный ответ режется на части — по одной отправке на кусок", async () => {
    const calls = captureFetch();
    const tx = makeTransport(CFG);

    // Заметно длиннее лимита WhatsApp в 3900 символов.
    await tx.sendText("996700000001", "а ".repeat(4000));

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(String(c.body.text).length).toBeLessThanOrEqual(3900);
  });

  test("отказ Make возвращается вызывающему, а не глотается", async () => {
    captureFetch({ ok: false, status: 400, text: "scenario is inactive" });
    const tx = makeTransport(CFG);

    const res = await tx.sendText("996700000001", "Привет!");

    expect(res.ok).toBe(false);
    // В журнале ошибок салона должно быть видно, что именно ответил Make.
    if (!res.ok) expect(res.error).toContain("scenario is inactive");
  });

  test("недоступный Make — это ошибка, а не исключение наружу", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;
    const tx = makeTransport(CFG);

    const res = await tx.sendText("996700000001", "Привет!");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("network down");
  });

  test("картинка уходит отдельным типом вместе с подписью", async () => {
    const calls = captureFetch();
    const tx = makeTransport(CFG);

    await tx.sendImage("996700000001", "https://cdn/qr.png", "Оплатите 500 сом");

    expect(calls[0].body).toMatchObject({
      type: "image",
      url: "https://cdn/qr.png",
      caption: "Оплатите 500 сом",
    });
  });

  test("пустой получатель не приводит к запросу", async () => {
    const calls = captureFetch();
    const tx = makeTransport(CFG);

    const res = await tx.sendText("", "Привет!");

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("makeTransport — готовность", () => {
  test("без адреса вебхука мост не готов и говорит, чего не хватает", () => {
    const tx = makeTransport({ outboundUrl: "", token: "s3cret" });
    expect(tx.ready).toBe(false);
    expect(tx.missing).toContain("вебхука");
  });

  test("с обоими реквизитами мост готов", () => {
    expect(makeTransport(CFG).ready).toBe(true);
  });
});

describe("makeTransport — медиа", () => {
  test("файл берётся из того, что Make приложил к запросу", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const tx = makeTransport({
      ...CFG,
      media: new Map([["img-1", { bytes, mime: "image/jpeg" }]]),
    });

    const got = await tx.fetchMedia("img-1", 1024);

    expect(got?.mime).toBe("image/jpeg");
    expect(got?.bytes).toEqual(bytes);
  });

  test("незнакомый идентификатор — null, а не падение", async () => {
    const tx = makeTransport(CFG);
    expect(await tx.fetchMedia("img-404", 1024)).toBeNull();
  });

  test("файл больше лимита отбрасывается", async () => {
    const tx = makeTransport({
      ...CFG,
      media: new Map([["big", { bytes: new Uint8Array(2048), mime: "image/jpeg" }]]),
    });
    expect(await tx.fetchMedia("big", 1024)).toBeNull();
  });
});

describe("cloudTransport", () => {
  test("без токена не готов — салон считается неподключённым, а не сломанным", () => {
    const tx = cloudTransport({ phoneNumberId: "123", token: "" });
    expect(tx.ready).toBe(false);
    expect(tx.missing).toContain("токен");
  });

  test("с полными реквизитами готов и опознаётся как облачный", () => {
    const tx = cloudTransport({ phoneNumberId: "123", token: "EAAB" });
    expect(tx.ready).toBe(true);
    expect(tx.kind).toBe("cloud");
  });
});
