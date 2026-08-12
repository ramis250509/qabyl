// Starting language of the assistant + the per-language style guides.
//
// Run: bun test wa-language-style.test.ts

import { test, expect, describe } from "bun:test";
import { buildSystemPromptV4 } from "@/lib/wa-agent-v4.server";
import { languageStyleBlock } from "@/lib/wa-language-style";
import { detectLanguage, confidentLanguage } from "@/lib/wa-agent.server";

function inputFor(over: Record<string, unknown> = {}) {
  return {
    salon: { salonId: "s1", salonName: "Тест", timezone: "Asia/Bishkek" },
    config: { industry: "medical", languages: ["ru", "ky"], manage_cutoff_hours: 0, ...over },
    branches: [],
    salonInfo: { working_hours: null, address: null },
    stateData: {},
  } as any;
}

describe("languageStyleBlock", () => {
  test("Russian costs nothing — the base prompt is already Russian", () => {
    expect(languageStyleBlock("ru")).toBe("");
  });

  test("Kyrgyz gets the Bishkek conversational guide", () => {
    const ky = languageStyleBlock("ky");
    expect(ky).toContain("ЖИВОЙ КЫРГЫЗСКИЙ");
    // The two failure modes the guide exists to prevent, both named explicitly.
    expect(ky).toContain("РУССКИЕ СЛОВА — ЭТО НОРМАЛЬНО"); // not a stiff literary translation
    expect(ky).toContain("БЕЗ КАРИКАТУРЫ"); // …and not fake-illiterate either
    expect(ky).toContain("СИЗ"); // polite form is non-negotiable
  });

  test("the guide shows contrast pairs, not just rules", () => {
    const ky = languageStyleBlock("ky");
    expect(ky).toContain("Плохо (книжно");
    expect(ky).toContain("Плохо (каша");
    expect(ky).toContain("Хорошо:");
  });
});

describe("style block reaches the system prompt only for its own language", () => {
  test("a Kyrgyz turn carries the Kyrgyz guide", () => {
    expect(buildSystemPromptV4(inputFor(), [], "", "ky", "")).toContain("ЖИВОЙ КЫРГЫЗСКИЙ");
  });

  test("a Russian turn does not pay for it", () => {
    expect(buildSystemPromptV4(inputFor(), [], "", "ru", "")).not.toContain("ЖИВОЙ КЫРГЫЗСКИЙ");
  });

  test("an English turn gets its own short guide, not the Kyrgyz one", () => {
    const en = buildSystemPromptV4(inputFor(), [], "", "en", "");
    expect(en).toContain("ENGLISH STYLE");
    expect(en).not.toContain("ЖИВОЙ КЫРГЫЗСКИЙ");
  });
});

// The reason start_language exists at all: detectLanguage is right for Russian-speaking salons
// and wrong for a Kyrgyz-speaking one whose clients open in words that carry no Kyrgyz marker.
// These assertions pin the gap that the setting fills.
describe("why a configured opening language is needed", () => {
  test("plain Cyrillic with no Kyrgyz marker is not a confident signal", () => {
    for (const t of ["Здравствуйте", "Добрый день", "Записаться можно?"]) {
      expect(confidentLanguage(t)).toBe(false);
      // …and the detector's fallback is Russian, whatever the client actually speaks.
      expect(detectLanguage(t)).toBe("ru");
    }
  });

  test("a real Kyrgyz marker still wins over any configured default", () => {
    for (const t of ["Салам, канча турат?", "Бүгүн жазып койсоңуз болобу", "Ассаламу алейкум"]) {
      expect(confidentLanguage(t)).toBe(true);
      expect(detectLanguage(t)).toBe("ky");
    }
  });

  test("a confident English signal is still recognised", () => {
    expect(confidentLanguage("hello, how much is a consultation?")).toBe(true);
    expect(detectLanguage("hello, how much is a consultation?")).toBe("en");
  });
});

describe("medical care pathway reaches the prompt", () => {
  test("the assistant is told to follow the pathway and never invent payment rules", () => {
    const p = buildSystemPromptV4(inputFor(), [], "", "ru", "");
    expect(p).toContain("МАРШРУТ ПАЦИЕНТА");
    expect(p).toContain("ОПЛАТА ПО ШАГАМ");
    expect(p).toContain("ВЫДУМЫВАТЬ правила оплаты");
  });

  test("a beauty salon is not burdened with the medical pathway block", () => {
    const p = buildSystemPromptV4(inputFor({ industry: "beauty" }), [], "", "ru", "");
    expect(p).not.toContain("МАРШРУТ ПАЦИЕНТА");
  });
});
