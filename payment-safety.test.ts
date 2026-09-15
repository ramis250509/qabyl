import { describe, expect, test } from "bun:test";
import {
  cardLastFour,
  normalizeFreedomPayEvent,
  paymentProvider,
} from "./src/lib/payment-provider.server";
import { fpSign, fpVerify } from "./src/lib/freedompay.server";
import { readPaymentXml } from "./src/lib/payment-xml.server";

const invoice = {
  id: "invoice",
  provider: "freedompay",
  amount_kgs: 4499,
  provider_payment_id: "123",
};
const valid = {
  pg_order_id: "invoice",
  pg_payment_id: "123",
  pg_amount: "4499.00",
  pg_currency: "KGS",
  pg_result: "1",
  pg_merchant_id: "456",
};
describe("confirmed payment boundaries", () => {
  test("disabling new payments preserves callback settlement", () => {
    const keys = [
      "PAYMENTS_ENABLED",
      "FREEDOMPAY_MERCHANT_ID",
      "FREEDOMPAY_SECRET_KEY",
      "FREEDOMPAY_API_BASE",
    ] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.PAYMENTS_ENABLED = "0";
      process.env.FREEDOMPAY_MERCHANT_ID = "test-merchant";
      process.env.FREEDOMPAY_SECRET_KEY = "test-only-secret";
      process.env.FREEDOMPAY_API_BASE = "https://api.freedompay.kg";
      expect(paymentProvider()).toBeNull();
      expect(paymentProvider(true)).not.toBeNull();
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
  test("deduplicates regardless of notification salt", () => {
    const first = normalizeFreedomPayEvent(valid, invoice, "456");
    expect(first?.outcome).toBe("paid");
    expect(normalizeFreedomPayEvent({ ...valid, pg_salt: "new" }, invoice, "456")?.key).toBe(
      first?.key,
    );
  });
  for (const patch of [
    { pg_amount: "NaN" },
    { pg_amount: "4500" },
    { pg_amount: "4498" },
    { pg_currency: "USD" },
    { pg_order_id: "other" },
    { pg_payment_id: "124" },
    { pg_merchant_id: "457" },
    { pg_result: "ok" },
    { pg_amount: "4.499e3" },
  ]) {
    test(`rejects mismatched ${JSON.stringify(patch)}`, () =>
      expect(normalizeFreedomPayEvent({ ...valid, ...patch }, invoice, "456")).toBeNull());
  }
  test("never persists full card digits", () => {
    expect(cardLastFour("4111111111111111")).toBe("**** 1111");
    expect(cardLastFour("411111******1234")).toBe("**** 1234");
    expect(cardLastFour("garbage")).toBeUndefined();
  });
  test("tampering invalidates signed callback", () => {
    const signed = { ...valid, pg_sig: fpSign("freedompay", valid, "test-secret") };
    expect(fpVerify("freedompay", signed, "test-secret")).toBe(true);
    expect(fpVerify("freedompay", { ...signed, pg_amount: "1" }, "test-secret")).toBe(false);
  });
  test("failure does not masquerade as success", () =>
    expect(normalizeFreedomPayEvent({ ...valid, pg_result: "0" }, invoice, "456")?.outcome).toBe(
      "failed",
    ));
  test("nested XML retains repeated refund entries and decodes entities", () => {
    const xml = readPaymentXml(
      "<response><pg_description>A &amp; B</pg_description><pg_refund_payments><pg_refund_payment><pg_amount>1</pg_amount></pg_refund_payment><pg_refund_payment><pg_amount>2</pg_amount></pg_refund_payment></pg_refund_payments><pg_sig>sig</pg_sig></response>",
    );
    expect(xml.fields.pg_description).toBe("A & B");
    expect(xml.signatureFields.pg_refund_payments002pg_refund_payment001pg_amount001).toBe("1");
    expect(xml.signatureFields.pg_refund_payments002pg_refund_payment002pg_amount001).toBe("2");
    expect(Object.values(xml.signatureFields)).not.toContain("sig");
  });
  test("malformed XML and external entities fail closed", () => {
    expect(() => readPaymentXml('<!DOCTYPE x SYSTEM "file:///secret"><response/>')).toThrow();
    expect(() => readPaymentXml("<response><pg_amount>1</response>")).toThrow();
    expect(() =>
      readPaymentXml("<response><pg_sig>a</pg_sig><pg_sig>b</pg_sig></response>"),
    ).toThrow();
  });
  test("authorization without capture is not paid", () =>
    expect(normalizeFreedomPayEvent({ ...valid, pg_captured: "0" }, invoice, "456")).toBeNull());
});
