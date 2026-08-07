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
  /** true when the salon answered manually from the Instagram app — a human takeover. */
  isEcho: boolean;
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
        postbackPayload: postback?.payload ?? null,
        replyToStory: Boolean(msg?.reply_to?.story),
        timestampMs: Number(ev?.timestamp) || Date.now(),
      });
    }
  }

  return { igUserId, events };
}
