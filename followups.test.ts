// Every test here names a message that must NOT be sent.
//
// That framing is deliberate: the happy path is one line, and all the risk is in the refusals.
// A follow-up wrongly sent is invisible until a client complains or Instagram limits the account.
//
// Run: bun test followups.test.ts

import { describe, expect, test } from "bun:test";
import {
  decideFollowup,
  localHour,
  windowHoursFor,
  type FollowupCandidate,
  type FollowupSettings,
} from "./src/lib/followups.server";

const TZ = "Asia/Bishkek";
// 2026-08-12 14:00 Bishkek — inside working hours.
const NOW = Date.parse("2026-08-12T08:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function candidate(over: Partial<FollowupCandidate> = {}): FollowupCandidate {
  return {
    conversationId: "c1",
    channel: "instagram",
    lastClientMessageAt: hoursAgo(4),
    lastMessageAt: hoursAgo(4),
    lastDirection: "out",
    hasUnprocessedInbound: false,
    status: "active",
    aiPaused: false,
    followupSentAt: null,
    excluded: false,
    ...over,
  };
}

const SETTINGS: FollowupSettings = {
  enabled: true,
  delayHours: 3,
  text: "Здравствуйте! Вы спрашивали про программу — подскажите, остались вопросы?",
};

const decide = (c: Partial<FollowupCandidate> = {}, s: Partial<FollowupSettings> = {}) =>
  decideFollowup(candidate(c), { ...SETTINGS, ...s }, { nowMs: NOW, timezone: TZ });

describe("the one case where we do send", () => {
  test("we answered, the client went quiet, and we are inside the window", () => {
    expect(decide()).toEqual({ send: true });
  });
});

describe("never send twice", () => {
  test("a conversation already nudged is left alone forever", () => {
    expect(decide({ followupSentAt: hoursAgo(1) })).toEqual({
      send: false,
      reason: "already_sent",
    });
  });
});

describe("never talk over a person", () => {
  test("a live admin handling the thread is not interrupted", () => {
    expect(decide({ aiPaused: true })).toEqual({ send: false, reason: "ai_paused" });
  });

  test("if the client wrote last, answer them — do not send a script", () => {
    expect(decide({ lastDirection: "in" })).toEqual({
      send: false,
      reason: "client_spoke_last",
    });
  });

  test("an unprocessed inbound message blocks the nudge", () => {
    // Otherwise a backlog turns into "we ignored your question, but here is our sales pitch".
    expect(decide({ hasUnprocessedInbound: true })).toEqual({
      send: false,
      reason: "unanswered_message_pending",
    });
  });
});

describe("never chase someone who already bought", () => {
  for (const status of ["booked", "done"]) {
    test(`status=${status} is left alone`, () => {
      expect(decide({ status })).toEqual({ send: false, reason: "already_booked" });
    });
  }

  test("an excluded contact is never messaged", () => {
    expect(decide({ excluded: true })).toEqual({ send: false, reason: "excluded_contact" });
  });
});

describe("the platform window is a hard limit", () => {
  test("Instagram past 23 hours is dropped, not queued", () => {
    expect(decide({ lastClientMessageAt: hoursAgo(30) })).toEqual({
      send: false,
      reason: "outside_messaging_window",
    });
  });

  test("WhatsApp Cloud has the same 24-hour service window", () => {
    expect(windowHoursFor("whatsapp_cloud")).toBe(23);
    expect(
      decide({ channel: "whatsapp_cloud", lastClientMessageAt: hoursAgo(26) }),
    ).toEqual({ send: false, reason: "outside_messaging_window" });
  });

  test("Green-API has no platform window, but we still cap ourselves", () => {
    // No rule forces this one. Messaging days later from a real account is what gets it banned.
    expect(windowHoursFor("whatsapp")).toBe(48);
    expect(decide({ channel: "whatsapp", lastClientMessageAt: hoursAgo(30) })).toEqual({
      send: true,
    });
    expect(decide({ channel: "whatsapp", lastClientMessageAt: hoursAgo(60) })).toEqual({
      send: false,
      reason: "outside_messaging_window",
    });
  });

  test("22 hours on Instagram still just fits", () => {
    expect(decide({ lastClientMessageAt: hoursAgo(22) })).toEqual({ send: true });
  });
});

describe("timing", () => {
  test("before the configured delay nothing goes out", () => {
    expect(decide({ lastClientMessageAt: hoursAgo(1) })).toEqual({
      send: false,
      reason: "too_soon",
    });
  });

  test("the owner's delay is respected, not a built-in default", () => {
    expect(decide({ lastClientMessageAt: hoursAgo(4) }, { delayHours: 6 })).toEqual({
      send: false,
      reason: "too_soon",
    });
    expect(decide({ lastClientMessageAt: hoursAgo(7) }, { delayHours: 6 })).toEqual({
      send: true,
    });
  });
});

describe("quiet hours", () => {
  // 23:00 Bishkek.
  const night = Date.parse("2026-08-12T17:00:00Z");
  // 06:00 Bishkek.
  const earlyMorning = Date.parse("2026-08-12T00:00:00Z");

  test("nothing is sent late at night", () => {
    expect(localHour(night, TZ)).toBe(23);
    const r = decideFollowup(
      candidate({ lastClientMessageAt: new Date(night - 4 * 3_600_000).toISOString() }),
      SETTINGS,
      { nowMs: night, timezone: TZ },
    );
    expect(r).toEqual({ send: false, reason: "quiet_hours" });
  });

  test("nothing is sent at dawn either", () => {
    expect(localHour(earlyMorning, TZ)).toBe(6);
    const r = decideFollowup(
      candidate({ lastClientMessageAt: new Date(earlyMorning - 4 * 3_600_000).toISOString() }),
      SETTINGS,
      { nowMs: earlyMorning, timezone: TZ },
    );
    expect(r).toEqual({ send: false, reason: "quiet_hours" });
  });

  test("quiet hours are read in the SALON's timezone, not the server's", () => {
    // Same instant, two zones: evening in Bishkek, afternoon in Moscow.
    const instant = Date.parse("2026-08-12T16:30:00Z"); // 22:30 Bishkek, 19:30 Moscow
    expect(localHour(instant, "Asia/Bishkek")).toBe(22);
    expect(localHour(instant, "Europe/Moscow")).toBe(19);
  });
});

describe("configuration", () => {
  test("disabled sends nothing", () => {
    expect(decide({}, { enabled: false })).toEqual({ send: false, reason: "disabled" });
  });

  test("enabled with no text sends nothing rather than something generic", () => {
    // We never write the owner's message for them.
    expect(decide({}, { text: null })).toEqual({ send: false, reason: "no_text" });
    expect(decide({}, { text: "   " })).toEqual({ send: false, reason: "no_text" });
  });
});
