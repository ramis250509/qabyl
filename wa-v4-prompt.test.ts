// Phase C regression: consultation / complex-service / sales prompt architecture.
// Verifies the beauty-only trees (photo-technologist, damaged-hair «күйгөн чач») are present for
// beauty and correctly GATED OUT for other industries, and that the general feasibility + sales
// blocks appear for everyone. Run: bun test wa-v4-prompt.test.ts
import { test, expect, describe } from "bun:test";
import { buildSystemPromptV4 } from "@/lib/wa-agent-v4.server";

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
});
