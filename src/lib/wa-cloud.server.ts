// WhatsApp Cloud API transport for the AI admin — the official replacement for Green-API.
//
// WHY WE ARE MOVING OFF GREEN-API: Green-API attaches to WhatsApp as a "linked device" over the
// WhatsApp Web protocol. That is an unofficial client, and Meta revokes those sessions. The failure
// mode is not a clean error — the salon simply stops receiving webhooks while our logs stay empty,
// and the owner gets locked out of the app on her own number. A salon whose booking channel can
// vanish overnight is not a product we can sell.
//
// WHICH META API: WhatsApp Business Platform, Cloud API flavour (graph.facebook.com, hosted by
// Meta — no on-prem container). Sends go to /<PHONE_NUMBER_ID>/messages with a system-user access
// token; inbound arrives on the same per-salon webhook shape Instagram already uses.
//
// THE THREE THINGS THAT DIFFER FROM GREEN-API, and that the route must respect:
//
//   1. THE 24-HOUR WINDOW. Free-form text may only be sent within 24 h of the client's last
//      message. Outside it, Meta rejects the send with code 131047 and the ONLY legal way to
//      reach the client is a pre-approved template (see waCloudSendTemplate). This is why
//      booking confirmations and 2-hour reminders cannot stay plain text.
//
//   2. ECHOES EXIST, BUT ONLY UNDER COEXISTENCE, AND ON A DIFFERENT FIELD. A number registered on
//      the Cloud API normally stops working in the WhatsApp Business app, which would leave the
//      admin panel as the only place a human can take over. Onboarded through coexistence
//      (Embedded Signup for Business-app users) the number keeps working in BOTH, and every
//      message the owner types on their phone arrives as an `smb_message_echoes` change — NOT on
//      the `messages` field. That echo is the "a human took over" signal, and this file parses it
//      (parseWaCloudEchoes). Both onboarding modes are therefore supported: without coexistence
//      the field simply never fires and takeover happens through the panel.
//
//   3. MEDIA IS TWO STEPS. The webhook carries a media *id*, not a URL. Resolving it to bytes is
//      a Graph lookup followed by a download that must carry the access token — a plain fetch of
//      the resolved URL comes back as an HTML error page with HTTP 200.
//
// Everything here is transport only — no business logic. The webhook route owns the state machine.

// Graph API version. Meta keeps a version usable for ~2 years, so this is not urgent maintenance —
// but it IS the thing that silently changes behaviour under us, and pinning it in source means a
// bump requires a redeploy. Overridable by env so the version can be moved from the Cloudflare
// dashboard if Meta deprecates one on short notice.
//
// Read lazily rather than at module scope: this module is imported into a Cloudflare Worker, where
// module-level evaluation happens at build time and `process.env` is not yet populated.
function waGraphBase(): string {
  const version = process.env.WA_CLOUD_API_VERSION || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

// WhatsApp rejects a text body over 4096 characters. The assistant is prompted to answer short,
// but a price list can still run over, and a hard rejection means the client gets NOTHING — worse
// than two bubbles. Chunked below the limit to leave headroom.
export const WA_TEXT_LIMIT = 3900;

export type WaCloudCreds = {
  /** Phone number id from the Meta dashboard — NOT the phone number itself. Sends go to this id. */
  phoneNumberId: string;
  /** Permanent system-user access token with whatsapp_business_messaging. */
  token: string;
};

export type WaCloudSendResult = { ok: true; messageId?: string } | { ok: false; error: string };

/**
 * Split a reply into WhatsApp-sized chunks WITHOUT cutting mid-word.
 *
 * Same policy as the Instagram splitter: prefer paragraph breaks, then sentence ends, then any
 * whitespace, and only hard-cut as a last resort. Kept as its own function rather than imported
 * from ig-api.server.ts because the two limits differ by a factor of four and sharing one would
 * silently give WhatsApp Instagram's much smaller bubbles. Exported for tests.
 */
export function splitForWhatsApp(text: string, limit = WA_TEXT_LIMIT): string[] {
  const clean = (text ?? "").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // The cut goes AFTER the delimiter so a sentence keeps its full stop instead of the period
    // opening the next bubble. lastIndexOf only matches a delimiter fully inside the window, so
    // index + length can never exceed the limit.
    const candidates: Array<[index: number, length: number]> = [
      [window.lastIndexOf("\n\n"), 2],
      [window.lastIndexOf("\n"), 1],
      [window.lastIndexOf(". "), 2],
      [window.lastIndexOf("! "), 2],
      [window.lastIndexOf("? "), 2],
      [window.lastIndexOf(" "), 1],
    ];
    // Ignore a break point in the first half — splitting a 3900-character reply into 200 + 3700
    // is worse than a clean hard cut.
    const chosen = candidates.find(([i]) => i > limit * 0.5);
    const cut = chosen ? chosen[0] + chosen[1] : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * Normalise a phone to what the Cloud API expects: digits only, country code included, no '+',
 * no '@c.us'. Accepts the shapes already stored in our database — Green-API chat ids
 * ("996555123456@c.us"), pretty-printed numbers, and bare E.164.
 */
export function toWaCloudRecipient(phone: string): string {
  return (phone ?? "").replace(/@c\.us$/i, "").replace(/\D/g, "");
}

async function waCloudPost(
  creds: WaCloudCreds,
  body: unknown,
  path?: string,
): Promise<WaCloudSendResult> {
  if (!creds.phoneNumberId || !creds.token) {
    return { ok: false, error: "WhatsApp Cloud API не настроен (нет phone number id или токена)" };
  }
  try {
    const res = await fetch(`${waGraphBase()}/${path ?? `${creds.phoneNumberId}/messages`}`, {
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
      // Meta's code is carried through verbatim because the fix differs completely per code, and
      // these are the ones a salon will actually hit:
      //   131047 — outside the 24-hour window; needs a template, not a retry
      //   131026 — recipient cannot receive messages (not on WhatsApp, or blocked us)
      //   190    — access token expired or revoked
      //   132xxx — template missing / not approved / parameter mismatch
      const err = parsed?.error;
      return {
        ok: false,
        error: err
          ? `WA ${res.status} code=${err.code ?? "?"}${
              err.error_subcode ? `/${err.error_subcode}` : ""
            } ${err.message ?? ""}`.trim()
          : `WA ${res.status} ${raw.slice(0, 300)}`,
      };
    }
    return { ok: true, messageId: parsed?.messages?.[0]?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Send a free-form text reply. ONLY valid inside the 24-hour customer service window — i.e. as a
 * reply to something the client just sent. For anything business-initiated use
 * waCloudSendTemplate.
 *
 * Long replies go out as several ordered bubbles and the FIRST message id is reported (used for
 * outbound dedup bookkeeping). Note the sequential await: WhatsApp delivers in arrival order, so
 * firing the chunks in parallel would let bubble 2 land before bubble 1.
 */
export async function waCloudSendMessage(
  creds: WaCloudCreds,
  toPhone: string,
  text: string,
): Promise<WaCloudSendResult> {
  const to = toWaCloudRecipient(toPhone);
  if (!to) return { ok: false, error: "empty recipient" };
  const chunks = splitForWhatsApp(text);
  if (chunks.length === 0) return { ok: false, error: "empty text" };

  let first: WaCloudSendResult | null = null;
  for (const chunk of chunks) {
    const res = await waCloudPost(creds, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      // preview_url stays off: a link preview turns the booking link into a large card that
      // pushes the actual instructions off the client's screen.
      text: { body: chunk, preview_url: false },
    });
    if (!first) first = res;
    // Stop on the first failure — sending the tail of a reply whose head never arrived produces a
    // confusing half-message for the client.
    if (!res.ok) return res;
  }
  return first ?? { ok: false, error: "no chunks sent" };
}

/**
 * Send an image by public URL, with an optional caption.
 *
 * Unlike Instagram — which needs the caption as its own separate message — WhatsApp carries the
 * caption on the image itself, so the payment QR and its instructions arrive as one bubble.
 * Meta fetches the URL from its own servers, so it must be publicly reachable (our QR bucket),
 * not a signed URL that can expire mid-fetch.
 */
export async function waCloudSendImage(
  creds: WaCloudCreds,
  toPhone: string,
  imageUrl: string,
  caption?: string | null,
): Promise<WaCloudSendResult> {
  const to = toWaCloudRecipient(toPhone);
  if (!to) return { ok: false, error: "empty recipient" };
  return waCloudPost(creds, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: { link: imageUrl, ...(caption?.trim() ? { caption: caption.trim() } : {}) },
  });
}

/**
 * Business-initiated message: booking confirmations, reminders, anything sent outside the
 * 24-hour window. `templateName` must already be APPROVED in the salon's WABA — Meta rejects an
 * unknown or pending template rather than queueing it.
 *
 * `bodyParams` fill the {{1}}, {{2}}… placeholders IN ORDER. The count must match the approved
 * template exactly or Meta answers 132000.
 */
export async function waCloudSendTemplate(
  creds: WaCloudCreds,
  toPhone: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[] = [],
): Promise<WaCloudSendResult> {
  const to = toWaCloudRecipient(toPhone);
  if (!to) return { ok: false, error: "empty recipient" };
  return waCloudPost(creds, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length
        ? {
            components: [
              {
                type: "body",
                parameters: bodyParams.map((t) => ({ type: "text", text: t })),
              },
            ],
          }
        : {}),
    },
  });
}

/**
 * Mark the client's message read and show the typing indicator.
 *
 * Cosmetic but worth the one request: an agent turn takes several seconds (Gemini + tool loop)
 * and a thread with no blue ticks and no "typing…" reads as nobody being there. Meta ties the
 * typing indicator to the read receipt — both ride the same call, and it expires on its own after
 * ~25 s, so there is nothing to cancel afterwards.
 *
 * Failures are swallowed: never let a cosmetic call break a reply.
 */
export async function waCloudMarkReadAndTyping(
  creds: WaCloudCreds,
  messageId: string,
): Promise<void> {
  if (!messageId) return;
  try {
    await waCloudPost(creds, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch {
    /* cosmetic only */
  }
}

/**
 * Resolve an inbound media id to its bytes.
 *
 * Two steps, and the second one is where this goes wrong if written naively: Meta answers the
 * resolved CDN URL with an HTML error page — served with HTTP 200 — unless the download itself
 * carries the access token. That is how 147 KB of HTML once ended up in the Instagram media
 * bucket labelled as a client's photo, so the same lesson is applied here from the start: the
 * bearer token goes on the download, and the caller sniffs what actually arrived.
 */
export async function waCloudFetchMedia(
  creds: WaCloudCreds,
  mediaId: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!mediaId || !creds.token) return null;
  try {
    const metaRes = await fetch(`${waGraphBase()}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!metaRes.ok) return null;
    const meta: any = await metaRes.json();
    const url: string | undefined = meta?.url;
    if (!url) return null;

    const binRes = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!binRes.ok) return null;
    const ab = await binRes.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return {
      bytes: new Uint8Array(ab),
      mime: (meta?.mime_type as string) || binRes.headers.get("content-type") || "",
    };
  } catch {
    return null;
  }
}

/**
 * Verify X-Hub-Signature-256 over the RAW request body.
 *
 * The verify token only covers the GET handshake; Meta does not send it on POSTs. This signature
 * is therefore the only real authentication on the inbound message path, which is why the route
 * refuses to process a salon that has no app secret configured. The body must be the exact bytes
 * Meta sent — re-serialising a parsed object produces a different digest.
 *
 * Comparison is constant-time: an early-exit compare leaks the position of the first wrong byte.
 */
export async function waCloudVerifySignature(
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

export type WaCloudInboundEvent = {
  /** Client's phone in wa_id form (digits, country code, no '+'). Keys the conversation. */
  fromPhone: string;
  /** WhatsApp message id (wamid.…), used for webhook dedup — Meta redelivers on any non-200. */
  wamid: string | null;
  text: string | null;
  /** Media ids, NOT urls — resolve with waCloudFetchMedia. */
  imageMediaId: string | null;
  audioMediaId: string | null;
  /** WhatsApp profile name, when the client has one set. */
  profileName: string | null;
  /** Tap on an interactive button/list reply — carries the id we set when sending. */
  interactiveReplyId: string | null;
  timestampMs: number;
};

export type WaCloudStatusEvent = {
  wamid: string;
  /** sent | delivered | read | failed */
  status: string;
  recipientPhone: string | null;
  /** Present on failures — this is what tells the owner a template was rejected or a number is dead. */
  error: string | null;
  /** Meta's numeric error code, kept separate from the prose because the mapping branches on it. */
  errorCode: number | null;
};

/**
 * Flatten Meta's nested webhook envelope into the events we act on.
 *
 * Meta batches: one POST can carry several entries, each with several changes, and mixes message
 * deliveries with status receipts. Both are pulled out here so the route sees only real client
 * input in `events`, with delivery failures separated into `statuses` for error surfacing.
 */
export function parseWaCloudWebhook(payload: any): {
  phoneNumberId: string | null;
  events: WaCloudInboundEvent[];
  statuses: WaCloudStatusEvent[];
} {
  const events: WaCloudInboundEvent[] = [];
  const statuses: WaCloudStatusEvent[] = [];
  let phoneNumberId: string | null = null;

  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field && change.field !== "messages") continue;
      const value = change?.value;
      if (!value) continue;
      if (!phoneNumberId && value?.metadata?.phone_number_id) {
        phoneNumberId = String(value.metadata.phone_number_id);
      }

      // The display name arrives once per delivery in `contacts`, keyed by wa_id — not on the
      // message itself. Without this the admin panel shows every chat as a bare number.
      const namesByWaId = new Map<string, string>();
      for (const c of Array.isArray(value?.contacts) ? value.contacts : []) {
        const waId = c?.wa_id ? String(c.wa_id) : null;
        const name = c?.profile?.name;
        if (waId && name) namesByWaId.set(waId, String(name));
      }

      for (const msg of Array.isArray(value?.messages) ? value.messages : []) {
        const fromPhone = msg?.from ? String(msg.from) : null;
        if (!fromPhone) continue;

        // An interactive reply is a tap, not prose: its id is what we matched on when sending,
        // and its title is the human-readable label the client saw.
        const interactive = msg?.interactive;
        const interactiveReplyId =
          interactive?.button_reply?.id ?? interactive?.list_reply?.id ?? null;
        const interactiveTitle =
          interactive?.button_reply?.title ?? interactive?.list_reply?.title ?? null;

        const text =
          msg?.text?.body ?? msg?.image?.caption ?? msg?.button?.text ?? interactiveTitle ?? null;

        events.push({
          fromPhone,
          wamid: msg?.id ? String(msg.id) : null,
          text: text || null,
          imageMediaId: msg?.image?.id ? String(msg.image.id) : null,
          audioMediaId: msg?.audio?.id
            ? String(msg.audio.id)
            : msg?.voice?.id
              ? String(msg.voice.id)
              : null,
          profileName: namesByWaId.get(fromPhone) ?? null,
          interactiveReplyId: interactiveReplyId ? String(interactiveReplyId) : null,
          // Meta sends UNIX seconds; everything downstream works in milliseconds.
          timestampMs: Number(msg?.timestamp) ? Number(msg.timestamp) * 1000 : Date.now(),
        });
      }

      for (const st of Array.isArray(value?.statuses) ? value.statuses : []) {
        if (!st?.id) continue;
        const err = Array.isArray(st?.errors) ? st.errors[0] : null;
        statuses.push({
          wamid: String(st.id),
          status: String(st?.status ?? "unknown"),
          recipientPhone: st?.recipient_id ? String(st.recipient_id) : null,
          error: err
            ? `code=${err.code ?? "?"} ${err.title ?? ""} ${err.message ?? ""}`.trim()
            : null,
          errorCode: Number.isFinite(Number(err?.code)) ? Number(err.code) : null,
        });
      }
    }
  }

  return { phoneNumberId, events, statuses };
}

// ---------------------------------------------------------------------------
// Coexistence echoes — "a human answered from the phone"
// ---------------------------------------------------------------------------

export type WaCloudEchoEvent = {
  /** The CLIENT's phone (Meta's `to`). This is what keys the conversation — see the note below. */
  clientPhone: string;
  /** The salon's own business number (Meta's `from`). */
  businessPhone: string | null;
  /** wamid of the echoed message. The route matches it against our own outbound rows. */
  wamid: string | null;
  /** Body or caption, when the echoed type carries one. NULL for revoke/edit. */
  text: string | null;
  /** text | image | video | document | revoke | edit */
  type: string;
  timestampMs: number;
};

/**
 * Parse `smb_message_echoes` — messages the salon owner sent from the WhatsApp Business app while
 * the number is ALSO connected to the Cloud API (coexistence onboarding).
 *
 * This is the Cloud API's equivalent of Green-API's `outgoingMessageReceived`, and in this product
 * it exists for exactly one reason: it is how we learn a human has taken over, so the assistant
 * stops replying alongside them.
 *
 * THE FIELD MATTERS. These arrive as `changes[].field === "smb_message_echoes"`, not on the
 * `messages` field that carries client messages — which is why parseWaCloudWebhook skips them and
 * this is a separate function rather than another branch in there. A parser that looked only at
 * `messages` would never see a takeover at all.
 *
 * THE DIRECTION MATTERS MORE. On an echo the salon is the SENDER: `from` is the business number
 * and `to` is the client. Keying the conversation on `from` — the obvious reading of a message
 * envelope — would attach every takeover to a conversation named after the salon's own number
 * instead of the client's, so the pause would land on the wrong thread (or create a junk one)
 * while the real conversation kept getting bot replies. The Instagram echo parser had to avoid
 * this same trap.
 *
 * Meta documents these as firing only for Business-app sends, never for Cloud API sends. The route
 * does not take that on faith and still checks whether the wamid is one of ours: an echo of our own
 * reply misread as a takeover mutes the assistant for five minutes, which is precisely the
 * production incident the Instagram channel already suffered (see src/lib/ig-echo.ts).
 */
export function parseWaCloudEchoes(payload: any): {
  phoneNumberId: string | null;
  echoes: WaCloudEchoEvent[];
} {
  const echoes: WaCloudEchoEvent[] = [];
  let phoneNumberId: string | null = null;

  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "smb_message_echoes") continue;
      const value = change?.value;
      if (!value) continue;
      if (!phoneNumberId && value?.metadata?.phone_number_id) {
        phoneNumberId = String(value.metadata.phone_number_id);
      }

      for (const msg of Array.isArray(value?.message_echoes) ? value.message_echoes : []) {
        const clientPhone = msg?.to ? String(msg.to) : null;
        // Without a recipient there is no conversation to attach this to. Dropping is correct: the
        // alternative is inventing a conversation key and pausing an unrelated thread.
        if (!clientPhone) continue;

        // A caption is the closest thing to "what the owner said" for media, and it is what the
        // assistant is shown as handoff context on its next turn. revoke/edit carry no prose —
        // they still count as the owner being present, they just contribute no text.
        const text =
          msg?.text?.body ??
          msg?.image?.caption ??
          msg?.video?.caption ??
          msg?.document?.caption ??
          null;

        echoes.push({
          clientPhone,
          businessPhone: msg?.from ? String(msg.from) : null,
          wamid: msg?.id ? String(msg.id) : null,
          text: text || null,
          type: String(msg?.type ?? "unknown"),
          timestampMs: Number(msg?.timestamp) ? Number(msg.timestamp) * 1000 : Date.now(),
        });
      }
    }
  }

  return { phoneNumberId, echoes };
}

/**
 * Cloud API delivery `status` → what we store on the appointment.
 *
 * Mirrors mapGreenApiDeliveryStatus in the Green-API route, deliberately including its one
 * counter-intuitive rule: `sent` is IGNORED. The send path already wrote that when Meta accepted
 * the message, and re-writing it here would overwrite a later `delivered` whenever the webhooks
 * arrive out of order — which they do.
 *
 * 131026 is the one code an owner actually needs in words. It is the Cloud API's answer to «почему
 * запись создаётся с номером, которого нет в WhatsApp»: the number cannot receive messages at all.
 * Green-API answered that with `noAccount`, and losing it on migration would quietly remove a
 * diagnostic the calendar already shows.
 */
export function mapWaCloudDeliveryStatus(
  status: unknown,
  errorCode?: number | null,
): { status: "delivered" | "failed"; detail: string | null } | null {
  switch (status) {
    case "delivered":
    case "read":
      return { status: "delivered", detail: null };
    case "failed":
      if (errorCode === 131026) return { status: "failed", detail: "У этого номера нет WhatsApp" };
      if (errorCode === 131047) {
        return {
          status: "failed",
          detail: "Прошло больше 24 часов с последнего сообщения клиента — нужен шаблон",
        };
      }
      if (errorCode === 190)
        return { status: "failed", detail: "Токен WhatsApp истёк или отозван" };
      return {
        status: "failed",
        detail: errorCode
          ? `Meta отклонила отправку (код ${errorCode})`
          : "Сообщение не доставлено",
      };
    default:
      return null;
  }
}
