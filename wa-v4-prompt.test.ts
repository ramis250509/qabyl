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

  test("non-beauty (dental) does NOT get hair-specific trees", () => {
    expect(dental).not.toContain("күйгөн чач");
    expect(dental).not.toContain("КАК РАЗБИРАТЬ ФОТО");
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
