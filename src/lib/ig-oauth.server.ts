// Подключение Instagram кнопкой: «Business Login for Instagram» через общее приложение Qabyl.
//
// ЗАЧЕМ. Раньше салон сам создавал приложение в кабинете Meta и вставлял токен руками — шаг, на
// котором отваливается почти каждый владелец. Здесь салон жмёт «Подключить Instagram», входит в
// свой аккаунт на instagram.com и возвращается уже подключённым.
//
// КАК ИДЁТ ПОТОК.
//   1. startInstagramLogin (server fn, под авторизацией) проверяет доступ к салону и отдаёт адрес
//      instagram.com/oauth/authorize с подписанным `state`.
//   2. Instagram возвращает браузер на /api/public/ig-oauth/callback?code=…&state=….
//      Сессии Supabase на этом запросе нет (она живёт в localStorage, не в cookie), поэтому
//      единственное доказательство «это владелец салона X» — наша HMAC-подпись в `state`,
//      выданная на шаге 1 после проверки has_salon_access.
//   3. Код → короткий токен → долгий (60 дней) → /me (ID аккаунта) → подписка на вебхуки.
//
// ВЕБХУКИ таких салонов приходят не в пер-салонный адрес, а в общий /api/public/ig: адрес вебхука
// у приложения один. Салон там опознаётся по entry[].id — это `user_id` из /me, его и сохраняем.
//
// Токен живёт 60 дней. Продлевает его cron-задача ig-token-refresh (runIgTokenRefresh ниже).

const IG_API_VERSION = "v23.0";
const IG_GRAPH = "https://graph.instagram.com";

/** Instagram App ID приложения Qabyl AI Admin (виден в кабинете, не секрет). */
export const IG_APP_ID_DEFAULT = "1723210638757354";

export const IG_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

/** Поля вебхука, на которые подписываем аккаунт салона. comments — для кодовых слов. */
export const IG_WEBHOOK_FIELDS = ["messages", "comments"] as const;

/** Сколько живёт ссылка «Подключить» от нажатия до возврата. */
const STATE_TTL_MS = 15 * 60 * 1000;

/** Продлеваем токен, когда до конца осталось меньше этого. */
export const REFRESH_WHEN_LEFT_MS = 10 * 24 * 60 * 60 * 1000;

type FetchLike = typeof fetch;

export function igAppId(): string {
  return process.env.IG_APP_ID?.trim() || IG_APP_ID_DEFAULT;
}

export function igAppSecret(): string {
  return process.env.IG_APP_SECRET?.trim() ?? "";
}

export function publicBaseUrl(): string {
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || "https://qabyl.com";
}

export function igRedirectUri(base = publicBaseUrl()): string {
  return `${base}/api/public/ig-oauth/callback`;
}

// ─────────────────── state: подпись вместо сессии ────────────────────────────

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type IgStatePayload = { salonId: string; userId: string };

export async function signIgState(
  p: IgStatePayload,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (!secret) throw new Error("IG_APP_SECRET не задан");
  const nonce = new Uint8Array(8);
  crypto.getRandomValues(nonce);
  const body = b64url(
    new TextEncoder().encode(
      JSON.stringify({ s: p.salonId, u: p.userId, e: now + STATE_TTL_MS, n: b64url(nonce) }),
    ),
  );
  return `${body}.${await hmacHex(secret, body)}`;
}

/** null — подпись не сошлась, state испорчен или просрочен. Причину наружу не отдаём. */
export async function verifyIgState(
  state: string,
  secret: string,
  now = Date.now(),
): Promise<IgStatePayload | null> {
  if (!secret || !state) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!constantTimeEquals(await hmacHex(secret, body), sig)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof parsed?.s !== "string" || typeof parsed?.u !== "string") return null;
    if (typeof parsed?.e !== "number" || parsed.e < now) return null;
    return { salonId: parsed.s, userId: parsed.u };
  } catch {
    return null;
  }
}

export function buildIgAuthorizeUrl(opts: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", opts.appId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_LOGIN_SCOPES.join(","));
  u.searchParams.set("state", opts.state);
  // Без этого Instagram молча входит под аккаунтом, уже открытым в браузере, — у владельца
  // с личным и салонным аккаунтом подключился бы не тот.
  u.searchParams.set("force_reauth", "true");
  return u.toString();
}

/** Instagram дописывает к коду «#_» — это не часть кода. */
export function cleanIgCode(code: string): string {
  return code.replace(/#_?$/, "").trim();
}

// ─────────────────── обмен токенов ───────────────────────────────────────────

async function readJson(res: Response): Promise<any> {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return { _raw: raw.slice(0, 300) };
  }
}

function metaError(body: any, status: number): string {
  const e = body?.error;
  if (e && typeof e === "object") return `Meta ${status}: ${e.message ?? e.type ?? "ошибка"}`;
  if (body?.error_message) return `Meta ${status}: ${body.error_message}`;
  return `Meta ${status}${body?._raw ? `: ${body._raw}` : ""}`;
}

export async function exchangeIgCode(opts: {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}): Promise<{ accessToken: string; userId: string; permissions: string[] }> {
  const f = opts.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    client_id: opts.appId,
    client_secret: opts.appSecret,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
    code: cleanIgCode(opts.code),
  });
  const res = await f("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(metaError(body, res.status));
  // Документация показывает ответ внутри data[], живой API отдаёт плоский объект. Берём оба.
  const row = Array.isArray(body?.data) ? body.data[0] : body;
  if (!row?.access_token) throw new Error("Meta не вернула токен");
  const perms = row.permissions;
  return {
    accessToken: String(row.access_token),
    userId: row.user_id != null ? String(row.user_id) : "",
    permissions: Array.isArray(perms)
      ? perms.map(String)
      : typeof perms === "string"
        ? perms
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
  };
}

export async function igLongLivedToken(opts: {
  shortToken: string;
  appSecret: string;
  fetchImpl?: FetchLike;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const f = opts.fetchImpl ?? fetch;
  const u = new URL(`${IG_GRAPH}/access_token`);
  u.searchParams.set("grant_type", "ig_exchange_token");
  u.searchParams.set("client_secret", opts.appSecret);
  u.searchParams.set("access_token", opts.shortToken);
  const res = await f(u.toString(), { signal: AbortSignal.timeout(15000) });
  const body = await readJson(res);
  if (!res.ok || !body?.access_token) throw new Error(metaError(body, res.status));
  return { accessToken: String(body.access_token), expiresIn: Number(body.expires_in) || 0 };
}

export async function igRefreshToken(opts: {
  token: string;
  fetchImpl?: FetchLike;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const f = opts.fetchImpl ?? fetch;
  const u = new URL(`${IG_GRAPH}/refresh_access_token`);
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", opts.token);
  const res = await f(u.toString(), { signal: AbortSignal.timeout(15000) });
  const body = await readJson(res);
  if (!res.ok || !body?.access_token) throw new Error(metaError(body, res.status));
  return { accessToken: String(body.access_token), expiresIn: Number(body.expires_in) || 0 };
}

/**
 * `user_id` из /me — ID профессионального аккаунта (17841…), тот самый, что Meta кладёт в
 * entry[].id вебхука. `id` — другой, привязанный к приложению; для маршрутизации он не годится.
 */
export async function igFetchMe(opts: {
  token: string;
  fetchImpl?: FetchLike;
}): Promise<{ userId: string; username: string | null; accountType: string | null }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${IG_GRAPH}/${IG_API_VERSION}/me?fields=user_id,username,account_type`, {
    headers: { Authorization: `Bearer ${opts.token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(metaError(body, res.status));
  const userId = body?.user_id != null ? String(body.user_id) : "";
  if (!userId) throw new Error("Meta не вернула ID аккаунта");
  return {
    userId,
    username: body?.username ?? null,
    accountType: body?.account_type ?? null,
  };
}

export async function igSubscribeWebhooks(opts: {
  token: string;
  fields?: readonly string[];
  fetchImpl?: FetchLike;
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const u = new URL(`${IG_GRAPH}/${IG_API_VERSION}/me/subscribed_apps`);
  u.searchParams.set("subscribed_fields", (opts.fields ?? IG_WEBHOOK_FIELDS).join(","));
  u.searchParams.set("access_token", opts.token);
  const res = await f(u.toString(), { method: "POST", signal: AbortSignal.timeout(15000) });
  const body = await readJson(res);
  if (!res.ok || body?.success === false) throw new Error(metaError(body, res.status));
}

export type IgConnection = {
  igUserId: string;
  username: string | null;
  accountType: string | null;
  token: string;
  expiresAt: string;
  missingScopes: string[];
  /** null — подписка на вебхуки прошла; строка — причина, по которой не прошла. */
  subscribeError: string | null;
};

/** Весь обмен после возврата с instagram.com. Ничего не пишет в базу. */
export async function completeIgLogin(opts: {
  code: string;
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<IgConnection> {
  const appSecret = opts.appSecret ?? igAppSecret();
  if (!appSecret) throw new Error("IG_APP_SECRET не задан");
  const short = await exchangeIgCode({
    code: opts.code,
    appId: opts.appId ?? igAppId(),
    appSecret,
    redirectUri: opts.redirectUri ?? igRedirectUri(),
    fetchImpl: opts.fetchImpl,
  });
  const long = await igLongLivedToken({
    shortToken: short.accessToken,
    appSecret,
    fetchImpl: opts.fetchImpl,
  });
  const me = await igFetchMe({ token: long.accessToken, fetchImpl: opts.fetchImpl });

  // Подписка — не повод проваливать подключение: токен уже есть, а подписку можно повторить.
  // Но молчать нельзя — без неё сообщения просто не придут.
  let subscribeError: string | null = null;
  try {
    await igSubscribeWebhooks({ token: long.accessToken, fetchImpl: opts.fetchImpl });
  } catch (e: any) {
    subscribeError = e?.message ?? String(e);
  }

  const now = opts.now ?? Date.now();
  const ttlMs = (long.expiresIn > 0 ? long.expiresIn : 60 * 24 * 60 * 60) * 1000;
  return {
    igUserId: me.userId,
    username: me.username,
    accountType: me.accountType,
    token: long.accessToken,
    expiresAt: new Date(now + ttlMs).toISOString(),
    // Владелец может снять галочки на экране согласия. Без переписки ассистент бесполезен.
    missingScopes: short.permissions.length
      ? IG_LOGIN_SCOPES.filter((s) => !short.permissions.includes(s))
      : [],
    subscribeError,
  };
}

// ─────────────────── общий вебхук ────────────────────────────────────────────

/**
 * Подпись общего вебхука. Документация Meta говорит «app secret», не уточняя, какой из двух
 * (основного приложения или его Instagram-части). Оба наши, поэтому принимаем любой.
 */
export async function verifyPlatformIgSignature(
  rawBody: string,
  signature: string | null,
  secrets: string[] = [process.env.IG_APP_SECRET ?? "", process.env.META_APP_SECRET ?? ""],
): Promise<boolean> {
  const { igVerifySignature } = await import("@/lib/ig-api.server");
  for (const s of secrets.map((x) => x.trim()).filter(Boolean)) {
    if (await igVerifySignature(s, rawBody, signature)) return true;
  }
  return false;
}

/**
 * Meta может сложить в одну доставку события нескольких аккаунтов. Салон опознаётся по entry[].id,
 * поэтому режем нагрузку на части — по одной на аккаунт, с той же обёрткой.
 */
export function splitIgPayloadByAccount(
  payload: any,
): Array<{ accountId: string; rawBody: string }> {
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  const byId = new Map<string, any[]>();
  for (const e of entries) {
    const id = e?.id != null ? String(e.id) : "";
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(e);
    byId.set(id, list);
  }
  return [...byId].map(([accountId, list]) => ({
    accountId,
    rawBody: JSON.stringify({ ...payload, entry: list }),
  }));
}

// ─────────────────── продление токенов (cron) ────────────────────────────────

export type IgRefreshReport = { checked: number; refreshed: number; failed: string[] };

export async function runIgTokenRefresh(
  opts: { db?: any; fetchImpl?: FetchLike; now?: number } = {},
): Promise<IgRefreshReport> {
  const db = opts.db ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const now = opts.now ?? Date.now();
  const threshold = new Date(now + REFRESH_WHEN_LEFT_MS).toISOString();
  const { data, error } = await db
    .from("salon_secrets")
    .select("salon_id, instagram_token, instagram_token_expires_at")
    .eq("instagram_connected_via", "platform")
    .not("instagram_token", "is", null)
    .lt("instagram_token_expires_at", threshold);
  if (error) throw new Error(error.message);

  const report: IgRefreshReport = { checked: (data ?? []).length, refreshed: 0, failed: [] };
  // Последовательно: салонов немного, а всплеск бьёт по лимиту приложения.
  for (const row of (data ?? []) as any[]) {
    try {
      const r = await igRefreshToken({ token: row.instagram_token, fetchImpl: opts.fetchImpl });
      const ttlMs = (r.expiresIn > 0 ? r.expiresIn : 60 * 24 * 60 * 60) * 1000;
      const { error: upErr } = await db
        .from("salon_secrets")
        .update({
          instagram_token: r.accessToken,
          instagram_token_expires_at: new Date(now + ttlMs).toISOString(),
        })
        .eq("salon_id", row.salon_id);
      if (upErr) throw new Error(upErr.message);
      report.refreshed++;
    } catch (e: any) {
      report.failed.push(row.salon_id);
      try {
        const { logError } = await import("@/lib/error-log.server");
        await logError({
          source: "ig-webhook",
          level: "warn",
          message: `Не удалось продлить токен Instagram: ${e?.message ?? e}. Переподключите Instagram кнопкой во вкладке «Каналы».`,
          salonId: row.salon_id,
        });
      } catch {
        /* журнал не обязан работать, чтобы работало продление у остальных */
      }
    }
  }
  return report;
}
