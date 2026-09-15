import { freedomPayConfig, fpInitPayment, fpGetStatus } from "./freedompay.server";

export type PaymentEvent = {
  key: string;
  outcome: "paid" | "failed" | "canceled" | "refunded";
  info: { paymentId: string; cardMask?: string };
};
export interface PaymentProvider {
  readonly capabilities: {
    checkout: boolean;
    recurring: boolean;
    saveMethod: boolean;
    refunds: boolean;
  };
  createPayment(input: Parameters<typeof fpInitPayment>[1]): ReturnType<typeof fpInitPayment>;
  getPaymentStatus(input: { paymentId?: string; orderId?: string }): ReturnType<typeof fpGetStatus>;
  savePaymentMethod(): Promise<{ redirectUrl: string }>;
  chargeSavedMethod(input: unknown): Promise<{ accepted: boolean; paymentId?: string }>;
  refundPayment(input: unknown): Promise<{ accepted: boolean }>;
  normalizeEvent(
    params: Record<string, string>,
    invoice: {
      id: string;
      provider: string;
      amount_kgs: number;
      provider_payment_id: string | null;
    },
  ): PaymentEvent | null;
}

export function cardLastFour(value?: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d{4})\s*$/);
  return match ? `**** ${match[1]}` : undefined;
}

export function normalizeFreedomPayEvent(
  params: Record<string, string>,
  invoice: { id: string; provider: string; amount_kgs: number; provider_payment_id: string | null },
  merchantId: string,
): PaymentEvent | null {
  if (invoice.provider !== "freedompay" || params.pg_order_id !== invoice.id) return null;
  if (params.pg_merchant_id && params.pg_merchant_id !== merchantId) return null;
  if (!/^\d{1,30}$/.test(params.pg_payment_id ?? "")) return null;
  if (invoice.provider_payment_id && invoice.provider_payment_id !== params.pg_payment_id)
    return null;
  // Currency may be omitted by Result URL; this merchant exclusively accepts KGS.
  if (params.pg_currency && params.pg_currency !== "KGS") return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(params.pg_amount ?? "")) return null;
  if (Number(params.pg_amount) * 100 !== invoice.amount_kgs * 100) return null;
  if (params.pg_captured === "0") return null;
  if (params.pg_result !== "1" && params.pg_result !== "0") return null;
  const outcome = params.pg_result === "1" ? "paid" : "failed";
  return {
    key: `freedompay:${merchantId}:${params.pg_payment_id}:${outcome}`,
    outcome,
    info: { paymentId: params.pg_payment_id, cardMask: cardLastFour(params.pg_card_pan) },
  };
}

const unavailable = async (): Promise<never> => {
  throw new Error("Эта возможность оплаты ещё не подключена. Обратитесь в поддержку.");
};

export function paymentProvider(allowSettlementWhenDisabled = false): PaymentProvider | null {
  const cfg = freedomPayConfig();
  if (!cfg || (!allowSettlementWhenDisabled && process.env.PAYMENTS_ENABLED !== "1")) return null;
  return {
    capabilities: { checkout: true, recurring: false, saveMethod: false, refunds: false },
    createPayment: (input) => fpInitPayment(cfg, { ...input, recurring: false }),
    getPaymentStatus: (input) => fpGetStatus(cfg, input),
    savePaymentMethod: unavailable,
    chargeSavedMethod: unavailable,
    refundPayment: unavailable,
    normalizeEvent: (params, invoice) => normalizeFreedomPayEvent(params, invoice, cfg.merchantId),
  };
}

/** A salon deposit must never inherit Qabyl's subscription acquiring account. */
export async function salonDepositProvider(salonId: string): Promise<never> {
  if (!salonId) throw new Error("Не выбран салон");
  throw new Error("Онлайн-предоплата ожидает подключения платёжного аккаунта салона");
}
