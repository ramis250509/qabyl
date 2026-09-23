import { expect, test } from "bun:test";
import { measuredCostUsd, pendingUpperBoundUsd, canStartRequest } from "./budget";

test("Gemini 2.5 Flash usage is metered from returned token counts, including thinking", () => {
  expect(
    measuredCostUsd("gemini-2.5-flash", {
      promptTokenCount: 10_000,
      cachedContentTokenCount: 5_000,
      candidatesTokenCount: 1_000,
      thoughtsTokenCount: 100,
    }),
  ).toBeCloseTo(0.00575, 8);
});

test("no usage metadata never turns a charged request into zero spend", () => {
  expect(measuredCostUsd("gemini-2.5-flash", null)).toBeNull();
});

test("request reserve covers an uncached 2.5 Flash prompt and maximum output", () => {
  const request = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "ok" }] }],
    generationConfig: { maxOutputTokens: 2_048 },
  });
  expect(pendingUpperBoundUsd("gemini-2.5-flash", request)).toBeGreaterThan(0.005);
  expect(pendingUpperBoundUsd("gemini-2.5-flash", request)).toBeLessThan(0.02);
});

test("a new request is refused before its reserve can cross the one-dollar cap", () => {
  expect(canStartRequest(0.98, 0.03, 1)).toBe(false);
  expect(canStartRequest(0.95, 0.03, 1)).toBe(true);
});
