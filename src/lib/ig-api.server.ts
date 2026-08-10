// Instagram Direct transport for the AI admin.
//
// WHY THIS AND NOT AN AGGREGATOR: Meta's Instagram Messaging API is free — there is no per-message
// fee and no monthly subscription. ManyChat/Chatfuel-class aggregators start around $15–30/mo per
// account, which does not fit the budget and adds a third party between the salon and its clients.
// Talking to Meta directly costs $0 of transport; the only variable cost of an Instagram
// conversation is the Gemini spend the assistant already has on WhatsApp.
//
// WHICH META API: the "Instagram Login" flavour (graph.instagram.com), NOT the older
// Facebook-Page-linked flavour (graph.facebook.com/<page-id>/messages). The Instagram Login flow
// lets a salon connect its Instagram professional account on its own, without creating and linking
// a Facebook Page — the single biggest drop-off point for small salons in KG/KZ/RU. The token the
// salon pastes in is an Instagram User access token with `instagram_business_manage_messages`.
//
// Requirements on the salon's side (documented in the admin UI):
//   1. Instagram account switched to Professional (Business or Creator).
//   2. In the Meta app: Instagram → API setup with Instagram login → generate a long-lived token.
//   3. Webhooks: subscribe the `messages` field to our per-salon URL.
//
// Everything here is transport only — no business logic. The webhook route owns the state machine.

const IG_API_VERSION = "v23.0";
const IG_GRAPH = `https://graph.instagram.com/${IG_API_VERSION}`;

// Instagram Direct rejects a message body over 1000 characters outright (error 100). The assistant
// is prompted to write short replies, but a price list or a long consultation answer can still run
// over — and a hard rejection would mean the client gets NOTHING back, which is far worse than two
// bubbles. Chunking is at 950 to leave room for the "…" continuation marker.
const IG_TEXT_LIMIT = 950;

export type IgCreds = {
  /** Long-lived Instagram user access token (instagram_business_manage_messages). */
  token: string;
  /** The salon's Instagram professional account id — used for logging/validation only. */
  igUserId?: string | null;
};

export type IgSendResult = { ok: true; messageId?: string } | { ok: false; error: string };

/**
 * Split a reply into Instagram-sized chunks WITHOUT cutting mid-word.
 * Prefers paragraph breaks, then sentence ends, then whitespace — a hard character cut is the
 * last resort. Exported for tests.
 */
export function splitForInstagram(text: string, limit = IG_TEXT_LIMIT): string[] {
  const clean = (text ?? "").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Best break point, most natural first. `length` matters: the cut goes AFTER the delimiter, so
    // a sentence keeps its full stop instead of the period opening the next bubble. Because
    // lastIndexOf only matches a delimiter fully inside the window, index + length is never past
    // the limit.
    const candidates: Array<[index: number, length: number]> = [
      [window.lastIndexOf("\n\n"), 2],
      [window.lastIndexOf("\n"), 1],
      [window.lastIndexOf(". "), 2],
      [window.lastIndexOf("! "), 2],
      [window.lastIndexOf("? "), 2],
      [window.lastIndexOf(" "), 1],
    ];
    // Ignore a break point in the first half — chunking a 950-character reply into 60 + 890
    // is worse than a clean hard cut.
    const chosen = candidates.find(([i]) => i > limit * 0.5);
    const cut = chosen ? chosen[0] + chosen[1] : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

async function igPost(creds: IgCreds, path: string, body: unknown): Promise<IgSendResult> {
  try {
    const res = await fetch(`${IG_GRAPH}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON error body — keep the raw text for the log */
    }
    if (!res.ok) {
      // Meta packs the useful part into error.message; error.code 190 = token expired/revoked,
      // which is the failure a salon owner will actually hit (tokens last 60 days and must be
      // refreshed). Surfacing the code verbatim is what makes that diagnosable from the logs.
      const err = parsed?.error;
      return {
        ok: false,
        error: err
          ? `IG ${res.status} code=${err.code ?? "?"} ${err.message ?? ""}`.trim()
          : `IG ${res.status} ${raw.slice(0, 300)}`,
      };
    }
    return { ok: true, messageId: parsed?.message_id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Send a text reply to an Instagram user. Long replies go out as several ordered bubbles;
 * the result reports the FIRST message id (used for outbound dedup bookkeeping).
 *
 * Note the sequential await: Instagram delivers in arrival order, so firing the chunks in
 * parallel would let bubble 2 land before bubble 1.
 */
export async function igSendMessage(
  creds: IgCreds,
  recipientId: string,
  text: string,
): Promise<IgSendResult> {
  const chunks = splitForInstagram(text);
  if (chunks.length === 0) return { ok: false, error: "empty text" };

  // Meta documents this endpoint both as /me/messages and as /<IG_ID>/messages, and which one a
  // given token is accepted on has varied. Resolving it once here — on the first chunk, then
  // reusing the winner — keeps a token that only works on the explicit-id form from producing a
  // salon whose assistant reads every message and answers none.
  let path = "/me/messages";
  let first: IgSendResult | null = null;
  for (const chunk of chunks) {
    const payload = { recipient: { id: recipientId }, message: { text: chunk } };
    let res = await igPost(creds, path, payload);
    if (!res.ok && path === "/me/messages" && creds.igUserId) {
      const viaId = await igPost(creds, `/${creds.igUserId}/messages`, payload);
      if (viaId.ok) {
        path = `/${creds.igUserId}/messages`;
        res = viaId;
      } else {
        // Both forms failed — report the /me error, which is the documented default and the more
        // meaningful of the two.
        return res;
      }
    }
    if (!first) first = res;
    // Stop on the first failure — sending the tail of a reply whose head never arrived
    // produces a confusing half-message for the client.
    if (!res.ok) return res;
  }
  return first ?? { ok: false, error: "no chunks sent" };
}

/** Send an image by public URL (used to relay a photo/price sheet). Best-effort. */
export async function igSendImage(
  creds: IgCreds,
  recipientId: string,
  imageUrl: string,
): Promise<IgSendResult> {
  return igPost(creds, "/me/messages", {
    recipient: { id: recipientId },
    message: { attachment: { type: "image", payload: { url: imageUrl } } },
  });
}

/**
 * Typing indicator. Purely cosmetic but worth the one request: an agent turn takes several
 * seconds (Gemini + tool loop) and a silent thread reads as "nobody is there".
 * Failures are swallowed — never let a cosmetic call break a reply.
 */
export async function igSendTypingOn(creds: IgCreds, recipientId: string): Promise<void> {
  try {
    await igPost(creds, "/me/messages", {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    });
  } catch {
    /* cosmetic only */
  }
}

/**
 * Private reply to a comment — the ONLY officially supported way to start a DM with someone
 * who has never written to the account. https://developers.facebook.com/docs/instagram-platform/private-replies/
 *
 * The mechanics Meta enforces, and which the caller must respect:
 *   * the recipient is the COMMENT id, not a user id (that is the whole trick);
 *   * exactly ONE private reply per comment — a second attempt is rejected, which is why the
 *     webhook keeps a dedup ledger (instagram_comment_events) rather than relying on retries
 *     being harmless;
 *   * it must be sent within 7 DAYS of the comment;
 *   * after this one message we may not send another until the person replies. So the text
 *     has to be self-contained AND invite an answer — an opener that ends without a question
 *     burns the single shot we get.
 *   * requires instagram_business_manage_comments in addition to the messaging permission.
 */
export async function igSendPrivateReply(
  creds: IgCreds,
  commentId: string,
  text: string,
): Promise<IgSendResult> {
  // Never chunk here: chunking would mean two messages, and the second one is exactly what
  // Meta forbids until the person answers. Truncating is the honest failure mode.
  const body = text.length > IG_TEXT_LIMIT ? `${text.slice(0, IG_TEXT_LIMIT - 1)}…` : text;
  const payload = { recipient: { comment_id: commentId }, message: { text: body } };
  const res = await igPost(creds, "/me/messages", payload);
  if (!res.ok && creds.igUserId) {
    return igPost(creds, `/${creds.igUserId}/messages`, payload);
  }
  return res;
}

/**
 * Public reply under the comment ("ответила вам в директ 💌"). Optional and separate from the
 * private reply on purpose: the DM is the conversion, but other readers of the post only see
 * the public thread — an account that never answers publicly looks abandoned.
 */
export async function igSendCommentReply(
  creds: IgCreds,
  commentId: string,
  message: string,
): Promise<IgSendResult> {
  return igPost(creds, `/${encodeURIComponent(commentId)}/replies`, { message });
}

/**
 * Look up the sender's display name / handle. Instagram gives us an IGSID, not a name, so
 * without this every conversation in the admin panel would read as a bare number.
 * Returns null on any failure — a missing name must never block a reply.
 */
export async function igFetchProfile(
  creds: IgCreds,
  igsid: string,
): Promise<{ name: string | null; username: string | null } | null> {
  try {
    const res = await fetch(`${IG_GRAPH}/${encodeURIComponent(igsid)}?fields=name,username`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return { name: body?.name ?? null, username: body?.username ?? null };
  } catch {
    return null;
  }
}

/**
 * Verify Meta's X-Hub-Signature-256 over the RAW request body.
 *
 * Our webhook URL is public and its path is guessable (it contains only the salon id), so without
 * this anyone who learns a salon id could POST fake client messages and drive the assistant. The
 * per-salon verify token only protects the GET handshake — it is NOT sent on POSTs. This signature
 * is therefore the only real authentication on the inbound message path, which is why the route
 * refuses to process a salon that has no app secret configured.
 *
 * Comparison is constant-time: an early-exit compare leaks the position of the first wrong byte.
 */
export async function igVerifySignature(
  appSecret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!appSecret || !header) return false;
  const expectedHex = header.startsWith("sha256=") ? header.slice(7) : header;
  if (!/^[0-9a-f]+$/i.test(expectedHex)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const actualHex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const a = actualHex.toLowerCase();
    const b = expectedHex.toLowerCase();
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webhook payload parsing
// ---------------------------------------------------------------------------

export type IgInboundEvent = {
  /** IGSID of the person we reply to (the client — even for echoes, where they are the recipient). */
  clientId: string;
  /** Instagram message id, used for webhook dedup (Meta redelivers on any non-200). */
  mid: string | null;
  text: string | null;
  imageUrl: string | null;
  audioUrl: string | null;
  /**
   * true for ANY message sent by the business account — including the ones this bot just sent
   * through the API. On its own it does NOT mean a human took over; see `echoAppId`.
   */
  isEcho: boolean;
  /**
   * Present on echoes of messages sent through an app (i.e. by us, via the API). A message typed
   * by a human in the Instagram app carries no app id. This is what separates "the salon owner is
   * answering" from "our own reply came back".
   */
  echoAppId: string | null;
  /** Tap on an icebreaker / generic-template button. */
  postbackPayload: string | null;
  /** Message the client is replying to (story mention, post share…), for context only. */
  replyToStory: boolean;
  timestampMs: number;
};

/**
 * Flatten Meta's nested webhook envelope into the events we act on.
 *
 * Meta batches: one POST can carry several entries, each with several messaging events, and mixes
 * in event types we do not handle (`read`, `reaction`, delivery receipts). Anything without a
 * message or a postback is dropped here so the route only ever sees real client input.
 */
export function parseIgWebhook(payload: any): {
  igUserId: string | null;
  events: IgInboundEvent[];
} {
  const events: IgInboundEvent[] = [];
  let igUserId: string | null = null;

  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    if (!igUserId && entry?.id) igUserId = String(entry.id);
    // Instagram Login sends `messaging`; the Page-linked flavour sends `standby`/`changes`.
    const messaging: any[] = Array.isArray(entry?.messaging)
      ? entry.messaging
      : Array.isArray(entry?.standby)
        ? entry.standby
        : [];

    for (const ev of messaging) {
      const senderId = ev?.sender?.id ? String(ev.sender.id) : null;
      const recipientId = ev?.recipient?.id ? String(ev.recipient.id) : null;
      const msg = ev?.message;
      const postback = ev?.postback;
      if (!msg && !postback) continue; // read receipts, reactions, delivery — nothing to answer
      if (msg?.is_deleted) continue;

      const isEcho = Boolean(msg?.is_echo);
      // On an echo the salon is the sender and the CLIENT is the recipient; on a normal inbound
      // it is the other way round. Either way we key the conversation on the client.
      const clientId = isEcho ? recipientId : senderId;
      if (!clientId) continue;
      // A salon's own account id showing up as the client means Meta echoed our own delivery
      // back to us — never treat that as a conversation.
      if (clientId === entry?.id) continue;

      const attachments: any[] = Array.isArray(msg?.attachments) ? msg.attachments : [];
      const image = attachments.find((a) => a?.type === "image");
      const audio = attachments.find((a) => a?.type === "audio" || a?.type === "voice");
      // A share/story attachment has no text the assistant can use — the caption, if any, is
      // already in msg.text. We surface the image so photo-based pricing still works.

      events.push({
        clientId,
        mid: msg?.mid ? String(msg.mid) : postback?.mid ? String(postback.mid) : null,
        text: (msg?.text ?? postback?.title ?? null) || null,
        imageUrl: image?.payload?.url ?? null,
        audioUrl: audio?.payload?.url ?? null,
        isEcho,
        echoAppId: msg?.app_id != null ? String(msg.app_id) : null,
        postbackPayload: postback?.payload ?? null,
        replyToStory: Boolean(msg?.reply_to?.story),
        timestampMs: Number(ev?.timestamp) || Date.now(),
      });
    }
  }

  return { igUserId, events };
}

// ---------------------------------------------------------------------------
// Comments → DM (Private Replies)
// ---------------------------------------------------------------------------

export type IgCommentEvent = {
  commentId: string;
  /** IGSID of the commenter — same id space as a DM sender, so it keys the same conversation. */
  fromId: string | null;
  fromUsername: string | null;
  text: string;
  /** Post/reel the comment sits under. Lets a trigger be scoped to one campaign. */
  mediaId: string | null;
  /** A reply to another comment rather than a top-level one. */
  isReply: boolean;
  timestampMs: number;
};

/**
 * Comments arrive on `entry[].changes[]` with field "comments", NOT on `entry[].messaging`
 * — a different shape entirely from the DM webhook, which is why it needs its own parser.
 *
 * Deliberately dropped here:
 *   * the account's own comments (from.id === entry.id) — otherwise a salon answering its own
 *     post with the keyword would trigger a private reply to itself;
 *   * anything without a comment id or text, which is nothing we can act on.
 */
export function parseIgCommentWebhook(payload: any): {
  igUserId: string | null;
  comments: IgCommentEvent[];
} {
  const comments: IgCommentEvent[] = [];
  let igUserId: string | null = null;
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    if (!igUserId && entry?.id) igUserId = String(entry.id);
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const ch of changes) {
      if (ch?.field !== "comments" && ch?.field !== "live_comments") continue;
      const v = ch?.value ?? {};
      const commentId = v?.id ? String(v.id) : null;
      if (!commentId) continue;
      const fromId = v?.from?.id ? String(v.from.id) : null;
      // The business commenting on its own post must never trigger anything.
      if (fromId && entry?.id && fromId === String(entry.id)) continue;
      const text = String(v?.text ?? "").trim();
      if (!text) continue;
      comments.push({
        commentId,
        fromId,
        fromUsername: v?.from?.username ? String(v.from.username) : null,
        text,
        mediaId: v?.media?.id ? String(v.media.id) : null,
        isReply: Boolean(v?.parent_id),
        timestampMs: v?.timestamp ? Number(v.timestamp) * 1000 : Date.now(),
      });
    }
  }
  return { igUserId, comments };
}

export type IgCommentTrigger = {
  id: string;
  keyword: string;
  match_mode: "exact" | "contains";
  media_id: string | null;
  reply_text: string;
  public_reply: string | null;
  ai_context: string | null;
  enabled: boolean;
};

/**
 * Strip everything that is not a letter, digit or space so "ЦЕНА!!! 🔥" matches the keyword
 * "цена". Emoji-heavy, punctuation-heavy comments are the norm under a promo post, and an
 * exact-match trigger that only fires on a bare word would look broken to the owner.
 */
export function normalizeCommentText(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the trigger that fires for this comment, or null.
 *
 * Ordering is what makes multi-campaign accounts behave: a trigger scoped to THIS post beats a
 * catch-all one, and an exact match beats a substring — so "цена" under a specific reel wins
 * over a global "цена", and a global "запись" doesn't swallow a post-specific "запись на брови".
 */
export function matchCommentTrigger(
  triggers: IgCommentTrigger[],
  comment: { text: string; mediaId: string | null },
): IgCommentTrigger | null {
  const norm = normalizeCommentText(comment.text);
  if (!norm) return null;
  const candidates = triggers.filter((t) => {
    if (!t.enabled) return false;
    if (t.media_id && t.media_id !== comment.mediaId) return false;
    const kw = normalizeCommentText(t.keyword);
    if (!kw) return false;
    return t.match_mode === "exact" ? norm === kw : norm.includes(kw);
  });
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const scoped = Number(Boolean(b.media_id)) - Number(Boolean(a.media_id));
    if (scoped !== 0) return scoped;
    const exact = Number(b.match_mode === "exact") - Number(a.match_mode === "exact");
    if (exact !== 0) return exact;
    // Longest keyword last-resort tiebreak: the more specific phrase wins.
    return b.keyword.length - a.keyword.length;
  })[0];
}

/** Meta refuses a private reply older than 7 days. Checking locally saves a guaranteed-failed call. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function commentWithinPrivateReplyWindow(timestampMs: number, nowMs = Date.now()): boolean {
  return nowMs - timestampMs < PRIVATE_REPLY_WINDOW_MS;
}
