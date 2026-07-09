// Unit tests for isLikelyNativeGreetingRace — a pure predicate, no DB/Gemini mocking needed.
// Kept in its own file (unlike wa-agent-v3.scenarios.test.ts's mock.module/dbProxy setup) since
// this needs none of that boilerplate. Run: bun test wa-native-greeting-race.test.ts
import { test, expect } from "bun:test";
import { isLikelyNativeGreetingRace } from "@/lib/wa-agent.server";

const WINDOW_MS = 20_000; // must match NATIVE_GREETING_RACE_WINDOW_MS in wa-agent.server.ts

test("no bot reply yet, well within window -> suppress (the actual race condition)", () => {
  expect(
    isLikelyNativeGreetingRace({ hasBotReplyThisSession: false, sessionAgeMs: 3000 }),
  ).toBe(true);
});

test("no bot reply yet, just past window -> do NOT suppress (bot broken/slow, staff intervenes later)", () => {
  expect(
    isLikelyNativeGreetingRace({ hasBotReplyThisSession: false, sessionAgeMs: WINDOW_MS + 1 }),
  ).toBe(false);
});

test("bot already replied, within window -> do NOT suppress (staff jumping in right after the bot)", () => {
  expect(
    isLikelyNativeGreetingRace({ hasBotReplyThisSession: true, sessionAgeMs: 3000 }),
  ).toBe(false);
});

test("boundary: sessionAgeMs exactly equal to the window -> do NOT suppress (strict <, not <=)", () => {
  expect(
    isLikelyNativeGreetingRace({ hasBotReplyThisSession: false, sessionAgeMs: WINDOW_MS }),
  ).toBe(false);
});

test("defensive: negative sessionAgeMs (clock skew) -> do NOT suppress", () => {
  expect(
    isLikelyNativeGreetingRace({ hasBotReplyThisSession: false, sessionAgeMs: -50 }),
  ).toBe(false);
});
