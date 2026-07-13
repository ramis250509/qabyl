import { expect, test, describe } from "bun:test";
import {
  INDUSTRIES_META,
  INDUSTRY_ORDER,
  DEFAULT_INDUSTRY,
  normalizeIndustry,
  isIndustryKey,
} from "./src/lib/industries";
import { INDUSTRY_EXPERT } from "./src/lib/wa-industries.server";

describe("industry registry integrity", () => {
  test("meta and expert cover exactly the same keys", () => {
    const metaKeys = Object.keys(INDUSTRIES_META).sort();
    const expertKeys = Object.keys(INDUSTRY_EXPERT).sort();
    expect(metaKeys).toEqual(expertKeys);
    expect([...INDUSTRY_ORDER].sort()).toEqual(metaKeys);
  });

  test("default industry is valid and present", () => {
    expect(isIndustryKey(DEFAULT_INDUSTRY)).toBe(true);
    expect(INDUSTRIES_META[DEFAULT_INDUSTRY]).toBeDefined();
    expect(INDUSTRY_EXPERT[DEFAULT_INDUSTRY]).toBeDefined();
  });

  test("normalizeIndustry falls back to default on junk", () => {
    expect(normalizeIndustry("nonsense")).toBe(DEFAULT_INDUSTRY);
    expect(normalizeIndustry(null)).toBe(DEFAULT_INDUSTRY);
    expect(normalizeIndustry(undefined)).toBe(DEFAULT_INDUSTRY);
    expect(normalizeIndustry("barbershop")).toBe("barbershop");
  });

  for (const key of INDUSTRY_ORDER) {
    describe(`industry: ${key}`, () => {
      const meta = INDUSTRIES_META[key];
      const expert = INDUSTRY_EXPERT[key];

      test("meta has label, tagline, emoji and questions", () => {
        expect(meta.label.length).toBeGreaterThan(0);
        expect(meta.tagline.length).toBeGreaterThan(0);
        expect(meta.emoji.length).toBeGreaterThan(0);
        expect(meta.questions.length).toBeGreaterThan(3);
      });

      test("question ids are unique and non-empty", () => {
        const ids = meta.questions.map((q) => q.id);
        expect(ids.every((id) => id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
      });

      test("every question has a label", () => {
        expect(meta.questions.every((q) => q.label.trim().length > 0)).toBe(true);
      });

      test("persona is non-empty and includes the salon name", () => {
        const persona = expert.persona("Тест-Салон");
        expect(persona.length).toBeGreaterThan(20);
        expect(persona).toContain("Тест-Салон");
      });

      test("knowledge base is substantial", () => {
        expect(expert.knowledgeBase.length).toBeGreaterThan(100);
      });

      test("only beauty uses photo pricing", () => {
        expect(expert.usesPhotoPricing).toBe(key === "beauty");
      });
    });
  }
});
