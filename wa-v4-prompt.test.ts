// Phase C regression: consultation / complex-service / sales prompt architecture.
// Verifies the beauty-only trees (photo-technologist, damaged-hair «күйгөн чач») are present for
// beauty and correctly GATED OUT for other industries, and that the general feasibility + sales
// blocks appear for everyone. Run: bun test wa-v4-prompt.test.ts
import { test, expect, describe } from "bun:test";
import { buildSystemPromptV4 } from "@/lib/wa-agent-v4.server";
import { ownerPhoneMatches } from "@/lib/wa-agent.server";

function inputFor(industry: string) {
  return {
    salon: { salonId: "s1", salonName: "Тест", timezone: "Asia/Bishkek" },
    config: { industry, languages: ["ru"], manage_cutoff_hours: 0 },
    branches: [],
    salonInfo: { working_hours: null, address: null },
    stateData: {},
  } as any;
}

describe("buildSystemPromptV4 — Phase C blocks", () => {
  const beauty = buildSystemPromptV4(inputFor("beauty"));
  const dental = buildSystemPromptV4(inputFor("dental"));

  test("beauty gets the damaged-hair complex-service tree", () => {
    expect(beauty).toContain("күйгөн чач");
    expect(beauty).toContain("ботокс для волос"); // moderate-damage branch
    expect(beauty).toContain("Тёмное → блонд");
  });

  test("beauty gets the photo-technologist framework", () => {
    expect(beauty).toContain("КАК РАЗБИРАТЬ ФОТО");
  });

  // Real miss in production: client's own nails were short, the reference photo showed long
  // almond nails, and the assistant quoted a plain manicure ("Прекрасный выбор!") — a look that
  // service physically cannot deliver. Must compare length and route to наращивание.
  test("nails guide forces a length comparison against the reference photo", () => {
    expect(beauty).toContain("ДЛИНА — ОБЯЗАТЕЛЬНО СРАВНИ");
    expect(beauty).toContain("НАРАЩИВАНИЕ");
  });

  // Every industry has ITS OWN photoAnalysisGuide (shared "КАК РАЗБИРАТЬ ФОТО" header, distinct
  // per-industry content with the right professional guardrails — dental/medical explicitly must
  // NOT diagnose from a photo). Only the beauty-specific hair-damage content must not leak out.
  test("non-beauty (dental) does NOT get hair-specific trees", () => {
    expect(dental).not.toContain("күйгөн чач");
    expect(dental).not.toContain("ботокс для волос");
    expect(dental).toContain("КАК РАЗБИРАТЬ ФОТО");
    expect(dental).toContain("НЕ ставь диагноз и НЕ называй цену лечения по фото");
  });

  test("feasibility + sales blocks are general (present in both)", () => {
    for (const p of [beauty, dental]) {
      expect(p).toContain("ВЫПОЛНИМОСТЬ «ХОЧУ КАК НА ФОТО»");
      expect(p).toContain("ПРОДАЖИ БЕЗ НАВЯЗЧИВОСТИ");
    }
  });

  // Follow-up fixes: proactive promo mention (#2) and mandatory master choice before booking (#3).
  test("prompt mandates proactively mentioning a relevant promo", () => {
    expect(beauty).toContain("АКЦИИ И СПЕЦПРЕДЛОЖЕНИЯ (ОБЯЗАТЕЛЬНО)");
  });
  test("prompt mandates offering a master choice before confirming (multi-master)", () => {
    expect(beauty).toContain("ВЫБОР МАСТЕРА (ОБЯЗАТЕЛЬНО перед подтверждением записи)");
  });

  // The name was sometimes skipped: the old wording "Узнай имя (если не знаешь)" let the model
  // decide it already knew. Asking must be unconditional, and the name must never be invented
  // or lifted from the WhatsApp profile.
  test("prompt makes asking the client's name mandatory before booking", () => {
    expect(beauty).toContain("ИМЯ КЛИЕНТА (ОБЯЗАТЕЛЬНО, без него не записывать)");
    expect(beauty).not.toContain("Узнай имя (если не знаешь)");
  });

  // "Айгерим, кандайсыз?" — the admin's addressing term must not be mistaken for the client's name.
  test("addressing term is never treated as the client's name", () => {
    const p = buildSystemPromptV4({
      ...inputFor("beauty"),
      config: { industry: "beauty", languages: ["ru"], manage_cutoff_hours: 0, client_addressing: "Айгерим" },
    } as any);
    expect(p).toContain("КАК К ТЕБЕ ОБРАЩАЮТСЯ КЛИЕНТЫ");
    expect(p).toContain("НИКОГДА не записывай его в client_name");
  });
  // Hard guardrail: the assistant invented days off ("17-июль салон иштебейт") that existed
  // nowhere in the data. Saying «выходной» must require closed_that_day or an explicit fact.
  test("prompt forbids inventing days off / schedule", () => {
    for (const p of [beauty, dental]) {
      expect(p).toContain("НИКОГДА не выдумывай выходные");
      expect(p).toContain("hours_not_configured");
    }
  });
  test("salon knowledge_base (where promos live) is injected into the prompt", () => {
    const p = buildSystemPromptV4({
      ...inputFor("beauty"),
      config: {
        industry: "beauty",
        languages: ["ru"],
        manage_cutoff_hours: 0,
        knowledge_base: "Акция: кератин + стрижка + СПА + ботокс в подарок, 2500–7500 сом",
      },
    } as any);
    expect(p).toContain("кератин + стрижка + СПА + ботокс в подарок");
  });
});

// #4: /restart owner gate — tolerant to phone formatting so it stops silently no-op'ing.
describe("ownerPhoneMatches — tolerant owner phone gate", () => {
  test("exact digits match", () => {
    expect(ownerPhoneMatches("996700123456", "996700123456")).toBe(true);
  });
  test("country-code / format difference still matches on last 9 digits", () => {
    expect(ownerPhoneMatches("996700123456", "+996 700 123 456")).toBe(true);
    expect(ownerPhoneMatches("996700123456", "0700123456")).toBe(true); // last 9 = 700123456
  });
  test("different numbers do NOT match", () => {
    expect(ownerPhoneMatches("996700123456", "996700999999")).toBe(false);
  });
  test("empty owner phone → no match (command stays hidden)", () => {
    expect(ownerPhoneMatches("996700123456", "")).toBe(false);
  });
});
