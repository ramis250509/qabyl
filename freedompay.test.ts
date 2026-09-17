// Подпись Freedom Pay: без неё шлюз отвергает каждый запрос, а поддельное уведомление об оплате
// продлило бы подписку бесплатно.
//
// Запуск: bun test freedompay.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  fpCallbackResponse,
  fpInitPayment,
  fpSign,
  fpVerify,
  md5,
  parseFpXml,
} from "./src/lib/freedompay.server";

const nodeMd5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

describe("md5", () => {
  test("известные значения", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });
  test("совпадает с node:crypto на кириллице и длинных строках", () => {
    for (const s of ["Qabyl Business: 1 месяц", "привет", "x".repeat(1000), "a;b;c;секрет"]) {
      expect(md5(s)).toBe(nodeMd5(s));
    }
  });
});

describe("подпись", () => {
  test("скрипт; значения по алфавиту ключей; секрет", () => {
    const params = { pg_order_id: "42", pg_amount: "6499", pg_merchant_id: "123", pg_salt: "abc" };
    const expected = nodeMd5(["init_payment.php", "6499", "123", "42", "abc", "SECRET"].join(";"));
    expect(fpSign("init_payment.php", params, "SECRET")).toBe(expected);
  });

  test("pg_sig в подпись не входит", () => {
    const params = { pg_order_id: "42", pg_salt: "s" };
    const sig = fpSign("freedompay", params, "K");
    expect(fpSign("freedompay", { ...params, pg_sig: sig }, "K")).toBe(sig);
  });

  test("проверка проходит у своей подписи и падает на подмене суммы", () => {
    const params: Record<string, string> = {
      pg_order_id: "42",
      pg_amount: "6499",
      pg_result: "1",
      pg_salt: "s",
    };
    params.pg_sig = fpSign("freedompay", params, "K");
    expect(fpVerify("freedompay", params, "K")).toBe(true);
    expect(fpVerify("freedompay", { ...params, pg_amount: "1" }, "K")).toBe(false);
    expect(fpVerify("freedompay", params, "OTHER")).toBe(false);
    expect(fpVerify("freedompay", { ...params, pg_sig: "" }, "K")).toBe(false);
  });
});

describe("XML", () => {
  test("разбор ответа шлюза", () => {
    const x =
      "<?xml version='1.0'?><response><pg_status>ok</pg_status><pg_payment_id>777</pg_payment_id><pg_redirect_url><![CDATA[https://pay/x?a=1&b=2]]></pg_redirect_url></response>";
    expect(parseFpXml(x)).toEqual({
      pg_status: "ok",
      pg_payment_id: "777",
      pg_redirect_url: "https://pay/x?a=1&b=2",
    });
  });

  test("ответ на уведомление подписан и разбирается обратно", () => {
    const body = fpCallbackResponse("freedompay", "ok", "Принято", "K");
    const parsed = parseFpXml(body);
    expect(parsed.pg_status).toBe("ok");
    expect(fpVerify("freedompay", parsed, "K")).toBe(true);
  });
});

describe("init_payment", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const cfg = {
    merchantId: "561397",
    secretKey: "K",
    apiBase: "https://api.freedompay.kg",
    testing: true,
  };
  const input = {
    orderId: "inv-1",
    amountKgs: 6499,
    description: "Qabyl Pro: 1 месяц",
    userId: "salon-1",
    resultUrl: "https://qabyl.com/api/public/billing/freedompay",
    successUrl: "https://qabyl.com/admin/billing?payment=success",
    failureUrl: "https://qabyl.com/admin/billing?payment=failed",
    recurring: false,
  };

  function bankReplies(status: string) {
    const fields: Record<string, string> = {
      pg_status: status,
      pg_payment_id: "987654",
      pg_redirect_url: "https://customer.freedompay.kg/pay.html?customer=abc",
      pg_salt: "s",
    };
    fields.pg_sig = fpSign("init_payment.php", fields, "K");
    const inner = Object.entries(fields)
      .map(([k, v]) => `<${k}>${v.replace(/&/g, "&amp;")}</${k}>`)
      .join("");
    globalThis.fetch = (async () =>
      new Response(`<?xml version="1.0" encoding="utf-8"?><response>${inner}</response>`, {
        status: 200,
      })) as unknown as typeof fetch;
  }

  // Дока init_payment 2026 года отвечает success, старые *.php — ok. Принимать надо оба.
  for (const status of ["ok", "success"]) {
    test(`pg_status=${status} даёт ссылку на оплату`, async () => {
      bankReplies(status);
      const res = await fpInitPayment(cfg, input);
      expect(res).toEqual({
        ok: true,
        paymentId: "987654",
        redirectUrl: "https://customer.freedompay.kg/pay.html?customer=abc",
      });
    });
  }

  test("pg_status=error — отказ", async () => {
    bankReplies("error");
    const res = await fpInitPayment(cfg, input);
    expect(res.ok).toBe(false);
  });

  test("форма оплаты запрашивается на русском", async () => {
    let sent = "";
    bankReplies("ok");
    const mocked = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = String(init.body);
      return mocked(url as never, init as never);
    }) as unknown as typeof fetch;

    await fpInitPayment(cfg, input);
    expect(new URLSearchParams(sent).get("pg_language")).toBe("ru");
  });
});
