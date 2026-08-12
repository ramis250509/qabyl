// Regression suite for the Instagram echo classifier.
//
// The bug this was written for: a client commented a keyword twice. The second time, the
// comment-trigger private reply's echo was misread as the salon owner typing, the assistant
// muted itself for five minutes, and the client's answer ("Я щас вешу около 100 кг") was never
// processed. Silent in the logs, silent to the client.
//
// Run: bun test ig-echo.test.ts

import { describe, expect, test } from "bun:test";
import { echoIsOurs, type EchoOwnershipDeps } from "./src/lib/ig-echo";

function deps(over: Partial<EchoOwnershipDeps> = {}): EchoOwnershipDeps & { calls: string[] } {
  const calls: string[] = [];
  const base: EchoOwnershipDeps = {
    echoAppId: null,
    mid: null,
    text: null,
    findOutboundByMid: async () => {
      calls.push("mid");
      return false;
    },
    findRecentOutboundByText: async () => {
      calls.push("text");
      return false;
    },
    recentlyDmedFromComment: async () => {
      calls.push("comment");
      return false;
    },
  };
  // Wrap any override so it still records the call.
  const merged = { ...base, ...over } as EchoOwnershipDeps;
  for (const k of ["findOutboundByMid", "findRecentOutboundByText", "recentlyDmedFromComment"] as const) {
    if (over[k]) {
      const fn = over[k]!;
      const label = k === "findOutboundByMid" ? "mid" : k === "findRecentOutboundByText" ? "text" : "comment";
      (merged as any)[k] = async (...a: any[]) => {
        calls.push(label);
        return (fn as any)(...a);
      };
    }
  }
  return Object.assign(merged, { calls });
}

describe("recognising our own message", () => {
  test("app_id alone settles it", async () => {
    const d = deps({ echoAppId: "123456" });
    expect(await echoIsOurs(d)).toBe(true);
  });

  test("a recorded mid settles it when app_id is absent", async () => {
    const d = deps({ mid: "m1", findOutboundByMid: async () => true });
    expect(await echoIsOurs(d)).toBe(true);
  });

  test("identical text sent moments ago settles it", async () => {
    const d = deps({ mid: "m1", text: "Здравствуйте!", findRecentOutboundByText: async () => true });
    expect(await echoIsOurs(d)).toBe(true);
  });
});

describe("the incident: a comment-trigger private reply coming back", () => {
  // Exactly the production shape. Meta's echo of a private reply carries no app_id; the echo
  // overtook the trigger's own outbound write, so neither the mid nor the text existed yet.
  const incident = {
    echoAppId: null,
    mid: "aWdfZG1f...",
    text: "Здравствуйте, увидели ваш комментарий, вы не могли бы рассказать про ваш вес сейчас?",
    findOutboundByMid: async () => false,
    findRecentOutboundByText: async () => false,
  };

  test("is recognised as ours via the comment ledger, and does NOT pause the assistant", async () => {
    const d = deps({ ...incident, recentlyDmedFromComment: async () => true });
    expect(await echoIsOurs(d)).toBe(true);
  });

  test("without the ledger check it would have been read as a takeover", async () => {
    // Pins the pre-fix behaviour so nobody removes the fourth signal thinking it is redundant.
    const d = deps({ ...incident, recentlyDmedFromComment: async () => false });
    expect(await echoIsOurs(d)).toBe(false);
  });
});

describe("a real human takeover is still detected", () => {
  test("an owner typing in the Instagram app is not ours", async () => {
    const d = deps({
      echoAppId: null, // a human in the app produces no app_id
      mid: "m-human",
      text: "Здравствуйте, это Тунукай, отвечу лично",
      findOutboundByMid: async () => false,
      findRecentOutboundByText: async () => false,
      recentlyDmedFromComment: async () => false,
    });
    expect(await echoIsOurs(d)).toBe(false);
  });

  test("a stale comment DM does not excuse a later human message", async () => {
    // recentlyDmedFromComment is time-bounded by the caller; once it lapses, a human echo is a
    // takeover again. This asserts the classifier honours that answer rather than caching it.
    const d = deps({ text: "я сама отвечу", recentlyDmedFromComment: async () => false });
    expect(await echoIsOurs(d)).toBe(false);
  });
});

describe("cost: the cheap signals short-circuit", () => {
  test("app_id costs no database round-trips at all", async () => {
    const d = deps({ echoAppId: "1", mid: "m", text: "t" });
    await echoIsOurs(d);
    expect(d.calls).toEqual([]);
  });

  test("a matched mid stops before the text and ledger lookups", async () => {
    const d = deps({ mid: "m", text: "t", findOutboundByMid: async () => true });
    await echoIsOurs(d);
    expect(d.calls).toEqual(["mid"]);
  });

  test("the ledger is only consulted when everything cheaper failed", async () => {
    const d = deps({ mid: "m", text: "t" });
    await echoIsOurs(d);
    expect(d.calls).toEqual(["mid", "text", "comment"]);
  });

  test("a missing mid or text skips that lookup instead of querying for null", async () => {
    const d = deps({ mid: null, text: null });
    await echoIsOurs(d);
    expect(d.calls).toEqual(["comment"]);
  });
});
