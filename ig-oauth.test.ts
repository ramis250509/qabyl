// Подключение Instagram кнопкой: подпись state, обмен токенов, разрезка общего вебхука, продление.
// Сеть и база подменены — ни одного запроса к Meta.
import { describe, expect, test } from "bun:test";
import {
  buildIgAuthorizeUrl,
  cleanIgCode,
  completeIgLogin,
  IG_LOGIN_SCOPES,
  runIgTokenRefresh,
  signIgState,
  splitIgPayloadByAccount,
  verifyIgState,
  verifyPlatformIgSignature,
} from "./src/lib/ig-oauth.server";

type Handler = (url: string, init?: any) => { status?: number; body: any };

function fakeFetch(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const f = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body });
    for (const [re, h] of routes) {
      if (re.test(url)) {
        const r = h(url, init);
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response("{}", { status: 404 });
  }) as any;
  return { f, calls };
}

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const SALON = "4a891fe4-894f-442c-af71-df0f8a082b24";
const USER = "11111111-1111-1111-1111-111111111111";

describe("state", () => {
  test("round-trips salon and user", async () => {
    const s = await signIgState({ salonId: SALON, userId: USER }, "secret", NOW);
    expect(await verifyIgState(s, "secret", NOW + 60_000)).toEqual({
      salonId: SALON,
      userId: USER,
    });
  });

  test("a different secret, a tampered body or an expired state is refused", async () => {
    const s = await signIgState({ salonId: SALON, userId: USER }, "secret", NOW);
    expect(await verifyIgState(s, "other", NOW)).toBeNull();
    const [body, sig] = s.split(".");
    const forged = btoa(JSON.stringify({ s: "evil", u: USER, e: NOW + 1e9, n: "x" }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifyIgState(`${forged}.${sig}`, "secret", NOW)).toBeNull();
    expect(await verifyIgState(`${body}.`, "secret", NOW)).toBeNull();
    expect(await verifyIgState(s, "secret", NOW + 16 * 60_000)).toBeNull();
  });

  test("signing without a secret throws instead of issuing an unsigned state", async () => {
    await expect(signIgState({ salonId: SALON, userId: USER }, "", NOW)).rejects.toThrow();
  });
});

test("authorize URL asks for all three permissions and forces a fresh login", () => {
  const u = new URL(
    buildIgAuthorizeUrl({ appId: "123", redirectUri: "https://qabyl.com/cb", state: "st" }),
  );
  expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
  expect(u.searchParams.get("scope")).toBe(IG_LOGIN_SCOPES.join(","));
  expect(u.searchParams.get("redirect_uri")).toBe("https://qabyl.com/cb");
  expect(u.searchParams.get("force_reauth")).toBe("true");
  expect(u.searchParams.get("response_type")).toBe("code");
});

test("the #_ suffix Instagram appends is not part of the code", () => {
  expect(cleanIgCode("abc123#_")).toBe("abc123");
  expect(cleanIgCode("abc123")).toBe("abc123");
});

describe("completeIgLogin", () => {
  const happy = (overrides: Partial<Record<string, Handler>> = {}) =>
    fakeFetch([
      [
        /api\.instagram\.com\/oauth\/access_token/,
        overrides.short ??
          (() => ({
            body: { access_token: "SHORT", user_id: 987, permissions: [...IG_LOGIN_SCOPES] },
          })),
      ],
      [
        /graph\.instagram\.com\/access_token/,
        overrides.long ?? (() => ({ body: { access_token: "LONG", expires_in: 5184000 } })),
      ],
      [
        /\/me\?fields=/,
        overrides.me ??
          (() => ({ body: { user_id: "17841400000000001", id: "285000", username: "salon" } })),
      ],
      [/subscribed_apps/, overrides.sub ?? (() => ({ body: { success: true } }))],
    ]);

  test("stores the professional account id (user_id), not the app-scoped id", async () => {
    const { f, calls } = happy();
    const c = await completeIgLogin({
      code: "CODE#_",
      appId: "123",
      appSecret: "sec",
      redirectUri: "https://qabyl.com/cb",
      fetchImpl: f,
      now: NOW,
    });
    expect(c.igUserId).toBe("17841400000000001");
    expect(c.token).toBe("LONG");
    expect(c.missingScopes).toEqual([]);
    expect(c.subscribeError).toBeNull();
    expect(c.expiresAt).toBe(new Date(NOW + 5184000 * 1000).toISOString());
    const exchange = calls.find((x) => x.url.includes("oauth/access_token"))!;
    expect(new URLSearchParams(exchange.body).get("code")).toBe("CODE");
    const sub = calls.find((x) => x.url.includes("subscribed_apps"))!;
    expect(sub.method).toBe("POST");
    expect(new URL(sub.url).searchParams.get("subscribed_fields")).toBe("messages,comments");
  });

  test("the documented data[] response shape works too, and unticked scopes are reported", async () => {
    const { f } = happy({
      short: () => ({
        body: {
          data: [
            { access_token: "SHORT", user_id: "987", permissions: "instagram_business_basic" },
          ],
        },
      }),
    });
    const c = await completeIgLogin({ code: "C", appSecret: "sec", fetchImpl: f, now: NOW });
    expect(c.missingScopes).toContain("instagram_business_manage_messages");
    expect(c.missingScopes).toContain("instagram_business_manage_comments");
  });

  test("a failed webhook subscription does not lose the connection", async () => {
    const { f } = happy({ sub: () => ({ status: 400, body: { error: { message: "nope" } } }) });
    const c = await completeIgLogin({ code: "C", appSecret: "sec", fetchImpl: f, now: NOW });
    expect(c.token).toBe("LONG");
    expect(c.subscribeError).toContain("nope");
  });

  test("a rejected code throws with Meta's wording", async () => {
    const { f } = happy({
      short: () => ({ status: 400, body: { error_message: "Invalid authorization code" } }),
    });
    await expect(
      completeIgLogin({ code: "C", appSecret: "sec", fetchImpl: f, now: NOW }),
    ).rejects.toThrow("Invalid authorization code");
  });

  test("no app secret — refuse before calling Meta", async () => {
    const { f, calls } = happy();
    await expect(completeIgLogin({ code: "C", appSecret: "", fetchImpl: f })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

describe("platform webhook", () => {
  test("one delivery carrying two accounts is split per account", () => {
    const parts = splitIgPayloadByAccount({
      object: "instagram",
      entry: [
        { id: "A", time: 1, messaging: [{ n: 1 }] },
        { id: "B", time: 2, messaging: [{ n: 2 }] },
        { id: "A", time: 3, messaging: [{ n: 3 }] },
        { time: 4 },
      ],
    });
    expect(parts.map((p) => p.accountId)).toEqual(["A", "B"]);
    const a = JSON.parse(parts[0].rawBody);
    expect(a.object).toBe("instagram");
    expect(a.entry.map((e: any) => e.time)).toEqual([1, 3]);
  });

  test("signature is accepted with either of our secrets and nothing else", async () => {
    const body = '{"object":"instagram"}';
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("meta-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const header =
      "sha256=" + Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyPlatformIgSignature(body, header, ["ig-secret", "meta-secret"])).toBe(true);
    expect(await verifyPlatformIgSignature(body, header, ["ig-secret"])).toBe(false);
    expect(await verifyPlatformIgSignature(body, header, ["", ""])).toBe(false);
    expect(await verifyPlatformIgSignature(body, null, ["meta-secret"])).toBe(false);
  });
});

test("token refresh rewrites token and expiry for each due salon", async () => {
  const updates: any[] = [];
  const filters: string[] = [];
  const q: any = {
    select: () => q,
    eq: (c: string, v: string) => (filters.push(`${c}=${v}`), q),
    not: () => q,
    lt: () =>
      Promise.resolve({
        data: [
          { salon_id: "s1", instagram_token: "OLD1" },
          { salon_id: "s2", instagram_token: "OLD2" },
        ],
        error: null,
      }),
    update: (v: any) => ({
      eq: (_c: string, id: string) => (
        updates.push({ id, ...v }),
        Promise.resolve({ error: null })
      ),
    }),
  };
  const { f } = fakeFetch([
    [
      /refresh_access_token/,
      (url) => ({
        body: {
          access_token: `NEW-${new URL(url).searchParams.get("access_token")}`,
          expires_in: 100,
        },
      }),
    ],
  ]);
  const report = await runIgTokenRefresh({ db: { from: () => q }, fetchImpl: f, now: NOW });
  expect(filters).toContain("instagram_connected_via=platform");
  expect(report).toEqual({ checked: 2, refreshed: 2, failed: [] });
  expect(updates).toEqual([
    {
      id: "s1",
      instagram_token: "NEW-OLD1",
      instagram_token_expires_at: new Date(NOW + 100_000).toISOString(),
    },
    {
      id: "s2",
      instagram_token: "NEW-OLD2",
      instagram_token_expires_at: new Date(NOW + 100_000).toISOString(),
    },
  ]);
});
