// Instagram comment → DM: webhook parsing and keyword matching.
//
// These are the two places where a bug is invisible in testing and expensive in production —
// a missed match means a paid ad's comments go unanswered, and a wrong match means a private
// reply spent on the wrong person (Meta allows exactly one per comment, so there is no retry).
//
// Run: bun test ig-comment-triggers.test.ts
import { test, expect, describe } from "bun:test";
import {
  commentWithinPrivateReplyWindow,
  matchCommentTrigger,
  normalizeCommentText,
  parseIgCommentWebhook,
  type IgCommentTrigger,
} from "@/lib/ig-api.server";

const SALON_IG_ID = "17841400000000000";

function commentPayload(over: Record<string, any> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: SALON_IG_ID,
        time: 1_754_800_000,
        changes: [
          {
            field: "comments",
            value: {
              id: "comment_1",
              text: "ХОЧУ",
              from: { id: "9988776655", username: "client_one" },
              media: { id: "media_42" },
              timestamp: 1_754_800_000,
              ...over,
            },
          },
        ],
      },
    ],
  };
}

function trigger(over: Partial<IgCommentTrigger> = {}): IgCommentTrigger {
  return {
    id: "t1",
    keyword: "хочу",
    match_mode: "contains",
    media_id: null,
    reply_text: "Здравствуйте! Расскажу подробнее 🙂 Подскажите, что вас интересует?",
    public_reply: null,
    ai_context: null,
    enabled: true,
    ...over,
  };
}

describe("parseIgCommentWebhook", () => {
  test("extracts a comment with its author and post", () => {
    const { igUserId, comments } = parseIgCommentWebhook(commentPayload());
    expect(igUserId).toBe(SALON_IG_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      commentId: "comment_1",
      fromId: "9988776655",
      fromUsername: "client_one",
      text: "ХОЧУ",
      mediaId: "media_42",
      isReply: false,
    });
  });

  // The salon replying under its own post must never trigger a private reply to itself.
  test("drops the account's own comments", () => {
    const { comments } = parseIgCommentWebhook(
      commentPayload({ from: { id: SALON_IG_ID, username: "salon" } }),
    );
    expect(comments).toHaveLength(0);
  });

  test("drops comments with nothing to match on", () => {
    expect(parseIgCommentWebhook(commentPayload({ text: "" })).comments).toHaveLength(0);
    expect(parseIgCommentWebhook(commentPayload({ id: null })).comments).toHaveLength(0);
  });

  test("marks a reply-to-a-comment so it can be treated differently", () => {
    const { comments } = parseIgCommentWebhook(commentPayload({ parent_id: "comment_0" }));
    expect(comments[0].isReply).toBe(true);
  });

  test("live_comments are parsed too, other change fields are not", () => {
    const live = JSON.parse(JSON.stringify(commentPayload()));
    live.entry[0].changes[0].field = "live_comments";
    expect(parseIgCommentWebhook(live).comments).toHaveLength(1);

    const mentions = JSON.parse(JSON.stringify(commentPayload()));
    mentions.entry[0].changes[0].field = "mentions";
    expect(parseIgCommentWebhook(mentions).comments).toHaveLength(0);
  });

  // A DM webhook and a comment webhook arrive on the SAME URL. Each parser must ignore the
  // other's envelope instead of throwing or inventing events.
  test("a plain message payload yields no comments", () => {
    const dm = {
      object: "instagram",
      entry: [
        {
          id: SALON_IG_ID,
          messaging: [
            {
              sender: { id: "123" },
              recipient: { id: SALON_IG_ID },
              message: { mid: "m", text: "привет" },
            },
          ],
        },
      ],
    };
    expect(parseIgCommentWebhook(dm).comments).toHaveLength(0);
  });

  test("garbage payloads do not throw", () => {
    expect(parseIgCommentWebhook(null).comments).toEqual([]);
    expect(parseIgCommentWebhook({ entry: "nope" }).comments).toEqual([]);
    expect(parseIgCommentWebhook({ entry: [{ changes: {} }] }).comments).toEqual([]);
  });
});

describe("normalizeCommentText", () => {
  // Real comments under a promo post are "ЦЕНА!!!🔥🔥" far more often than a bare word.
  test("strips punctuation and emoji, keeps letters and digits", () => {
    expect(normalizeCommentText("ЦЕНА!!! 🔥🔥")).toBe("цена");
    expect(normalizeCommentText("  Хочу,  очень! ")).toBe("хочу очень");
  });

  test("keeps Kyrgyz letters intact", () => {
    expect(normalizeCommentText("КААЛАЙМ 😍")).toBe("каалайм");
  });
});

describe("matchCommentTrigger", () => {
  test("matches case-insensitively through emoji and punctuation", () => {
    expect(matchCommentTrigger([trigger()], { text: "ХОЧУ!!! 🔥", mediaId: "media_42" })?.id).toBe(
      "t1",
    );
  });

  test("exact mode does not fire on a sentence containing the word", () => {
    const t = trigger({ match_mode: "exact" });
    expect(matchCommentTrigger([t], { text: "хочу", mediaId: null })).not.toBeNull();
    expect(matchCommentTrigger([t], { text: "я хочу узнать цену", mediaId: null })).toBeNull();
  });

  test("contains mode fires inside a sentence", () => {
    expect(
      matchCommentTrigger([trigger()], { text: "очень хочу записаться", mediaId: null }),
    ).not.toBeNull();
  });

  test("disabled triggers never fire", () => {
    expect(
      matchCommentTrigger([trigger({ enabled: false })], { text: "хочу", mediaId: null }),
    ).toBeNull();
  });

  // Multi-campaign account: the trigger attached to THIS post must win over the global one,
  // otherwise a catch-all "цена" swallows every campaign's keyword.
  test("a post-scoped trigger beats a catch-all", () => {
    const global = trigger({ id: "global", media_id: null });
    const scoped = trigger({ id: "scoped", media_id: "media_42" });
    expect(matchCommentTrigger([global, scoped], { text: "хочу", mediaId: "media_42" })?.id).toBe(
      "scoped",
    );
    // …and on a different post the scoped one must not fire at all.
    expect(matchCommentTrigger([global, scoped], { text: "хочу", mediaId: "other" })?.id).toBe(
      "global",
    );
  });

  test("exact beats contains at equal scope", () => {
    const loose = trigger({ id: "loose", match_mode: "contains" });
    const strict = trigger({ id: "strict", match_mode: "exact" });
    expect(matchCommentTrigger([loose, strict], { text: "хочу", mediaId: null })?.id).toBe(
      "strict",
    );
  });

  test("the more specific phrase wins between two contains triggers", () => {
    const short = trigger({ id: "short", keyword: "запись" });
    const long = trigger({ id: "long", keyword: "запись на брови" });
    expect(
      matchCommentTrigger([short, long], { text: "хочу запись на брови", mediaId: null })?.id,
    ).toBe("long");
  });

  test("no keyword in the comment means no DM", () => {
    expect(matchCommentTrigger([trigger()], { text: "красиво 😍", mediaId: null })).toBeNull();
    expect(matchCommentTrigger([], { text: "хочу", mediaId: null })).toBeNull();
    expect(matchCommentTrigger([trigger()], { text: "   ", mediaId: null })).toBeNull();
  });

  test("a blank keyword can never match everything", () => {
    // Guards against a trigger row saved as "" turning every comment on the account into a DM.
    expect(
      matchCommentTrigger([trigger({ keyword: "   " })], { text: "привет", mediaId: null }),
    ).toBeNull();
  });
});

describe("private-reply window", () => {
  // Meta refuses a private reply older than 7 days; checking locally saves a call that is
  // guaranteed to fail and would otherwise be logged as a real error.
  test("inside 7 days is allowed, outside is not", () => {
    const now = Date.parse("2026-08-10T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    expect(commentWithinPrivateReplyWindow(now - 6 * day, now)).toBe(true);
    expect(commentWithinPrivateReplyWindow(now - 8 * day, now)).toBe(false);
  });
});
