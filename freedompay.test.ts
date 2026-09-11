// Подпись Freedom Pay: без неё шлюз отвергает каждый запрос, а поддельное уведомление об оплате
// продлило бы подписку бесплатно.
//
// Запуск: bun test freedompay.test.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fpCallbackResponse, fpSign, fpVerify, md5, parseFpXml } from "./src/lib/freedompay.server";

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
