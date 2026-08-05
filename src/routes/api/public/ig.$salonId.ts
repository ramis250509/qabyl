// Instagram Direct webhook receiver: one URL per salon.
//
// GET  — Meta's subscription handshake (hub.challenge), authenticated by the per-salon verify token.
// POST — message events, authenticated by X-Hub-Signature-256 over the raw body (the verify token
//        is NOT sent on POSTs, so the app-secret signature is the only real auth on this path).
//
// The processing model is deliberately identical to the WhatsApp route
// (src/routes/api/public/wa.$salonId.ts): take a per-conversation advisory lock, drain every
// unprocessed inbound message inside that window, run one agent turn over the merged burst, send
// one reply, persist state. Both Meta and Green-API deliver in parallel and redeliver on any
// non-200, so any channel that skips this ends up double-replying and racing its own state writes.
//
// WHAT IS DIFFERENT FROM WHATSAPP, and why:
//   1. No phone number. Instagram gives an IGSID, never a phone, but appointments require one.
//      The conversation is therefore keyed on `ig:<IGSID>` and the assistant asks the client for
//      a real number during the booking (see the client_phone gate in wa-agent-v4.server.ts).
//      Once given, it lives in state_data.client_phone and is fed back in on every later turn.
//   2. V4 only. V3 answers with WhatsApp interactive buttons/lists, which have no Instagram
//      equivalent — pinning V4 avoids shipping a channel where half the UI silently degrades.
//   3. No 24-hour-window bookkeeping. Meta's standard messaging window is 24 h from the client's
//      last message; every reply we send here is a direct response to a message that JUST arrived,
//      so we are inside the window by construction.
import { createFileRoute } from "@tanstack/react-router";
import {
  igFetchProfile,
  igSendMessage,
  igSendTypingOn,
  igVerifySignature,
  parseIgWebhook,
  type IgCreds,
  type IgInboundEvent,
} from "@/lib/ig-api.server";
import {
  acquireConversationLock,
  LOCK_HEARTBEAT_MS,
  refreshConversationLock,
  releaseConversationLock,
  stillHoldingConversationLock,
} from "@/lib/chat-lock.server";
import { runWaAgentV4 } from "@/lib/wa-agent-v4.server";
import {
  greenApiSendMessage,
  normalizeChatIdToPhone,
  renderInteractiveAsText,
  transcribeAudio,
  type WaAgentInput,
  type WaAgentState,
  type WaBranchInfo,
  type WaIncomingMessage,
} from "@/lib/wa-agent.server";

const MAX_LOOP_ITERATIONS = 3;
// See the WhatsApp route for the reasoning behind these two: clients type a thought in several
// short bubbles, and answering the half-typed first one produces a reply the assistant then has to
// correct. Waiting once for the burst to settle turns 2–3 replies into one coherent answer.
const COALESCE_WINDOW_MS = 1500;
const COALESCE_WAIT_MS = 3000;
// Inbound cap per conversation per minute. Protects Gemini spend from a runaway client or a flood.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
// How long the assistant stays quiet after salon staff answer manually from the Instagram app.
const AI_PAUSE_MS = 5 * 60 * 1000;
// Inbound older than this is drained silently instead of answered — a backlog that piled up while
// the integration was off must not look like the bot resurrecting a days-old conversation.
const STALE_MESSAGE_MS = 12 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Conversation key for an Instagram user. See the migration for why this shape. */
function igConversationPhone(igsid: string): string {
  return `ig:${igsid}`;
}

export const Route = createFileRoute("/api/public/ig/$salonId")({
  server: {
    handlers: {
      // ---- Meta subscription handshake.
      // Meta calls this once when the salon (or we) subscribe the webhook, and occasionally to
      // re-validate. Echoing hub.challenge in plain text is the entire protocol; the only thing
      // that must be checked is that hub.verify_token matches what this salon stored.
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode !== "subscribe") return new Response("ok", { status: 200 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: secrets } = await supabaseAdmin
          .from("salon_secrets")
          .select("instagram_verify_token")
          .eq("salon_id", params.salonId)
          .maybeSingle();
        const expected = (secrets as any)?.instagram_verify_token ?? "";
        if (!expected || !safeStringEquals(expected, token)) {
          console.error(`[ig] verify handshake rejected for salon=${params.salonId}`);
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      },

      POST: async ({ request, params }) => {
        const salonId = params.salonId;
        const rid = Math.random().toString(36).slice(2, 8);
        const log = (msg: string, ...rest: unknown[]) => console.log(`[ig ${rid}] ${msg}`, ...rest);
        const errLog = (msg: string, ...rest: unknown[]) =>
          console.error(`[ig ${rid}] ${msg}`, ...rest);
        const t0 = Date.now();
        const ms = () => Date.now() - t0;

        // Always 200 back to Meta once we have accepted responsibility for a payload. A non-200
        // makes Meta redeliver the same batch for up to 36 h, and after enough failures it
        // unsubscribes the app from the field entirely — far worse than dropping one message.
        const ack = () => new Response("ok", { status: 200 });

        // Raw text, not request.json(): the signature is computed over the exact bytes Meta sent,
        // so re-serialising a parsed object would produce a different digest.
        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const [{ data: secrets }, { data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin
            .from("salon_secrets")
            .select(
              "instagram_user_id, instagram_token, instagram_app_secret, greenapi_instance, greenapi_token, owner_notify_phone",
            )
            .eq("salon_id", salonId)
            .maybeSingle(),
          supabaseAdmin
            .from("salons")
            .select(
              "id, name, timezone, ai_assistant_enabled, instagram_enabled, working_hours, address",
            )
            .eq("id", salonId)
            .maybeSingle(),
          supabaseAdmin
            .from("salon_ai_assistant")
            .select(
              "enabled, greeting, tone_instructions, pricing_rules, languages, manage_cutoff_hours, knowledge_base, ai_rules, client_addressing, industry, knowledge_answers, sales_mode, assistant_branch_id",
            )
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        // Every reason we refuse or ignore a delivery is recorded, not just console-logged.
        // Debugging "the assistant did not answer" hinges on one question — did Meta reach us at
        // all? — and a Cloudflare log line the salon owner cannot read does not answer it. These
        // rows show up in /admin/errors and drive the diagnostics panel in the Instagram tab.
        const record = async (message: string, context: Record<string, unknown> = {}) => {
          const { logError } = await import("@/lib/error-log.server");
          await logError({
            source: "ig-webhook",
            level: "warn",
            message,
            salonId,
            context: { rid, ...context },
          });
        };

        const appSecret = (secrets as any)?.instagram_app_secret ?? "";
        // No app secret means this endpoint has no authentication at all — the URL contains only a
        // salon id, which is not a secret. Refuse rather than process attacker-supplied "client
        // messages" that would drive the assistant and burn the salon's Gemini budget.
        if (!appSecret) {
          await record("Webhook отклонён: App Secret не заполнен в настройках салона");
          return new Response("Forbidden", { status: 403 });
        }
        const signature =
          request.headers.get("x-hub-signature-256") ?? request.headers.get("X-Hub-Signature-256");
        if (!(await igVerifySignature(appSecret, rawBody, signature))) {
          await record("Webhook отклонён: неверная подпись X-Hub-Signature-256", {
            hasSignatureHeader: Boolean(signature),
          });
          return new Response("Forbidden", { status: 403 });
        }

        if (!salon) return ack();

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (payload?.object && payload.object !== "instagram") return ack();

        const { igUserId, events } = parseIgWebhook(payload);
        if (events.length === 0) return ack();

        // One Instagram account legitimately has TWO ids, and they are not interchangeable:
        //   17841…  the professional account id shown in the Meta dashboard, and what Meta puts in
        //           entry[].id on the webhook
        //   285…    the app-scoped id that graph.instagram.com/me returns for the same account
        // An owner copying from the dashboard stores the first; our own connection check stores the
        // second. Both are correct, so comparing them and DROPPING the delivery on a mismatch
        // silently threw away every message — looking, from the outside, exactly like Meta never
        // calling at all. The mismatch is recorded but no longer blocks anything.
        //
        // Nothing is lost security-wise: the delivery is already authenticated by the per-salon
        // app-secret signature above, and the salon is identified by the URL path. This check could
        // only ever catch a mis-pasted webhook URL between two salons sharing one Meta app — and
        // even then, dropping is the wrong response to what is a configuration slip.
        const configuredIgUser = (secrets as any)?.instagram_user_id ?? "";
        if (configuredIgUser && igUserId && configuredIgUser !== igUserId) {
          await record(
            `Webhook пришёл для Instagram-аккаунта ${igUserId}, а в настройках указан ${configuredIgUser}. Сообщение обработано, но стоит проверить поле «Instagram account ID».`,
            { received: igUserId, configured: configuredIgUser },
          );
        }

        const creds: IgCreds = {
          token: (secrets as any)?.instagram_token ?? "",
          // Prefer the id Meta itself used in this delivery over the one typed into the settings:
          // when they differ (see the two-ids note above) Meta's own value is the one its API
          // expects on the send endpoint.
          igUserId: igUserId || configuredIgUser,
        };

        // Ingest EVERY event first (so the admin panel and the audit log stay complete even when
        // the assistant is off or paused), then run at most one agent turn per conversation.
        const conversationsToProcess = new Set<string>();
        for (const ev of events) {
          const convId = await ingestEvent({
            db: supabaseAdmin,
            salonId,
            ev,
            creds,
            errLog,
          });
          if (convId) conversationsToProcess.add(convId);
        }

        const assistantOn =
          ((salon as any).instagram_enabled ?? false) === true &&
          ((salon as any).ai_assistant_enabled ?? true) !== false &&
          ((assistant as any)?.enabled ?? true) !== false;
        // A message arrived and we are deliberately staying silent. Legitimate, but from the
        // outside identical to a bug — so name the exact switch that is off. Four different
        // toggles can produce this, they live on three different screens, and "the assistant is
        // not answering" sends the owner hunting through all of them.
        if (!assistantOn || !creds.token) {
          const off = !((salon as any).instagram_enabled ?? false)
            ? "канал Instagram выключен — включите переключатель вверху вкладки «Instagram»"
            : !((salon as any).ai_assistant_enabled ?? true)
              ? "ИИ-ассистент не подключён для этого салона — включается владельцем платформы"
              : !((assistant as any)?.enabled ?? true)
                ? "ассистент выключен — включите переключатель «Активен» во вкладке «Ассистент» и сохраните"
                : "не заполнен Access Token во вкладке «Instagram»";
          await record(`Сообщение получено, но ответа не будет: ${off}`, {
            instagram_enabled: (salon as any).instagram_enabled ?? false,
            ai_assistant_enabled: (salon as any).ai_assistant_enabled ?? true,
            assistant_enabled: (assistant as any)?.enabled ?? true,
            hasToken: Boolean(creds.token),
          });
          return ack();
        }
        if (conversationsToProcess.size === 0) return ack();

        const assistantConfig = {
          greeting: (assistant as any)?.greeting ?? null,
          tone_instructions: (assistant as any)?.tone_instructions ?? null,
          pricing_rules: (assistant as any)?.pricing_rules ?? null,
          languages: (assistant as any)?.languages?.length ? (assistant as any).languages : ["ru"],
          manage_cutoff_hours: (assistant as any)?.manage_cutoff_hours ?? 0,
          knowledge_base: (assistant as any)?.knowledge_base ?? null,
          ai_rules: (assistant as any)?.ai_rules ?? null,
          client_addressing: (assistant as any)?.client_addressing ?? null,
          industry: (assistant as any)?.industry ?? null,
          knowledge_answers: (assistant as any)?.knowledge_answers ?? null,
          sales_mode: (assistant as any)?.sales_mode ?? false,
        };

        for (const convId of conversationsToProcess) {
          try {
            await runConversationTurn({
              db: supabaseAdmin,
              salonId,
              salon,
              assistant,
              assistantConfig,
              secrets,
              creds,
              convId,
              log,
              errLog,
              record,
              ms,
            });
          } catch (e: any) {
            // Anything that escapes the turn leaves the client staring at silence, so it must be
            // recorded and not merely logged — this catch used to be the last blind spot on the
            // path between "message received" and "reply sent".
            await record(`Не удалось обработать сообщение: ${e?.message ?? e}`, { convId });
          }
        }

        return ack();
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Ingestion: webhook event → conversation + stored message
// ---------------------------------------------------------------------------

/**
 * Persist one webhook event. Returns the conversation id when an agent turn should follow,
 * or null when the event was handled without needing the assistant (echo, duplicate, rate-limited,
 * excluded contact, human takeover in progress).
 */
async function ingestEvent(opts: {
  db: any;
  salonId: string;
  ev: IgInboundEvent;
  creds: IgCreds;
  errLog: (m: string, ...r: unknown[]) => void;
}): Promise<string | null> {
  const { db, salonId, ev, creds, errLog } = opts;
  const convPhone = igConversationPhone(ev.clientId);
  const nowIso = new Date().toISOString();

  // Salon staff / personal accounts the owner never wants the assistant to answer.
  const { data: excluded } = await db
    .from("excluded_contacts")
    .select("id")
    .eq("salon_id", salonId)
    .eq("phone", convPhone)
    .maybeSingle();
  if (excluded) return null;

  const [{ data: existingConv }, { data: dup }] = await Promise.all([
    db
      .from("wa_conversations")
      .select(
        "id, status, session_started_at, last_message_at, state, state_data, ai_paused, ai_paused_at, client_name",
      )
      .eq("salon_id", salonId)
      .eq("client_phone", convPhone)
      .maybeSingle(),
    ev.mid
      ? db
          .from("wa_messages")
          .select("id")
          .eq("salon_id", salonId)
          .eq("green_api_message_id", ev.mid)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (dup) return null; // Meta redelivery — already stored and answered

  // ---- Salon answered manually from the Instagram app. Meta echoes that back to us; treat it
  // exactly like a WhatsApp manual takeover — pause the assistant so two "administrators" are
  // never typing at the same client at once.
  if (ev.isEcho) {
    if (!existingConv) return null;
    await db
      .from("wa_conversations")
      .update({ ai_paused: true, ai_paused_at: nowIso })
      .eq("id", existingConv.id);
    await db.from("wa_messages").insert({
      conversation_id: existingConv.id,
      salon_id: salonId,
      direction: "out",
      kind: "system",
      text_body: ev.text,
      green_api_message_id: ev.mid,
    });
    return null;
  }

  // ---- Rate limit. Only probe when messages are arriving back-to-back: at conversational pace a
  // flood is impossible, and skipping the COUNT saves a round-trip on virtually every real message.
  const prevMsgAtMs = existingConv?.last_message_at
    ? new Date(existingConv.last_message_at).getTime()
    : 0;
  if (existingConv?.id && prevMsgAtMs > 0 && Date.now() - prevMsgAtMs < 4000) {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { count } = await db
      .from("wa_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", existingConv.id)
      .eq("direction", "in")
      .gte("created_at", since);
    if ((count ?? 0) >= RATE_LIMIT_MAX) {
      errLog(`rate limit tripped: conv=${existingConv.id} inbound=${count}`);
      return null;
    }
  }

  // A conversation that has been idle long enough starts fresh (new greeting, clean state), unless
  // the client is mid-booking — losing a half-finished booking to a lunch break is worse than an
  // extra-long session. Same policy as WhatsApp.
  const previousState = (existingConv?.state ?? "idle") as string;
  const inProgress = previousState !== "idle" && previousState !== "done";
  const sessionGapMs = inProgress ? 12 * 60 * 60 * 1000 : 20 * 60 * 1000;
  const startsNewSession = !existingConv || (prevMsgAtMs > 0 && Date.now() - prevMsgAtMs > sessionGapMs);

  // Instagram gives us an opaque IGSID; without a profile lookup every chat in the admin panel
  // would read as a bare number. Only worth the request once, on the first message.
  let clientName: string | null = existingConv?.client_name ?? null;
  if (!clientName && creds.token) {
    const profile = await igFetchProfile(creds, ev.clientId);
    // Strip newlines and cap the length: the display name is attacker-controlled text that ends up
    // in the assistant's prompt, and "Ignore previous instructions…" as a username is free to set.
    const raw = profile?.name || profile?.username || null;
    clientName = raw ? raw.replace(/[\n\r]/g, " ").slice(0, 60) : null;
  }

  const { data: conv, error: convErr } = await db
    .from("wa_conversations")
    .upsert(
      {
        salon_id: salonId,
        client_phone: convPhone,
        channel: "instagram",
        external_id: ev.clientId,
        client_name: clientName,
        last_message_at: nowIso,
        last_message_preview: (ev.text ?? "[фото]").slice(0, 200),
        ...(startsNewSession
          ? {
              status: "active",
              appointment_id: null,
              selected_branch_id: null,
              session_started_at: nowIso,
              state: "idle",
              // Deliberately keeps NOTHING from the previous session except the phone: a returning
              // client should not have to hand over their number a second time.
              state_data: (existingConv?.state_data as any)?.client_phone
                ? { client_phone: (existingConv!.state_data as any).client_phone }
                : {},
            }
          : {}),
      },
      { onConflict: "salon_id,client_phone" },
    )
    .select("id, ai_paused, ai_paused_at")
    .single();

  if (convErr || !conv) {
    errLog("conversation upsert failed", convErr?.message ?? convErr);
    return null;
  }
  const convId = conv.id as string;

  // ---- Media. Instagram attachment URLs are short-lived CDN links, so the bytes are copied into
  // our own private bucket immediately — otherwise a retry (or the admin opening the chat an hour
  // later) finds a dead link.
  let mediaPath: string | null = null;
  if (ev.imageUrl) {
    mediaPath = await storeRemoteImage({ db, salonId, convId, url: ev.imageUrl, errLog });
  }

  // ---- Voice note → text. Transcribed with the same Gemini helper the WhatsApp path uses, so a
  // voice message behaves like any other message from here on (history, agent, admin panel).
  let textBody = ev.text;
  if (!textBody && ev.audioUrl) {
    const audio = await fetchAsBase64(ev.audioUrl, MAX_AUDIO_BYTES);
    const tr = audio
      ? await transcribeAudio({
          apiKey: process.env.GEMINI_API_KEY ?? "",
          audioBase64: audio.base64,
          mime: audio.mime,
        })
      : ({ ok: false, error: "audio download failed" } as const);
    if (tr.ok && tr.text) {
      textBody = tr.text;
    } else {
      errLog(`voice transcription failed: ${(tr as any).error}`);
      // Stored as already-processed so the agent never picks up an empty message, and the admin
      // still sees that something arrived.
      await db.from("wa_messages").insert({
        conversation_id: convId,
        salon_id: salonId,
        direction: "in",
        kind: "text",
        text_body: null,
        green_api_message_id: ev.mid,
        processed_at: new Date().toISOString(),
        meta: { voice: true, transcription_failed: true },
      });
      if (creds.token) {
        await igSendMessage(
          creds,
          ev.clientId,
          "Извините, не получилось разобрать голосовое сообщение 🙏 Напишите, пожалуйста, текстом.",
        );
      }
      return null;
    }
  }

  // A postback (icebreaker / quick-reply tap) carries its payload, not prose. Feeding the raw
  // payload to the model is noise; its title is already in ev.text.
  if (!textBody && !mediaPath && ev.postbackPayload) textBody = ev.postbackPayload;
  if (!textBody && !mediaPath) return null; // reaction, unsupported attachment — nothing to answer

  await db.from("wa_messages").insert({
    conversation_id: convId,
    salon_id: salonId,
    direction: "in",
    kind: mediaPath ? "image" : "text",
    text_body: textBody,
    media_path: mediaPath,
    green_api_message_id: ev.mid,
    ...(ev.replyToStory ? { meta: { reply_to_story: true } } : {}),
  });

  // ---- Human is handling this chat right now: store the message (done above) but stay quiet.
  // When the pause lapses the message is still pending and gets picked up normally.
  const pausedAtMs = conv.ai_paused_at ? new Date(conv.ai_paused_at).getTime() : 0;
  if (conv.ai_paused && pausedAtMs > 0 && Date.now() - pausedAtMs < AI_PAUSE_MS) return null;
  if (conv.ai_paused) {
    await db
      .from("wa_conversations")
      .update({ ai_paused: false, ai_paused_at: null })
      .eq("id", convId);
  }

  return convId;
}

async function fetchAsBase64(
  url: string,
  maxBytes: number,
): Promise<{ base64: string; mime: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return {
      base64: Buffer.from(ab).toString("base64"),
      mime: r.headers.get("content-type") ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

async function storeRemoteImage(opts: {
  db: any;
  salonId: string;
  convId: string;
  url: string;
  errLog: (m: string, ...r: unknown[]) => void;
}): Promise<string | null> {
  const { db, salonId, convId, url, errLog } = opts;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      errLog(`media fetch HTTP ${r.status}`);
      return null;
    }
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_MEDIA_BYTES) {
      errLog(`media too large (${ab.byteLength} bytes) — rejected`);
      return null;
    }
    const mime = r.headers.get("content-type") ?? "image/jpeg";
    const ext = (mime.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const path = `${salonId}/${convId}/${Date.now()}.${ext}`;
    const { error } = await db.storage
      .from("wa-media")
      .upload(path, new Uint8Array(ab), { contentType: mime, upsert: false });
    if (error) {
      errLog("media upload failed", error.message);
      return null;
    }
    return path;
  } catch (e: any) {
    errLog("media download failed", e?.message ?? e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// One locked agent turn over a conversation
// ---------------------------------------------------------------------------

async function runConversationTurn(opts: {
  db: any;
  salonId: string;
  salon: any;
  assistant: any;
  assistantConfig: any;
  secrets: any;
  creds: IgCreds;
  convId: string;
  log: (m: string, ...r: unknown[]) => void;
  errLog: (m: string, ...r: unknown[]) => void;
  record: (message: string, context?: Record<string, unknown>) => Promise<void>;
  ms: () => number;
}): Promise<void> {
  const {
    db,
    salonId,
    salon,
    assistant,
    assistantConfig,
    secrets,
    creds,
    convId,
    log,
    errLog,
    record,
    ms,
  } = opts;

  const lockId = crypto.randomUUID();
  if (!(await acquireConversationLock(db, convId, lockId))) {
    // Another worker owns this conversation; our message is queued (processed_at IS NULL) and
    // that worker will drain it.
    return;
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    const [{ data: conv }, { data: branchRows }] = await Promise.all([
      db
        .from("wa_conversations")
        .select(
          "id, client_name, external_id, session_started_at, state, state_data, selected_branch_id",
        )
        .eq("id", convId)
        .maybeSingle(),
      db
        .from("branches")
        .select("id, name, address")
        .eq("salon_id", salonId)
        .eq("is_active", true)
        .order("sort_order"),
    ]);
    if (!conv) return;

    const recipientId = conv.external_id as string;
    if (!recipientId) {
      await record("У диалога нет Instagram-идентификатора получателя — ответить невозможно", {
        convId,
      });
      return;
    }

    let branches: WaBranchInfo[] = (branchRows ?? []).map((b: any) => ({
      id: b.id,
      name: b.name,
      address: b.address ?? null,
    }));
    let selectedBranchId: string | null = conv.selected_branch_id ?? null;
    // Super-admin pinned the assistant to one branch — same choke point as the WhatsApp route:
    // replacing the branch list makes every other branch's masters, slots and appointments
    // unreachable without touching the engine.
    const pinnedBranchId = (assistant as any)?.assistant_branch_id as string | null | undefined;
    if (pinnedBranchId) {
      const pinned = branches.find((b) => b.id === pinnedBranchId);
      if (pinned) {
        branches = [pinned];
        selectedBranchId = pinned.id;
      }
    }

    const sessionStartedAt = (conv.session_started_at ?? new Date().toISOString()) as string;
    let state: WaAgentState = (conv.state ?? "idle") as WaAgentState;
    let stateData: any = conv.state_data ?? {};
    let lastSentReply: string | null = null;
    let settledThisPass = false;

    heartbeat = setInterval(() => {
      refreshConversationLock(db, convId, lockId).catch((e) =>
        errLog("heartbeat refresh failed", e?.message ?? e),
      );
    }, LOCK_HEARTBEAT_MS);

    for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
      const { data: pending } = await db
        .from("wa_messages")
        .select("id, direction, kind, text_body, media_path, created_at, meta")
        .eq("conversation_id", convId)
        .eq("direction", "in")
        .is("processed_at", null)
        .gte("created_at", sessionStartedAt)
        .order("created_at", { ascending: true })
        .limit(10);
      if (!pending || pending.length === 0) break;

      const staleCutoff = Date.now() - STALE_MESSAGE_MS;
      const stale = pending.filter((m: any) => new Date(m.created_at).getTime() < staleCutoff);
      const fresh = pending.filter((m: any) => new Date(m.created_at).getTime() >= staleCutoff);
      if (stale.length > 0) {
        await db
          .from("wa_messages")
          .update({ processed_at: new Date().toISOString() })
          .in("id", stale.map((m: any) => m.id));
      }
      if (fresh.length === 0) continue;

      // Wait once for a burst to finish, then answer the whole thing with one reply.
      if (!settledThisPass) {
        const newestMs = Math.max(...fresh.map((m: any) => new Date(m.created_at).getTime()));
        if (Date.now() - newestMs < COALESCE_WINDOW_MS) {
          settledThisPass = true;
          await new Promise((r) => setTimeout(r, COALESCE_WAIT_MS));
          continue;
        }
      }

      // The turn takes seconds (Gemini + tool loop); show the client something is happening.
      void igSendTypingOn(creds, recipientId);

      const lastMessages: WaIncomingMessage[] = await Promise.all(
        fresh.map(async (m: any) => {
          let signed: string | null = null;
          if (m.kind === "image" && m.media_path) {
            const { data: s } = await db.storage
              .from("wa-media")
              .createSignedUrl(m.media_path, 600);
            signed = s?.signedUrl ?? null;
          }
          return {
            id: m.id,
            direction: "in",
            kind: m.kind,
            text_body: m.text_body,
            media_signed_url: signed,
            media_path: m.media_path,
            created_at: m.created_at,
            selected_id: null,
          } as WaIncomingMessage;
        }),
      );

      // V4 keeps its own transcript in state_data.v4_history, so the only extra context it needs is
      // what a live admin said during a takeover — otherwise the assistant resumes and contradicts
      // the human.
      const { data: adminMsgs } = await db
        .from("wa_messages")
        .select("text_body")
        .eq("conversation_id", convId)
        .eq("direction", "out")
        .eq("kind", "system")
        .gte("created_at", sessionStartedAt)
        .not("text_body", "is", null)
        .order("created_at", { ascending: false })
        .limit(5);
      const handoffContext = ((adminMsgs ?? []) as any[])
        .map((m) => (m.text_body ?? "").trim())
        .filter(Boolean)
        .reverse();

      const input: WaAgentInput = {
        salon: {
          salonId,
          salonName: salon.name,
          timezone: salon.timezone ?? "UTC",
        },
        config: assistantConfig,
        channel: "instagram",
        // Empty until the client gives us a number (see the client_phone gate in the agent).
        client: { phone: stateData?.client_phone ?? "", name: conv.client_name ?? null },
        history: [],
        lastMessages,
        branches,
        selectedBranchId,
        state,
        stateData,
        salonInfo: {
          working_hours: salon.working_hours ?? null,
          address: salon.address ?? null,
        },
        ...(handoffContext.length ? { handoffContext } : {}),
      };

      const tPreAgent = ms();
      let result;
      try {
        result = await runWaAgentV4(input);
      } catch (e: any) {
        errLog(`runWaAgentV4 threw: ${e?.message ?? e}`);
        const { logError } = await import("@/lib/error-log.server");
        await logError({
          source: "ig-webhook",
          message: `runWaAgentV4 threw: ${e?.message ?? String(e)}`,
          error: e,
          salonId,
          context: { convId, recipientId },
        });
        const reply = "Извините, не получилось обработать запрос. Попробуйте, пожалуйста, ещё раз.";
        const sent = await igSendMessage(creds, recipientId, reply);
        await db.from("wa_messages").insert({
          conversation_id: convId,
          salon_id: salonId,
          direction: "out",
          kind: "text",
          text_body: reply,
          green_api_message_id: sent.ok ? (sent.messageId ?? null) : null,
          meta: { fatalError: e?.message ?? String(e) },
        });
        await db
          .from("wa_messages")
          .update({ processed_at: new Date().toISOString() })
          .in("id", fresh.map((m: any) => m.id));
        await db
          .from("wa_conversations")
          .update({ state: "idle", state_data: {} })
          .eq("id", convId);
        break;
      }

      // Last-line check before ANY visible side effect: if the lock lapsed mid-turn and another
      // worker took over, its turn is authoritative and ours must be dropped — otherwise the
      // client gets the same answer twice in two different wordings.
      if (!(await stillHoldingConversationLock(db, convId, lockId))) {
        errLog(`lock lost mid-turn (conv=${convId}) — dropping reply to avoid a double message`);
        break;
      }

      // Instagram has no interactive buttons/lists, so an engine-produced interactive message is
      // flattened into the numbered-text form the WhatsApp path already uses as its fallback.
      const im = result.interactiveMessage;
      const sentText = im
        ? renderInteractiveAsText(
            result.reply,
            im,
            ((result.nextStateData as any)?.language as "ru" | "ky" | "en") ?? "ru",
          )
        : result.reply;

      const isDuplicateReply = sentText.trim() === (lastSentReply ?? "").trim();
      let sentMessageId: string | undefined;
      const tAgentDone = ms();
      if (!isDuplicateReply) {
        const res = await igSendMessage(creds, recipientId, sentText);
        if (!res.ok) {
          // THE failure that matters: the assistant did its work and Instagram refused to deliver
          // it. Meta's own code and wording are carried through verbatim — code 190 means the
          // 60-day token expired or was revoked, code 10/200 means the permission is missing —
          // because the fix is completely different in each case.
          await record(`Instagram отклонил отправку ответа: ${res.error}`, { convId });
        }
        sentMessageId = res.ok ? res.messageId : undefined;
        lastSentReply = sentText;
      }
      log(
        `TIMING preAgent=${tPreAgent}ms agent=${tAgentDone - tPreAgent}ms send=${ms() - tAgentDone}ms total=${ms()}ms actions=${(result.debug.actions || []).join(",")}`,
      );

      await db.from("wa_messages").insert({
        conversation_id: convId,
        salon_id: salonId,
        direction: "out",
        kind: "text",
        text_body: sentText,
        green_api_message_id: sentMessageId ?? null,
        meta: {
          intent: result.debug.intent ?? null,
          actions: result.debug.actions,
          errors: result.debug.errors,
          state: result.nextState,
          duplicateSuppressed: isDuplicateReply || undefined,
        },
      });

      // Escalation: alert the salon, and pause the assistant so a human can step in. De-duplicated
      // over 4 h so a client who keeps writing can't spam the owner with the same alert.
      if (result.notifyAdminText) {
        const lastEscalatedAt = (stateData as any)?.last_escalated_at as string | undefined;
        const recentlyAlerted =
          lastEscalatedAt && Date.now() - new Date(lastEscalatedAt).getTime() < 4 * 60 * 60 * 1000;
        if (!recentlyAlerted) {
          await notifyOwnerIg({
            db,
            salonId,
            secrets,
            text: result.notifyAdminText,
          });
          (result.nextStateData as any) = {
            ...(result.nextStateData ?? {}),
            last_escalated_at: new Date().toISOString(),
          };
        }
      }

      await db
        .from("wa_messages")
        .update({ processed_at: new Date().toISOString() })
        .in("id", fresh.map((m: any) => m.id));

      const updates: Record<string, any> = {
        last_message_at: new Date().toISOString(),
        last_message_preview: result.reply.slice(0, 200),
        state: result.nextState,
        state_data: result.nextStateData ?? {},
      };
      if ((result.nextStateData as any)?.needs_human) {
        updates.ai_paused = true;
        updates.ai_paused_at = new Date().toISOString();
      }
      if (result.appointmentId) {
        updates.status = "booked";
        updates.appointment_id = result.appointmentId;
        updates.last_appointment_at = new Date().toISOString();
      }
      if (result.selectedBranchId !== selectedBranchId) {
        updates.selected_branch_id = result.selectedBranchId;
      }
      await db.from("wa_conversations").update(updates).eq("id", convId);

      state = result.nextState;
      stateData = result.nextStateData ?? {};
      selectedBranchId = result.selectedBranchId;
    }
  } finally {
    if (heartbeat) {
      try {
        clearInterval(heartbeat);
      } catch {
        /* nothing to do */
      }
    }
    await releaseConversationLock(db, convId, lockId);
  }
}

/**
 * Tell the salon a client needs a human.
 *
 * The owner's alert channel is WhatsApp (owner_notify_phone) — an Instagram escalation still goes
 * there, because that is where the owner already watches for alerts. When WhatsApp is not
 * configured or the send fails, the alert is written to the notifications table instead, so an
 * escalation is never lost silently. This is the same fallback policy as the WhatsApp route.
 */
async function notifyOwnerIg(opts: {
  db: any;
  salonId: string;
  secrets: any;
  text: string;
}): Promise<void> {
  const { db, salonId, secrets, text } = opts;
  const persistFallback = async (why: string) => {
    try {
      await db.from("notifications").insert({
        salon_id: salonId,
        type: "ig.escalation",
        title: "Клиенту в Instagram нужен администратор",
        body: `${text}\n\n[WhatsApp не доставлен: ${why}]`.slice(0, 2000),
      });
    } catch (e: any) {
      console.error(`[ig] notifyOwner fallback insert failed: ${e?.message ?? e}`);
    }
  };

  const ownerPhone = secrets?.owner_notify_phone
    ? normalizeChatIdToPhone(secrets.owner_notify_phone)
    : "";
  if (!ownerPhone || !secrets?.greenapi_instance || !secrets?.greenapi_token) {
    await persistFallback("WhatsApp-канал салона не настроен");
    return;
  }
  const res = await greenApiSendMessage(
    { instance: secrets.greenapi_instance, token: secrets.greenapi_token },
    `${ownerPhone}@c.us`,
    text,
  );
  if (!res.ok) {
    console.error(`[ig] notifyOwner → ${ownerPhone} failed: ${res.error}`);
    await persistFallback(res.error ?? "неизвестная ошибка Green-API");
  }
}

/**
 * Constant-time string comparison for the verify-token handshake. An early-exit compare leaks the
 * position of the first mismatched byte through response timing; Cloudflare Workers have no
 * timingSafeEqual, so this folds the length difference into the accumulator and never breaks early.
 */
export function safeStringEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}
