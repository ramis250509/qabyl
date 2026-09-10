// Кредитная линия YCloud: как салон получает оплату сообщений, ничего не платя Meta сам.
//
// ЗАЧЕМ. Qabyl — Tech Provider, а Tech Provider по правилам Meta не может платить за клиента:
// каждый салон обязан привязать к своему аккаунту WhatsApp собственную карту. Для владелицы салона
// в Бишкеке это стоп-фактор — она не заводит карту в кабинете Meta. Выход, который Meta сама
// предусматривает, — Multi-Partner Solution с Solution Partner: салон проходит НАШЕ окно подключения
// с `solutionID`, а за сообщения платит кредитная линия партнёра. Партнёр — YCloud: без наценки на
// тарифы Meta, списание в реальном времени с баланса Qabyl.
//
// ЧТО ЗДЕСЬ, А ЧЕГО НЕТ. Сообщения по-прежнему идут через наш Cloud API — решение создаётся с
// правом отправки «Only me». От YCloud нужно ровно две вещи: привязать аккаунт салона к их
// кредитной линии после подключения и сказать, сколько денег осталось. Транспорта YCloud здесь нет
// намеренно: если YCloud потребует слать через их API, это отдельная реализация WaTransport.
//
// ВСЁ ВЫКЛЮЧЕНО, ПОКА НЕ ЗАДАН YCLOUD_API_KEY. Без ключа ни один вызов не делается, и салоны
// работают как раньше — со своей картой в Meta.

const BASE = "https://api.ycloud.com/v2";

export function ycloudApiKey(): string {
  return (process.env.YCLOUD_API_KEY ?? "").trim();
}

/** Платит ли за сообщения платформа. Определяет, что говорить владельцу о способе оплаты. */
export function platformBillingEnabled(): boolean {
  return Boolean(ycloudApiKey());
}

type YResult<T> = { ok: true; data: T } | { ok: false; status: number | null; error: string };

async function ycloud<T = any>(method: "GET" | "POST", path: string): Promise<YResult<T>> {
  const key = ycloudApiKey();
  if (!key) return { ok: false, status: null, error: "YCLOUD_API_KEY не задан" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: String(msg) };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      status: null,
      error: aborted ? "YCloud не ответил за 20 секунд" : (e as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Привязан ли к аккаунту салона способ оплаты — по мнению YCloud.
 * null — не знаем: аккаунт не привязан к YCloud, ключа нет или YCloud не ответил.
 */
export async function ycloudPaymentAttached(wabaId: string): Promise<boolean | null> {
  if (!platformBillingEnabled()) return null;
  const res = await ycloud<{ paymentMethodAttached?: boolean }>(
    "GET",
    `/whatsapp/businessAccounts/${encodeURIComponent(wabaId)}`,
  );
  if (!res.ok) return null;
  return typeof res.data?.paymentMethodAttached === "boolean"
    ? res.data.paymentMethodAttached
    : null;
}

/**
 * Привязывает аккаунт салона к YCloud после окна подключения.
 *
 * Два разных вызова, и путать их нельзя: `tp/bind` — для нового аккаунта WhatsApp API, `smb/bind`
 * — для coexistence, когда номер остаётся в приложении WhatsApp Business на телефоне салона.
 *
 * Ответ `smb/bind` поля `paymentMethodAttached` не содержит, поэтому после любого успешного
 * привязывания состояние оплаты перечитывается отдельно — иначе на экране салона было бы
 * «неизвестно» ровно для самого частого у нас случая.
 *
 * ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ YCloud: кредитная линия цепляется только к аккаунту, созданному в окне
 * подключения. Если салон выбрал уже существующий аккаунт с привязанной картой, привязка пройдёт, а
 * оплата — нет. Это видно по `paymentMethodAttached: false`.
 */
export async function ycloudBindWaba(
  wabaId: string,
  coexistence: boolean,
): Promise<{ ok: boolean; paymentMethodAttached: boolean | null; error?: string }> {
  const kind = coexistence ? "smb" : "tp";
  const res = await ycloud<{ paymentMethodAttached?: boolean }>(
    "POST",
    `/whatsapp/businessAccounts/${encodeURIComponent(wabaId)}/${kind}/bind`,
  );
  if (!res.ok) return { ok: false, paymentMethodAttached: null, error: res.error };

  if (typeof res.data?.paymentMethodAttached === "boolean") {
    return { ok: true, paymentMethodAttached: res.data.paymentMethodAttached };
  }
  return { ok: true, paymentMethodAttached: await ycloudPaymentAttached(wabaId) };
}

/**
 * Проверяет баланс YCloud и поднимает тревогу, когда денег мало.
 *
 * ПОЧЕМУ ЭТО КРИТИЧНО. Баланс один на все салоны. Когда он кончается, YCloud перестаёт оплачивать
 * сообщения — и молчат ВСЕ салоны разом, без единой ошибки на нашей стороне: Meta просто отбивает
 * отправку. Узнать об этом по жалобам клиентов — худший из вариантов.
 *
 * Порог — YCLOUD_BALANCE_ALERT_USD, по умолчанию $20: с 01.10.2026 активный салон тратит около
 * $27 в месяц, то есть $20 — это меньше месяца работы одного салона.
 */
export async function checkYcloudBalance(): Promise<{
  checked: boolean;
  amount?: number;
  currency?: string;
  low?: boolean;
  error?: string;
}> {
  if (!platformBillingEnabled()) return { checked: false };

  const res = await ycloud<{ amount?: number; currency?: string }>("GET", "/balance");
  if (!res.ok) return { checked: false, error: res.error };

  const amount = Number(res.data?.amount ?? NaN);
  const currency = String(res.data?.currency ?? "USD");
  const threshold = Number(process.env.YCLOUD_BALANCE_ALERT_USD ?? 20);
  const low = Number.isFinite(amount) && amount < threshold;

  if (low) {
    const { logError } = await import("@/lib/error-log.server");
    await logError({
      source: "wa-health",
      level: "error",
      message: `Баланс YCloud ${amount.toFixed(2)} ${currency} — ниже порога ${threshold}. Пополните: когда он кончится, все салоны перестанут отправлять сообщения в WhatsApp.`,
      context: { amount, currency, threshold },
    });
  }

  return { checked: true, amount, currency, low };
}
