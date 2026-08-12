// Phone input regressions: the booking widget used to hardcode "+996" with a
// parenthesised "(707) 11-17-26" mask. It now shows an unparenthesised mask and
// lets the client pick any country code, so this file pins:
//   1. no country's mask reintroduces parentheses;
//   2. dial-code detection survives overlapping prefixes (+7 / +996 / +998);
//   3. validation stays inside the 10–15 digit window the
//      `validate_appointment_phone` DB trigger enforces, for every country.
// Run: bun test phone-input.test.ts
import { test, expect, describe } from "bun:test";
import {
  DEFAULT_COUNTRY_ISO,
  PHONE_COUNTRIES,
  detectCountry,
  formatNational,
  getCountry,
  isValidPhone,
  maxDigitsOf,
  minDigitsOf,
  nationalDigits,
  onlyDigits,
  placeholderFor,
  toE164,
  type PhoneCountry,
} from "@/lib/phone-countries";

const kg = getCountry("KG")!;
const kz = getCountry("KZ")!;
const ru = getCountry("RU")!;

/** Digits that fill a country's mask completely; 5 leads, so no `firstDigit` rule rejects it. */
function fullDigits(c: PhoneCountry): string {
  return "5" + "1".repeat(maxDigitsOf(c) - 1);
}

describe("mask formatting", () => {
  test("no country mask uses parentheses", () => {
    for (const c of PHONE_COUNTRIES) {
      expect(c.mask).not.toContain("(");
      expect(c.mask).not.toContain(")");
    }
  });

  test("the number from the screenshot renders without parentheses", () => {
    expect(formatNational("707111726", kg.mask)).toBe("707 11-17-26");
  });

  test("partial input never ends on a dangling separator", () => {
    expect(formatNational("", kg.mask)).toBe("");
    expect(formatNational("7", kg.mask)).toBe("7");
    expect(formatNational("707", kg.mask)).toBe("707");
    expect(formatNational("7071", kg.mask)).toBe("707 1");
    expect(formatNational("70711", kg.mask)).toBe("707 11");
    expect(formatNational("707111", kg.mask)).toBe("707 11-1");
  });

  test("each country formats its own full-length number", () => {
    expect(formatNational("9991234567", ru.mask)).toBe("999 123-45-67");
    expect(formatNational("901234567", getCountry("UZ")!.mask)).toBe("90 123-45-67");
    expect(formatNational("4155550123", getCountry("US")!.mask)).toBe("415 555-0123");
  });

  test("digits past the mask are dropped, not appended raw", () => {
    expect(formatNational("707111726999", kg.mask)).toBe("707 11-17-26");
  });

  test("placeholders show the shape without leftover X markers", () => {
    for (const c of PHONE_COUNTRIES) {
      const p = placeholderFor(c);
      expect(p).not.toContain("X");
      expect(onlyDigits(p).length).toBe(maxDigitsOf(c));
    }
  });
});

describe("detectCountry", () => {
  test("picks the longest matching dial code", () => {
    // +996 and +998 both start with 9 — a naive shortest-prefix match would
    // collide with any future +9 entry.
    expect(detectCountry("+996707111726")?.iso).toBe("KG");
    expect(detectCountry("+998901234567")?.iso).toBe("UZ");
    expect(detectCountry("+992901234567")?.iso).toBe("TJ");
    expect(detectCountry("+380501234567")?.iso).toBe("UA");
  });

  test("a shared dial code resolves to the first listed country", () => {
    expect(detectCountry("+79991234567")?.iso).toBe("KZ");
    expect(detectCountry("+14155550123")?.iso).toBe("US");
  });

  test("empty and unknown values return undefined", () => {
    expect(detectCountry("")).toBeUndefined();
    expect(detectCountry("+")).toBeUndefined();
    expect(detectCountry("+59991234567")).toBeUndefined();
  });
});

describe("nationalDigits / toE164", () => {
  test("strips the dial code of the selected country", () => {
    expect(nationalDigits("+996707111726", kg)).toBe("707111726");
    expect(nationalDigits("+79991234567", ru)).toBe("9991234567");
  });

  test("truncates to the country's maximum length", () => {
    expect(nationalDigits("+9967071117269999", kg)).toBe("707111726");
  });

  test("round-trips for every country", () => {
    for (const c of PHONE_COUNTRIES) {
      const d = fullDigits(c);
      const e164 = toE164(c, d);
      expect(e164).toBe(`${c.dial}${d}`);
      expect(nationalDigits(e164, c)).toBe(d);
    }
  });

  test("an empty national part yields an empty string, not a bare dial code", () => {
    expect(toE164(kg, "")).toBe("");
    expect(toE164(kg, "abc")).toBe("");
  });

  test("switching country keeps the digits, trimmed to the new maximum", () => {
    // KZ allows 10 national digits, KG only 9 — this is what the picker does
    // when the client switches after typing.
    const typed = nationalDigits("+79991234567", kz);
    expect(toE164(kg, typed.slice(0, maxDigitsOf(kg)))).toBe("+996999123456");
  });
});

describe("isValidPhone", () => {
  test("accepts a complete Kyrgyz number", () => {
    expect(isValidPhone("+996707111726")).toBe(true);
    expect(isValidPhone("+996555123456")).toBe(true);
  });

  test("rejects incomplete or malformed Kyrgyz numbers", () => {
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone("+996")).toBe(false);
    expect(isValidPhone("+99670711172")).toBe(false); // one digit short
    expect(isValidPhone("+9967071117260")).toBe(false); // one digit long
    expect(isValidPhone("996707111726")).toBe(false); // no leading +
    expect(isValidPhone("+996107111726")).toBe(false); // impossible leading 1
    expect(isValidPhone("+996007111726")).toBe(false); // impossible leading 0
  });

  test("accepts other country codes the client can now pick", () => {
    expect(isValidPhone("+79991234567")).toBe(true); // RU / KZ, 10 digits
    expect(isValidPhone("+992901234567")).toBe(true); // TJ, 9 digits
    expect(isValidPhone("+998901234567")).toBe(true); // UZ, 9 digits
    expect(isValidPhone("+905321234567")).toBe(true); // TR, 10 digits
    expect(isValidPhone("+14155550123")).toBe(true); // US, 10 digits
    expect(isValidPhone("+8613912345678")).toBe(true); // CN, 11 digits
  });

  test("rejects wrong lengths for those country codes", () => {
    expect(isValidPhone("+7999123456")).toBe(false); // RU one short
    expect(isValidPhone("+799912345678")).toBe(false); // RU one long
    expect(isValidPhone("+99890123456")).toBe(false); // UZ one short
  });

  test("honours declared variable-length ranges", () => {
    const kr = getCountry("KR")!;
    expect(minDigitsOf(kr)).toBe(9);
    expect(maxDigitsOf(kr)).toBe(10);
    expect(isValidPhone("+821012345678")).toBe(true); // 10 national digits
    expect(isValidPhone("+82212345678")).toBe(true); // 9 national digits
    expect(isValidPhone("+8221234567")).toBe(false); // 8 national digits, too short
  });

  test("an unlisted dial code falls back to the DB trigger's 10–15 digit rule", () => {
    expect(isValidPhone("+5991234567")).toBe(true);
    expect(isValidPhone("+599123")).toBe(false);
    expect(isValidPhone("+5991234567890123")).toBe(false);
  });

  test("every country's full-length number is accepted", () => {
    for (const c of PHONE_COUNTRIES) {
      const e164 = toE164(c, fullDigits(c));
      expect(isValidPhone(e164)).toBe(true);
    }
  });
});

describe("country table integrity", () => {
  test("ISO codes are unique and the default exists", () => {
    const isos = PHONE_COUNTRIES.map((c) => c.iso);
    expect(new Set(isos).size).toBe(isos.length);
    expect(getCountry(DEFAULT_COUNTRY_ISO)).toBeDefined();
  });

  test("dial codes are a plus followed by digits", () => {
    for (const c of PHONE_COUNTRIES) {
      expect(c.dial).toMatch(/^\+\d{1,4}$/);
    }
  });

  test("every country fits the 10–15 total digit window of the DB trigger", () => {
    // validate_appointment_phone rejects anything outside this range on INSERT,
    // so a country the widget accepts but the database refuses would produce a
    // booking that fails only at the very last step.
    for (const c of PHONE_COUNTRIES) {
      const dialLen = onlyDigits(c.dial).length;
      expect(dialLen + minDigitsOf(c)).toBeGreaterThanOrEqual(10);
      expect(dialLen + maxDigitsOf(c)).toBeLessThanOrEqual(15);
    }
  });

  test("minimum length never exceeds the mask length", () => {
    for (const c of PHONE_COUNTRIES) {
      expect(minDigitsOf(c)).toBeLessThanOrEqual(maxDigitsOf(c));
      expect(minDigitsOf(c)).toBeGreaterThan(0);
    }
  });

  test("both CIS +7 countries and the CIS core are offered", () => {
    const isos = new Set(PHONE_COUNTRIES.map((c) => c.iso));
    for (const iso of ["KG", "KZ", "RU", "UZ", "TJ", "TM", "AZ", "AM", "GE", "BY", "UA"]) {
      expect(isos.has(iso)).toBe(true);
    }
    expect(kz.dial).toBe("+7");
    expect(ru.dial).toBe("+7");
  });
});
