import { readPaymentXml } from "./payment-xml.server";
// Freedom Pay (Кыргызстан): приём карт и автосписание подписки Qabyl.
//
// ЧТО ИЗВЕСТНО ИЗ ДОКУМЕНТАЦИИ (freedompay.kg/docs/merchant-api, сверено 11.09.2026):
//   • Базовый адрес https://api.freedompay.kg, запросы — POST form-data, ответы — XML.
//   • Любой запрос и ответ подписывается: MD5 от строки
//       <имя скрипта>;<значения всех полей в алфавитном порядке ключей>;<secret_key>
//     где имя скрипта — последний сегмент пути (init_payment.php).
//   • init_payment.php — платёж. pg_recurring_start=1 начинает рекуррентный профиль,
//     pg_recurring_lifetime — срок в месяцах (1–156). В ответе pg_redirect_url — форма оплаты.
//   • Результат приходит POST на pg_result_url: pg_order_id, pg_payment_id, pg_result (1/0),
//     pg_card_pan, pg_card_token. Ответ мерчанта — подписанный XML с pg_status ok/rejected.
//     Не ответили — Freedom Pay повторяет каждые 30 минут в течение двух часов.
//   • get_status3.php — статус платежа; revoke.php — возврат.
//
// Saved-card and partner flows require merchant activation and certification. No guessed endpoints.

export type FreedomPayConfig = {
  merchantId: string;
  secretKey: string;
  apiBase: string;
  testing: boolean;
  recurringScript?: string;
};

export function freedomPayConfig(): FreedomPayConfig | null {
  const merchantId = (process.env.FREEDOMPAY_MERCHANT_ID ?? "").trim();
  const secretKey = (process.env.FREEDOMPAY_SECRET_KEY ?? "").trim();
  if (!merchantId || !secretKey) return null;
  const apiBase = process.env.FREEDOMPAY_API_BASE ?? "https://api.freedompay.kg";
  if (apiBase !== "https://api.freedompay.kg") throw new Error("Unsupported acquiring endpoint");
  return {
    merchantId,
    secretKey,
    apiBase: (process.env.FREEDOMPAY_API_BASE ?? "https://api.freedompay.kg").replace(/\/$/, ""),
    testing: process.env.FREEDOMPAY_TESTING !== "0",
  };
}

// ---------------------------------------------------------------------------
// Подпись
// ---------------------------------------------------------------------------

/**
 * MD5 на чистом JS.
 *
 * Своя реализация, а не crypto.subtle: MD5 в Web Crypto не стандартен и есть не во всех средах,
 * где этот код исполняется (Cloudflare Workers, Bun в тестах). Подпись Freedom Pay — не
 * криптографическая защита, а контрольная сумма с общим секретом, и стойкость MD5 здесь не нужна.
 */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const n = bytes.length;
  const words = new Array<number>((((n + 8) >> 6) + 1) * 16).fill(0);
  for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[words.length - 2] = n * 8;

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0,
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + words[chunk + g]) | 0;
      B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const hex = (x: number) =>
    Array.from({ length: 4 }, (_, i) =>
      ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, "0"),
    ).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/** Подпись Freedom Pay. pg_sig в подписываемые поля не входит. */
export function fpSign(script: string, params: Record<string, string>, secretKey: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "pg_sig")
    .sort();
  const parts = [script, ...keys.map((k) => params[k]), secretKey];
  return md5(parts.join(";"));
}

export function fpVerify(
  script: string,
  params: Record<string, string>,
  secretKey: string,
): boolean {
  const got = (params.pg_sig ?? "").toLowerCase();
  if (!got) return false;
  const expected = fpSign(script, params, secretKey);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function salt(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Транспорт
// ---------------------------------------------------------------------------

/** Достаёт значения <pg_x>…</pg_x> из XML-ответа. Структура у Freedom Pay плоская. */
export function parseFpXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<(pg_[a-z0-9_]+)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (!(m[1] in out)) out[m[1]] = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  }
  return out;
}

async function fpPost(
  cfg: FreedomPayConfig,
  script: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: Record<string, string> } | { ok: false; error: string }> {
  const body: Record<string, string> = {
    ...params,
    pg_merchant_id: cfg.merchantId,
    pg_salt: salt(),
  };
  if (cfg.testing) body.pg_testing_mode = "1";
  body.pg_sig = fpSign(script, body, cfg.secretKey);

  try {
    const res = await fetch(`${cfg.apiBase}/${script}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const { fields: data, signatureFields } = readPaymentXml(text);
    if (
      !fpVerify(
        script.split("/").pop()!,
        { ...signatureFields, pg_sig: data.pg_sig },
        cfg.secretKey,
      )
    )
      return { ok: false, error: "Ответ банка не подтверждён" };
    if (!res.ok) return { ok: false, error: `Freedom Pay HTTP ${res.status}` };
    if ((data.pg_status ?? "").toLowerCase() !== "ok") {
      return {
        ok: false,
        error: data.pg_error_description || data.pg_description || "Freedom Pay отклонил запрос",
      };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Freedom Pay недоступен: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Операции
// ---------------------------------------------------------------------------

/**
 * Платёж через форму Freedom Pay: владелец салона вводит карту на их странице.
 *
 * С recurring=true Freedom Pay заводит рекуррентный профиль: дальше продление списывается без
 * участия владельца. Номер карты к нам не попадает — только маска и идентификатор профиля.
 */
export async function fpInitPayment(
  cfg: FreedomPayConfig,
  p: {
    orderId: string;
    amountKgs: number;
    description: string;
    userId: string;
    email?: string | null;
    phone?: string | null;
    resultUrl: string;
    successUrl: string;
    failureUrl: string;
    recurring: boolean;
  },
): Promise<{ ok: true; paymentId: string; redirectUrl: string } | { ok: false; error: string }> {
  const params: Record<string, string> = {
    pg_order_id: p.orderId,
    pg_amount: String(p.amountKgs),
    pg_currency: "KGS",
    pg_description: p.description,
    pg_user_id: p.userId,
    pg_result_url: p.resultUrl,
    pg_request_method: "POST",
    pg_success_url_method: "GET",
    pg_failure_url_method: "GET",
    pg_success_url: p.successUrl,
    pg_failure_url: p.failureUrl,
    pg_lifetime: "3600",
    pg_postpone_payment: "0",
  };
  if (p.email) params.pg_user_contact_email = p.email;
  if (p.phone) params.pg_user_phone = p.phone.replace(/\D/g, "");
  if (p.recurring) {
    params.pg_recurring_start = "1";
    params.pg_recurring_lifetime = "156";
  }

  const res = await fpPost(cfg, "init_payment.php", params);
  if (!res.ok) return res;
  const redirectUrl = res.data.pg_redirect_url;
  if (!redirectUrl || !/^https:\/\/([a-z0-9-]+\.)*freedompay\.kg(?::443)?\//i.test(redirectUrl))
    return { ok: false, error: "Freedom Pay не вернул ссылку на оплату" };
  return { ok: true, paymentId: res.data.pg_payment_id ?? "", redirectUrl };
}

/**
 * Списание по рекуррентному профилю — без владельца. Скрипт подтвердить у Freedom Pay (см. шапку).
 *
 * Результат может прийти двумя путями: синхронно в ответе и уведомлением на pg_result_url.
 * Истина — уведомление: обработчик идемпотентен по pg_payment_id, поэтому двойное подтверждение
 * не продлевает подписку дважды.
 */
export async function fpChargeRecurring(
  cfg: FreedomPayConfig,
  p: {
    recurringProfileId: string;
    orderId: string;
    amountKgs: number;
    description: string;
    resultUrl: string;
  },
): Promise<{ ok: true; paymentId: string; status: string } | { ok: false; error: string }> {
  return { ok: false, error: "Автоматические списания ожидают подтверждения Freedom Pay" };
}

export async function fpGetStatus(
  cfg: FreedomPayConfig,
  p: { paymentId?: string; orderId?: string },
): Promise<
  { ok: true; paid: boolean; raw: Record<string, string> } | { ok: false; error: string }
> {
  const params: Record<string, string> = {};
  if (p.paymentId) params.pg_payment_id = p.paymentId;
  if (p.orderId) params.pg_order_id = p.orderId;
  const res = await fpPost(cfg, "get_status3.php", params);
  if (!res.ok) return res;
  const st = (res.data.pg_payment_status ?? "").toLowerCase();
  return { ok: true, paid: st === "success", raw: res.data };
}

/** Подписанный XML-ответ на уведомление Freedom Pay. */
export function fpCallbackResponse(
  script: string,
  status: "ok" | "rejected",
  description: string,
  secretKey: string,
): string {
  const params: Record<string, string> = {
    pg_status: status,
    pg_description: description,
    pg_salt: salt(),
  };
  params.pg_sig = fpSign(script, params, secretKey);
  const inner = Object.entries(params)
    .map(([k, v]) => `<${k}>${v.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><response>${inner}</response>`;
}
