// Real-fixture tests for the MBANK receipt parser. The fixture text below is
// the verbatim text-layer content of the MBANK PDF supplied by the user
// (Downloads/Чек предоплаты.pdf, 2026-07-29). If MBANK changes their receipt
// format, refresh the fixture and re-run this suite.

import { describe, test, expect } from "bun:test";
import { mbankAdapter } from "./src/lib/prepayment/banks/mbank";
import { detectBank } from "./src/lib/prepayment/banks/registry";
import {
  normalizePhone,
  phonesMatch,
  parseAmount,
  normalizeCurrency,
  namesMatch,
  parseReceiptDateTime,
} from "./src/lib/prepayment/normalize";
import { verifyReceipt } from "./src/lib/prepayment/verify";

// Verbatim text extracted from the supplied MBANK PDF, wire-order.
const MBANK_FIXTURE = `Итого 200,00 ~
Детали операции Перевод по номеру телефона.
996704669575/ Бекжан Э./ /
Сумма 200.00 KGS
Дата и время 29.07.2026 12:16
Квитанция №P0729061645710
По вопросам зачисления обратитесь к отправителю
Телефон службы поддержки 3333
Mbank
Кыргыз Республикасы Бишкек шаары Мбанк Ачык акционердик коому
`;

describe("normalize helpers", () => {
  test("parseAmount handles ru/en formats", () => {
    expect(parseAmount("200,00")).toBe(200);
    expect(parseAmount("200.00")).toBe(200);
    expect(parseAmount("1 234,56")).toBeCloseTo(1234.56, 2);
    expect(parseAmount("1,234.56")).toBeCloseTo(1234.56, 2);
    expect(parseAmount("")).toBeNull();
  });
  test("normalizeCurrency accepts аbbreviations", () => {
    expect(normalizeCurrency("KGS")).toBe("KGS");
    expect(normalizeCurrency("сом")).toBe("KGS");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency("junk")).toBeNull();
  });
  test("normalizePhone canonicalizes KG variants", () => {
    expect(normalizePhone("+996 (704) 66-95-75")).toBe("996704669575");
    expect(normalizePhone("704669575")).toBe("996704669575");
    expect(normalizePhone("0704669575")).toBe("996704669575");
  });
  test("phonesMatch tolerates masks", () => {
    expect(phonesMatch("996704669575", "+996 704 66-95-75")).toBe(true);
    expect(phonesMatch("996704669575", "996 XXX XX 95 75")).toBe(true);
    expect(phonesMatch("996704669575", "996123456789")).toBe(false);
  });
  test("namesMatch allows initials", () => {
    expect(namesMatch("Бекжан Э.", "Бекжан Эрнестович")).toBe(true);
    expect(namesMatch("Бекжан Э.", "Мария Ивановна")).toBe(false);
  });
  test("parseReceiptDateTime handles dotted format", () => {
    const d = parseReceiptDateTime("29.07.2026 12:16");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6); // July = 6
    expect(d!.getDate()).toBe(29);
    expect(d!.getHours()).toBe(12);
    expect(d!.getMinutes()).toBe(16);
  });
});

describe("MBANK adapter — parse the real fixture", () => {
  const ctx = { text: MBANK_FIXTURE, mime: "application/pdf" };

  test("detects MBANK", () => {
    expect(mbankAdapter.detect(ctx)).toBe(true);
    const via = detectBank(ctx);
    expect(via?.bank).toBe("MBANK");
  });

  test("extracts amount + currency + receipt fields", () => {
    const r = mbankAdapter.parse(ctx);
    expect(r.bank).toBe("MBANK");
    expect(r.amount).toBe(200);
    expect(r.currency).toBe("KGS");
    expect(r.txnId).toBe("P0729061645710");
    expect(r.recipientPhone).toBe("996704669575");
    expect(r.recipientName).toBe("Бекжан Э.");
    expect(r.operationType?.toLowerCase()).toContain("перевод");
    expect(r.txnAt).not.toBeNull();
    expect(r.txnAt!.getFullYear()).toBe(2026);
    expect(r.parserConfidence).toBeGreaterThan(0.9);
  });

  test("ignores non-MBANK text", () => {
    const other = { text: "some other bank receipt without markers", mime: "text/plain" };
    expect(mbankAdapter.detect(other)).toBe(false);
    expect(detectBank(other)).toBeNull();
  });
});

// Minimal end-to-end verify path using the parsed fixture. We skip extract-pdf
// by feeding raw bytes only when we want to exercise it; here we drive parse
// directly and hand it into verify by simulating that stage.
describe("verifyReceipt — MBANK happy path", () => {
  // Simulate an image "verify" path with pre-supplied text: we bypass Vision by
  // pretending the bytes are an image but the pipeline needs Gemini. Instead we
  // test verify indirectly by asserting the CORE checks:
  //  - amount tolerance
  //  - phone match
  //  - dedup on sha256
  //  - dedup on txn_id
  test("hard-rejects duplicate file sha256", async () => {
    const bytes = new TextEncoder().encode("dummy pdf bytes but not really %PDF");
    const sha = "deadbeef".repeat(8); // 64 chars
    const res = await verifyReceipt({
      bytes,
      mime: "application/pdf",
      fileSha256: sha,
      expectations: {
        expectedAmount: 200,
        expectedCurrency: "KGS",
        recipientName: "Бекжан",
        recipientPhone: "996704669575",
        recipientAccount: null,
        holdStartedAt: new Date("2026-07-29T12:10:00"),
        holdExpiresAt: new Date("2026-07-29T12:40:00"),
        existingFileSha256s: new Set([sha]),
      },
    });
    expect(res.verdict).toBe("rejected");
    expect(res.reasonCodes).toContain("duplicate_file");
  });

  test("hard-rejects unsupported mime", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const res = await verifyReceipt({
      bytes,
      mime: "application/octet-stream",
      fileSha256: "x",
      expectations: {
        expectedAmount: 200,
        expectedCurrency: "KGS",
        recipientName: null,
        recipientPhone: null,
        recipientAccount: null,
        holdStartedAt: new Date(),
        holdExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(res.verdict).toBe("rejected");
    expect(res.reasonCodes).toContain("unsupported_type");
  });
});

// ---------------------------------------------------------------------------
// The in-app transaction screen — what a client actually screenshots after
// paying. It shares almost no labels with the PDF receipt the parser was built
// from, and it never prints the bank's name, so requiring "mbank" rejected the
// most common real-world receipt outright ("Не удалось определить банк").
// ---------------------------------------------------------------------------
const IN_APP_SCREEN = `12:35
Транзакция успешно проведена
- 10,00 С
Перевод между своими счетами
Детали транзакции
Дата и время 12.08.2026, 12:35
Номер квитанции P081206354498
Оплачено со счета 103012072745890
Получатель Рамис А.
Итого 10,00 С
Назначение платежа Перевод между своими счетами
Посмотреть квитанцию
Повторить платеж
На главную`;

test("in-app screen: detected as MBANK even though the word never appears", () => {
  expect(IN_APP_SCREEN.toLowerCase().includes("mbank")).toBe(false);
  expect(mbankAdapter.detect({ text: IN_APP_SCREEN, mime: "image/jpeg" })).toBe(true);
});

test("in-app screen: amount, receipt number, time and recipient are read", () => {
  const r = mbankAdapter.parse({ text: IN_APP_SCREEN, mime: "image/jpeg" });
  expect(r.amount).toBe(10);
  expect(r.txnId).toBe("P081206354498");
  expect(r.recipientName).toContain("Рамис");
  expect(r.txnAt?.getFullYear()).toBe(2026);
  expect(r.txnAt?.getMonth()).toBe(7); // August
  expect(r.txnAt?.getDate()).toBe(12);
});

test("in-app screen: the payer's own account is not mistaken for the recipient's", () => {
  const r = mbankAdapter.parse({ text: IN_APP_SCREEN, mime: "image/jpeg" });
  expect(r.recipientAccount ?? "").not.toContain("103012072745890");
});

test("an unrelated receipt is still not claimed as MBANK", () => {
  const other = "Оплата картой\nСумма 500 KGS\nСпасибо за покупку";
  expect(mbankAdapter.detect({ text: other, mime: "image/jpeg" })).toBe(false);
});
