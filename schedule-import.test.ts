// Tests for the schedule-sheet importer.
//
// The cases come from a real clinic's spreadsheet, with every PATIENT NAME replaced by a
// fabricated one — a medical practice's client list has no business living in a git repo.
// The replacements deliberately preserve each name's awkward property (a leading "С"/"Ай",
// a «кызы»/«к» particle, a three-part patronymic, a two-person family cell), because those
// are exactly what the parser gets wrong. Everything else — punctuation, misspellings,
// stray brackets, amounts — is verbatim.
//
// Synthetic examples would have missed every bug this suite actually caught: keyword stems
// eating Kyrgyz names, a deposit equal to its own balance vanishing, and «если что проект»
// being read as a firm 20 000 som programme.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extractAmounts,
  importKeyFor,
  parseCellText,
  parseCsv,
  parseDateHeader,
  parseScheduleSheet,
  parseSlotLabel,
} from "./src/lib/import/schedule-sheet";

const SHEET = readFileSync("test-fixtures/clinic-schedule-anonymised.csv", "utf8");
const TODAY = "2026-08-11";

describe("parseCsv", () => {
  test("keeps a quoted cell containing a comma as one field", () => {
    const rows = parseCsv('a,"Максатова Аяна 20жаш,Максатов Бекжан",c');
    expect(rows[0]).toEqual(["a", "Максатова Аяна 20жаш,Максатов Бекжан", "c"]);
  });

  test("keeps a quoted cell containing a newline as one field", () => {
    const rows = parseCsv('a,"line1\nline2",c\nnext,row,here');
    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe("line1\nline2");
  });

  test("unescapes doubled quotes", () => {
    expect(parseCsv('a,"say ""hi""",c')[0][1]).toBe('say "hi"');
  });
});

describe("parseDateHeader", () => {
  test("reads genitive and nominative month names", () => {
    expect(parseDateHeader("20 июля ", TODAY)).toBe("2026-07-20");
    expect(parseDateHeader("18 август ", TODAY)).toBe("2026-08-18");
    expect(parseDateHeader("22 Октябрь ", TODAY)).toBe("2026-10-22");
    expect(parseDateHeader("01 августа", TODAY)).toBe("2026-08-01");
  });

  test("picks the year closest to today rather than assuming the current one", () => {
    // A sheet being filled in late December that lists 5 января means NEXT January.
    expect(parseDateHeader("5 января", "2026-12-28")).toBe("2027-01-05");
    // …and 28 декабря on the same day means this year, not next.
    expect(parseDateHeader("28 декабря", "2026-12-28")).toBe("2026-12-28");
  });

  test("rejects a header with no day number", () => {
    expect(parseDateHeader("май", TODAY)).toBeNull();
    expect(parseDateHeader("", TODAY)).toBeNull();
  });

  test("rejects an impossible calendar date instead of rolling it over", () => {
    expect(parseDateHeader("31 апреля", TODAY)).toBeNull();
  });
});

describe("parseSlotLabel", () => {
  test("reads the grid's slot labels", () => {
    expect(parseSlotLabel("09:00-09:30")).toEqual({ start: "09:00", end: "09:30" });
    expect(parseSlotLabel("13:30-14:00")).toEqual({ start: "13:30", end: "14:00" });
  });

  test("is not fooled by a non-slot label", () => {
    expect(parseSlotLabel("ОФФЛАЙН")).toBeNull();
    expect(parseSlotLabel("7")).toBeNull();
  });
});

describe("extractAmounts", () => {
  test("reads space- and dot-grouped thousands as thousands", () => {
    expect(extractAmounts("20 000")).toEqual([20000]);
    expect(extractAmounts("21.000")).toEqual([21000]);
    expect(extractAmounts("5000 ост 15000")).toEqual([5000, 15000]);
  });
});

describe("parseCellText — names", () => {
  // Every one of these was truncated or lost by the first implementation, because the
  // keyword stems "с" and "ай" matched the start of the name.
  const cases: Array<[string, string]> = [
    ["Сарыбаева Айнура 7000(Айзада) консультация", "Сарыбаева Айнура"],
    ["Сыдыкова Айчүрөк 5000 ост 15000 Айканыш ", "Сыдыкова Айчүрөк"],
    ["Замирова Сезим 20000 3-ай повтор Гулира ", "Замирова Сезим"],
    ["Замирбек кызы Айпери 3 ай опл 20000с ост.0 с.  Жанара", "Замирбек кызы Айпери"],
    ["Тургунбек к Айсулуу 1000 остаток 19000 Каныкей", "Тургунбек к Айсулуу"],
    ["Ибраева Элина пов. консультация 7000 с Жанара", "Ибраева Элина"],
    ["Асанбек кызы Нургуль 20000 3-ай повтор Гулира ", "Асанбек кызы Нургуль"],
    ["Темирбек кызы Наргиза 1000 ост 19000 Динара ", "Темирбек кызы Наргиза"],
  ];
  for (const [raw, expected] of cases) {
    test(`«${raw.trim().slice(0, 34)}…» → ${expected}`, () => {
      expect(parseCellText(raw).clientName).toBe(expected);
    });
  }
});

describe("parseCellText — money", () => {
  test("keeps the deposit when it equals its own balance", () => {
    // Value-based de-duplication used to drop `paid` entirely here.
    const r = parseCellText("Гулайым 10000 остаток 10000 Каныкей");
    expect(r.paid).toBe(10000);
    expect(r.remainder).toBe(10000);
    expect(r.visitKind).toBe("program"); // 10000 + 10000 = the 20 000 programme
  });

  test("reads deposit and balance", () => {
    const r = parseCellText("Сыдыкова Айчүрөк 5000 ост 15000 Айканыш");
    expect(r.paid).toBe(5000);
    expect(r.remainder).toBe(15000);
  });

  test("ignores clock digits inside a comment", () => {
    const r = parseCellText("Асанова Зууракан 3000 бронь. 12:30 га келет. Мадина");
    expect(r.paid).toBe(3000);
  });

  test("ignores ages in a family cell", () => {
    const r = parseCellText("Максатова Аяна 20жаш,Максатов Бекжан  10жашта. (семейный)");
    expect(r.paid).toBeNull();
  });
});

describe("parseCellText — visit kind", () => {
  test("«3-ай повтор» is a programme", () => {
    expect(parseCellText("Кадырова Мээрим 20000 3-ай повтор Гулира").visitKind).toBe("program");
  });

  test("a hedged «если что проект» stays a consultation", () => {
    const r = parseCellText("Осмонова Салтанат 7000✅ (если что проект) Каныкей");
    expect(r.visitKind).toBe("consultation");
    expect(r.confidence).toBe("medium");
    expect(r.warnings.join(" ")).toContain("под вопросом");
  });

  test("a misspelled repeat consultation is still a repeat", () => {
    expect(parseCellText("Жумалиева. Чынара  павторна кансультатция Нуржан").visitKind).toBe(
      "repeat",
    );
  });

  test("«укол» is an injection", () => {
    expect(parseCellText("Ишенова Алина✅️ укол").visitKind).toBe("injection");
  });
});

describe("parseCellText — curator", () => {
  test("takes a bracketed name wherever it sits", () => {
    expect(parseCellText("Айканыш (Пери) 21.000 доплата кылат").curator).toBe("Пери");
    expect(parseCellText("Сарыбаева Айнура 7000(Айзада) консультация").curator).toBe("Айзада");
  });

  test("falls back to the trailing name", () => {
    expect(parseCellText("Кадырова Мээрим 20000 3-ай повтор Гулира").curator).toBe("Гулира");
  });
});

describe("parseCellText — flags what a human must check", () => {
  test("a family cell is flagged, never silently imported as one person", () => {
    const r = parseCellText("Чоробаев Мирбек, Чоробаева Махабат, семейный 3-ай повтор");
    expect(r.warnings.join(" ")).toContain("семейн");
  });

  test("a cell that is not a booking at all comes back low-confidence", () => {
    expect(parseCellText("Цифровой  Тунукай").confidence).toBe("low");
  });
});

describe("parseScheduleSheet — the real sheet", () => {
  const result = parseScheduleSheet(SHEET, TODAY);

  test("finds every booking in the grid", () => {
    expect(result.bookings.length).toBe(71);
  });

  test("the overwhelming majority parse cleanly", () => {
    const high = result.bookings.filter((b) => b.confidence === "high").length;
    const low = result.bookings.filter((b) => b.confidence === "low").length;
    expect(high).toBeGreaterThanOrEqual(54);
    expect(low).toBeLessThanOrEqual(2);
  });

  test("maps a cell to the right column's date", () => {
    // Row 4 of the sheet, 4th date column of the first block = 23 июля.
    const b = result.bookings.find((x) => x.clientName === "Сыдыкова Айчүрөк");
    expect(b?.date).toBe("2026-07-23");
    expect(b?.startTime).toBe("10:00");
  });

  test("end time comes from the slot, not from the service duration", () => {
    // 30-minute grid. Using the service's 40 minutes would manufacture overlaps that the
    // double-booking exclusion constraint then rejects.
    for (const b of result.bookings) {
      const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      expect(mins(b.endTime) - mins(b.startTime)).toBe(30);
    }
  });

  test("keeps every cell's raw text verbatim", () => {
    for (const b of result.bookings) expect(b.raw.length).toBeGreaterThan(0);
  });

  test("reports the one unparseable date header instead of dropping it silently", () => {
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("май");
  });

  test("no two bookings collide on the same import key", () => {
    const keys = result.bookings.map(importKeyFor);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("importKeyFor", () => {
  const base = { date: "2026-08-13", startTime: "10:00", clientName: "Бегалиева Гулмайрам" };

  test("is stable across harmless edits to the cell", () => {
    // The owner adds a ✅ or records a top-up; the key must not move, or the re-import
    // would duplicate the row instead of recognising it.
    expect(importKeyFor(base)).toBe(importKeyFor({ ...base, clientName: "бегалиева  гулмайрам" }));
    expect(importKeyFor(base)).toBe(importKeyFor({ ...base, clientName: "Бегалиева, Гулмайрам." }));
  });

  test("distinguishes different slots and different people", () => {
    expect(importKeyFor(base)).not.toBe(importKeyFor({ ...base, startTime: "10:30" }));
    expect(importKeyFor(base)).not.toBe(importKeyFor({ ...base, date: "2026-08-14" }));
    expect(importKeyFor(base)).not.toBe(importKeyFor({ ...base, clientName: "Зайна" }));
  });

  test("normalises ё to е so one spelling does not become two rows", () => {
    expect(importKeyFor({ ...base, clientName: "Алёна" })).toBe(
      importKeyFor({ ...base, clientName: "Алена" }),
    );
  });
});
