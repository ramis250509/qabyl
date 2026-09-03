// Настройка подписок Gupshup — то, что раньше делалось руками в чужом кабинете.
//
// Здесь закреплены три вещи, каждая из которых ломается тихо и дорого:
//   • повторный запуск не должен плодить подписки — у Gupshup потолок в пять на приложение, и
//     забитый нашими же попытками список означает, что настоящую добавить уже некуда;
//   • чужие подписки не должны исчезать — приложение может обслуживать не только нас;
//   • отказ должен быть виден. Молча «настроенный» канал, который не получает событий, выглядит
//     как «салон подключён, ассистент не отвечает» — самый дорогой из наших режимов отказа.
//
// Run: bun test wa-gupshup-admin.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import {
  gupshupListSubscriptions,
  gupshupRemoveOurSubscriptions,
  gupshupSyncSubscriptions,
  QABYL_V2_TAG,
  QABYL_V3_TAG,
} from "./src/lib/wa-gupshup-admin.server";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = "sk_test";
const APP = "app-1";
const HOOK = "https://qabyl.com/api/public/wagupshup/abc123";

type Call = { method: string; url: string; form: Record<string, string> };

/**
 * Подменяет Gupshup: отдаёт заданный список подписок и записывает всё, что мы к нему применили.
 * Созданные подписки складываются в тот же список — так проверяется идемпотентность.
 */
function fakeGupshup(initial: any[]) {
  const calls: Call[] = [];
  let store = [...initial];

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const form: Record<string, string> = {};
    if (typeof init?.body === "string") {
      for (const [k, v] of new URLSearchParams(init.body)) form[k] = v;
    }
    calls.push({ method, url: u, form });

    const json = (body: any) =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as any;

    if (method === "GET") return json({ status: "success", subscriptions: store });
    if (method === "DELETE") {
      const id = decodeURIComponent(u.split("/").pop() ?? "");
      store = store.filter((s) => String(s.id) !== id);
      return json({ status: "success" });
    }
    store.push({
      id: `new-${store.length + 1}`,
      tag: form.tag,
      url: form.url,
      version: Number(form.version),
      modes: form.modes,
      active: true,
    });
    return json({ status: "success" });
  }) as any;

  return { calls, store: () => store };
}

describe("gupshupSyncSubscriptions — первичная настройка", () => {
  test("на пустом приложении заводит обе подписки: приём и тарификацию", async () => {
    const gs = fakeGupshup([]);

    const res = await gupshupSyncSubscriptions(KEY, APP, HOOK);

    expect(res.ok).toBe(true);
    const created = gs.calls.filter((c) => c.method === "POST");
    expect(created).toHaveLength(2);

    const v3 = created.find((c) => c.form.tag === QABYL_V3_TAG)!;
    const v2 = created.find((c) => c.form.tag === QABYL_V2_TAG)!;

    // Версия 3 — формат Meta, на нём держится весь пайплайн.
    expect(v3.form.version).toBe("3");
    expect(v3.form.url).toBe(HOOK);
    expect(v3.form.modes).toContain("MESSAGE");
    expect(v3.form.modes).toContain("DELIVERED");

    // Версия 2 нужна ровно ради денег: только в её событии sent приезжают pricing и conversation.
    expect(v2.form.version).toBe("2");
    expect(v2.form.modes).toBe("BILLING");
  });

  test("бьёт по актуальному эндпоинту подписок, а не по устаревшему Callback URL API", async () => {
    const gs = fakeGupshup([]);

    await gupshupSyncSubscriptions(KEY, APP, HOOK);

    for (const c of gs.calls) {
      expect(c.url).toContain("/wa/app/app-1/subscription");
      // Устаревшие эндпоинты выведены из эксплуатации: попадание на них означало бы канал,
      // который однажды просто перестанет работать.
      expect(c.url).not.toContain("/sm/");
    }
  });
});

describe("gupshupSyncSubscriptions — повторный запуск", () => {
  test("ничего не создаёт, если подписки уже верные", async () => {
    const gs = fakeGupshup([
      { id: "1", tag: QABYL_V3_TAG, url: HOOK, version: 3, modes: "MESSAGE", active: true },
      { id: "2", tag: QABYL_V2_TAG, url: HOOK, version: 2, modes: "BILLING", active: true },
    ]);

    const res = await gupshupSyncSubscriptions(KEY, APP, HOOK);

    expect(res.ok).toBe(true);
    expect(gs.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(gs.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    // Владельцу должно быть видно, что работы не потребовалось, а не «успешно настроено» на ровном месте.
    expect(res.steps.filter((s) => s.existed)).toHaveLength(2);
  });

  test("пересоздаёт подписку, если адрес вебхука разъехался", async () => {
    const gs = fakeGupshup([
      {
        id: "1",
        tag: QABYL_V3_TAG,
        url: "https://old.example/hook",
        version: 3,
        modes: "MESSAGE",
        active: true,
      },
    ]);

    const res = await gupshupSyncSubscriptions(KEY, APP, HOOK);

    expect(res.ok).toBe(true);
    // Сначала снести старую, потом завести новую — иначе в списке останутся обе.
    expect(gs.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/1"))).toBe(true);
    expect(gs.store().filter((s) => s.tag === QABYL_V3_TAG)).toHaveLength(1);
    expect(gs.store().find((s) => s.tag === QABYL_V3_TAG)!.url).toBe(HOOK);
  });

  test("схлопывает дубли, оставшиеся от оборванного запуска", async () => {
    // Так выглядит список, если прошлый запуск умер между созданием и проверкой.
    const gs = fakeGupshup([
      { id: "1", tag: QABYL_V3_TAG, url: HOOK, version: 3, modes: "MESSAGE", active: true },
      { id: "2", tag: QABYL_V3_TAG, url: HOOK, version: 3, modes: "MESSAGE", active: true },
    ]);

    await gupshupSyncSubscriptions(KEY, APP, HOOK);

    // Потолок в пять подписок на приложение — дубли его съедают.
    expect(gs.store().filter((s) => s.tag === QABYL_V3_TAG)).toHaveLength(1);
  });

  test("чужие подписки не трогает", async () => {
    const gs = fakeGupshup([
      {
        id: "99",
        tag: "чей-то-другой-сервис",
        url: "https://other.example/hook",
        version: 3,
        modes: "MESSAGE",
        active: true,
      },
    ]);

    await gupshupSyncSubscriptions(KEY, APP, HOOK);

    // Приложение может обслуживать не только нас. Снести чужой адрес — сломать то, о чём мы
    // ничего не знаем.
    expect(gs.store().some((s) => s.id === "99")).toBe(true);
    expect(gs.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("gupshupSyncSubscriptions — отказы видны", () => {
  test("недоступный Gupshup не выдаёт себя за успех", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ status: "error", message: "Authentication Failed" }),
    })) as any;

    const res = await gupshupSyncSubscriptions(KEY, APP, HOOK);

    expect(res.ok).toBe(false);
    expect(res.steps[0].detail).toContain("Authentication Failed");
  });

  test("HTTP 200 со статусом error считается отказом", async () => {
    // Та же ловушка, что и на отправке: у Gupshup неуспех приезжает и с кодом 200.
    let n = 0;
    globalThis.fetch = (async (_u: any, init: any) => {
      n++;
      const isGet = (init?.method ?? "GET") === "GET";
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            isGet
              ? { status: "success", subscriptions: [] }
              : { status: "error", message: "subscription limit reached" },
          ),
      } as any;
    }) as any;

    const res = await gupshupSyncSubscriptions(KEY, APP, HOOK);

    expect(res.ok).toBe(false);
    expect(res.steps.some((s) => !s.ok && (s.detail ?? "").includes("limit"))).toBe(true);
    expect(n).toBeGreaterThan(1);
  });

  test("пустые реквизиты — отказ с человеческой причиной, наружу ничего не уходит", async () => {
    const gs = fakeGupshup([]);

    const res = await gupshupSyncSubscriptions("", APP, HOOK);

    expect(res.ok).toBe(false);
    expect(res.steps[0].detail).toContain("API-ключ");
    expect(gs.calls).toHaveLength(0);
  });
});

describe("gupshupRemoveOurSubscriptions — отключение салона", () => {
  test("снимает только наши подписки", async () => {
    const gs = fakeGupshup([
      { id: "1", tag: QABYL_V3_TAG, url: HOOK, version: 3, modes: "MESSAGE", active: true },
      { id: "2", tag: QABYL_V2_TAG, url: HOOK, version: 2, modes: "BILLING", active: true },
      { id: "99", tag: "чужая", url: "https://other.example", version: 3, modes: "", active: true },
    ]);

    const res = await gupshupRemoveOurSubscriptions(KEY, APP);

    expect(res).toMatchObject({ ok: true, removed: 2 });
    expect(gs.store()).toHaveLength(1);
    expect(gs.store()[0].id).toBe("99");
  });

  test("на приложении без наших подписок отрабатывает вхолостую, а не падает", async () => {
    fakeGupshup([]);

    expect(await gupshupRemoveOurSubscriptions(KEY, APP)).toMatchObject({ ok: true, removed: 0 });
  });
});

describe("gupshupListSubscriptions", () => {
  test("приводит разные написания идентификатора к одному полю", async () => {
    // У Gupshup идентификатор в ответе встречается и как id, и как subscriptionId.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: "success",
          subscriptions: [{ subscriptionId: "sub-7", tag: "t", url: "u", version: 3 }],
        }),
    })) as any;

    const res = await gupshupListSubscriptions(KEY, APP);

    expect(res.ok).toBe(true);
    expect(res.ok && res.subscriptions[0].id).toBe("sub-7");
    // active отсутствует в ответе — считаем включённой, иначе рабочая подписка выглядела бы битой.
    expect(res.ok && res.subscriptions[0].active).toBe(true);
  });
});
