// Green-API webhook receiver: one URL per salon, secured by per-salon token in `?token=`.
// Implements per-conversation atomic lock + state-machine loop so parallel webhooks
// from Green-API don't trample each other.
import { createFileRoute } from "@tanstack/react-router";
import {
  greenApiSendMessage,
  greenApiSendFileByUrl,
  greenApiDownloadFile,
  isLikelyNativeGreetingRace,
  normalizeChatIdToPhone,
  ownerPhoneMatches,
  renderInteractiveAsText,
  runWaAgentV3,
  transcribeAudio,
  type GreenApiCreds,
  type WaAgentInput,
  type WaAgentState,
  type WaBranchInfo,
  type WaIncomingMessage,
} from "@/lib/wa-agent.server";
import { runWaAgentV4 } from "@/lib/wa-agent-v4.server";

// LOCK_TTL is the WORST-CASE ceiling: how long we let a stuck worker hold the conversation
// before another worker is allowed to take over. Prod incident (2026-07-24) showed a Gemini
// turn on a heavy service (keratin, big tool loop) took ~70 s while TTL was 60 s. Lock expired
// mid-flight, a second worker took the lock, processed the SAME still-unprocessed message,
// called Gemini AGAIN, and sent a DUPLICATE reply (with slightly different wording — Gemini is
// non-deterministic). State writes from both workers also raced and lost context. Root cause
// is closed two ways here:
//   (a) TTL bumped to 180 s so a realistic worst-case turn (2 min of Gemini + tool loop +
//       retries) never expires the lock mid-flight in the first place;
//   (b) every state-mutating write later re-checks `processing_lock_id = ourLockId`, so even
//       IF a lock somehow got stolen we refuse to overwrite state or resend the reply — a
//       zombie worker's turn is silently dropped.
// The lock is also released in a `finally`, so a dying worker frees it fast; the long TTL is
// only the safety net for stuck-but-alive workers.
const LOCK_TTL_SECONDS = 180;
const LOCK_HEARTBEAT_MS = 45_000; // renew every 45s while a long turn is running
const MAX_LOOP_ITERATIONS = 3;
const LOCK_WAIT_TIMEOUT_MS = 8000;
const LOCK_POLL_INTERVAL_MS = 400;
// Burst coalescing (fixes the "half-typed message answered, then corrected a second later" double
// reply): if the newest unprocessed inbound arrived within COALESCE_WINDOW_MS, the client is very
// likely still typing the rest of their thought, so we wait COALESCE_WAIT_MS once and reload the
// pending list — answering the COMPLETE burst with a single message instead of two.
const COALESCE_WINDOW_MS = 1500;
// Trimmed from 900 → 500 ms after prod perf audit: combined with the 350 ms initial debounce,
// end-to-end wait for message coalescing dropped from 1600 ms to 850 ms per typical turn while
// still catching the "half-typed then corrected" burst that motivated the coalescer.
const COALESCE_WAIT_MS = 500;

export function resolveAssistantRuntimeConfig(salon: any, assistant: any, secrets: any) {
  const assistantEnabled =
    (salon?.ai_assistant_enabled ?? true) !== false && (assistant?.enabled ?? true);
  const hasGreenApiCreds = Boolean(secrets?.greenapi_instance && secrets?.greenapi_token);
  return {
    assistantEnabled,
    hasGreenApiCreds,
    // V4 rollout flag: 'v3' (default, legacy state machine) | 'v4' (LLM tool-calling agent).
    engine: assistant?.engine === "v4" ? ("v4" as const) : ("v3" as const),
    assistantConfig: {
      greeting: assistant?.greeting ?? null,
      tone_instructions: assistant?.tone_instructions ?? null,
      pricing_rules: assistant?.pricing_rules ?? null,
      languages: assistant?.languages?.length ? assistant.languages : ["ru"],
      manage_cutoff_hours: assistant?.manage_cutoff_hours ?? 0,
      knowledge_base: assistant?.knowledge_base ?? null,
      client_addressing: assistant?.client_addressing ?? null,
      industry: assistant?.industry ?? null,
      knowledge_answers: assistant?.knowledge_answers ?? null,
      sales_mode: assistant?.sales_mode ?? false,
    },
  };
}

export const Route = createFileRoute("/api/public/wa/$salonId")({
  server: {
    handlers: {
      GET: async () => new Response("ok", { status: 200 }),
      POST: async ({ request, params }) => {
        const salonId = params.salonId;
        const url = new URL(request.url);
        const token = url.searchParams.get("token") || request.headers.get("x-wa-token") || "";
        if (!salonId || !token) {
          return new Response("Forbidden", { status: 403 });
        }

        let payload: any = null;
        try {
          payload = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const ack = () => new Response("ok", { status: 200 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // ---- Validate webhook token + load salon + assistant cfg
        const [{ data: secrets }, { data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin
            .from("salon_secrets")
            .select("greenapi_instance, greenapi_token, greenapi_webhook_token, owner_notify_phone")
            .eq("salon_id", salonId)
            .maybeSingle(),
          supabaseAdmin
            .from("salons")
            .select("id, name, timezone, ai_assistant_enabled, working_hours, address")
            .eq("id", salonId)
            .maybeSingle(),
          supabaseAdmin
            .from("salon_ai_assistant")
            .select(
              "enabled, greeting, tone_instructions, pricing_rules, languages, manage_cutoff_hours, engine, knowledge_base, client_addressing, industry, knowledge_answers, sales_mode, assistant_branch_id",
            )
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        if (!secrets?.greenapi_webhook_token || secrets.greenapi_webhook_token !== token) {
          return new Response("Forbidden", { status: 403 });
        }
        if (!salon) return ack();

        // V4 rollout flag — needed before the content-type switch (voice notes are only
        // supported on the V4 engine; V3 salons keep the old "unsupported → ack" behavior).
        const waEngine: "v3" | "v4" = (assistant as any)?.engine === "v4" ? "v4" : "v3";

        const webhookType = payload?.typeWebhook;
        if (
          webhookType !== "incomingMessageReceived" &&
          webhookType !== "outgoingMessageReceived"
        ) {
          return ack();
        }

        const md = payload?.messageData ?? {};
        const sd = payload?.senderData ?? {};
        const chatId: string | undefined = sd?.chatId;
        if (!chatId || !chatId.endsWith("@c.us")) return ack();

        // Strip potential prompt-injection attempts from the WhatsApp display name.
        // A malicious user could set their name to "Ignore previous instructions..." etc.
        const rawSenderName: string | null = sd?.senderName ?? sd?.chatName ?? null;
        const senderName: string | null = rawSenderName
          ? rawSenderName.replace(/[\n\r]/g, " ").slice(0, 60)
          : null;
        const phone = normalizeChatIdToPhone(chatId);
        const greenIdMessage: string | undefined = payload?.idMessage;
        const nowIso = new Date().toISOString();

        // ---- Human admin took over: a message sent manually from the phone connected
        // to this WhatsApp number. Green-API reports this as outgoingMessageReceived,
        // distinct from outgoingAPIMessageReceived (messages sent via the API — i.e. our
        // own bot replies, a type we never subscribe to). So every event reaching this
        // branch is a genuine manual message from salon staff — pause the AI for this
        // conversation instead of letting it keep replying alongside a human.
        // MUST run before the content-type switch below: a voice note, sticker, location etc.
        // sent by staff has no handler in that switch and used to hit "unsupported → ack()"
        // and return BEFORE ever reaching this check — so the assistant never paused for
        // anything except text/image/button replies. Any outgoingMessageReceived event needs
        // checking regardless of its content type.
        if (webhookType === "outgoingMessageReceived") {
          const { data: convForPause } = await supabaseAdmin
            .from("wa_conversations")
            .select("id, session_started_at")
            .eq("salon_id", salonId)
            .eq("client_phone", phone)
            .maybeSingle();
          if (convForPause) {
            if (greenIdMessage) {
              const { data: dup } = await supabaseAdmin
                .from("wa_messages")
                .select("id")
                .eq("salon_id", salonId)
                .eq("green_api_message_id", greenIdMessage)
                .maybeSingle();
              if (dup) return ack();
            }
            // WhatsApp Business App's own NATIVE greeting/away-message auto-reply is sent by the
            // device itself (not via our API), so Green-API reports it exactly like a human typing
            // manually — outgoingMessageReceived. It fires near-instantly on the client's first
            // message, before our own bot's reply lands (700ms debounce + up to 8s lock-wait +
            // Gemini), so treating EVERY such event as human takeover paused the assistant on
            // literally the first message of every new conversation. Only suppress the pause when
            // this looks like that race (no bot reply yet this session, session just started) —
            // a later outgoing event (bot already replied, or session stale) still pauses as before.
            const { data: priorBotReply } = await supabaseAdmin
              .from("wa_messages")
              .select("id")
              .eq("conversation_id", convForPause.id)
              .eq("direction", "out")
              .eq("kind", "text")
              .gte("created_at", (convForPause as any).session_started_at)
              .limit(1)
              .maybeSingle();
            const sessionAgeMs =
              Date.now() - new Date((convForPause as any).session_started_at).getTime();
            const suppressPause = isLikelyNativeGreetingRace({
              hasBotReplyThisSession: Boolean(priorBotReply),
              sessionAgeMs,
            });
            if (!suppressPause) {
              await supabaseAdmin
                .from("wa_conversations")
                .update({ ai_paused: true, ai_paused_at: nowIso })
                .eq("id", convForPause.id);
            }
            await supabaseAdmin.from("wa_messages").insert({
              conversation_id: convForPause.id,
              salon_id: salonId,
              direction: "out",
              kind: "system",
              // Best-effort text for the audit log only — a voice note/sticker/location has no
              // text, so this stays null for those, which is fine (nothing else depends on it).
              text_body:
                md?.textMessageData?.textMessage ?? md?.extendedTextMessageData?.text ?? null,
              green_api_message_id: greenIdMessage ?? null,
              ...(suppressPause ? { meta: { suppressedAutoPause: true, sessionAgeMs } } : {}),
            });
          }
          return ack();
        }

        // ---- Extract content (incomingMessageReceived only — outgoing already returned above)
        let textBody: string | null = null;
        let imageDownloadUrl: string | null = null;
        let imageMime: string | null = null;
        let selectedId: string | null = null; // V3: button/list selection
        let audioDownloadUrl: string | null = null; // V4: voice note → transcription
        let audioMime: string | null = null;
        const mt = md?.typeMessage;
        if (mt === "textMessage" || mt === "extendedTextMessage") {
          textBody = md?.textMessageData?.textMessage ?? md?.extendedTextMessageData?.text ?? null;
        } else if (mt === "imageMessage") {
          imageDownloadUrl = md?.fileMessageData?.downloadUrl ?? null;
          imageMime = md?.fileMessageData?.mimeType ?? "image/jpeg";
          textBody = md?.fileMessageData?.caption ?? null;
        } else if (mt === "buttonsResponseMessage") {
          selectedId = md?.buttonsResponseMessage?.selectedButtonId ?? null;
          textBody = md?.buttonsResponseMessage?.selectedButtonBody ?? selectedId;
        } else if (mt === "listResponseMessage") {
          selectedId = md?.listResponseMessage?.listResponseRow?.rowId ?? null;
          textBody = md?.listResponseMessage?.listResponseRow?.title ?? selectedId;
        } else if (mt === "templateButtonsReplyMessage") {
          // Tap on a reply button sent via sendInteractiveButtons. Verified against Green-API's
          // own docs (receiving/notifications-format/incoming-message/InteractiveButtonsReply):
          // typeMessage is "templateButtonsReplyMessage" (plural "Buttons") — the previous check
          // for "interactiveButtonsReply" never matched anything Green-API actually sends, so
          // EVERY button tap fell into the "unsupported type" branch below and was silently
          // ack()'d with no reply — this is why tapping "✅ Да, записать" never created a booking.
          selectedId = md?.templateButtonReplyMessage?.selectedId ?? null;
          textBody = md?.templateButtonReplyMessage?.selectedDisplayText ?? selectedId;
        } else if (mt === "audioMessage" && waEngine === "v4") {
          // WhatsApp voice note. Transcribed with Gemini further below (after webhook dedup,
          // so a Green-API retry doesn't pay for a second transcription). V3 salons fall
          // through to "unsupported" — their behavior is unchanged.
          audioDownloadUrl = md?.fileMessageData?.downloadUrl ?? null;
          audioMime = md?.fileMessageData?.mimeType ?? "audio/ogg";
        } else {
          // Unsupported types — just ack quietly.
          return ack();
        }

        // ---- Load previous conversation before upsert.
        // We need the pre-message timestamps to decide whether this WhatsApp turn
        // belongs to the same short booking session or starts a new clean one.
        const { data: existingConv } = await supabaseAdmin
          .from("wa_conversations")
          .select(
            "id, status, session_started_at, last_appointment_at, last_message_at, state, ai_paused, ai_paused_at",
          )
          .eq("salon_id", salonId)
          .eq("client_phone", phone)
          .maybeSingle();

        const previousLastMessageAt = existingConv?.last_message_at
          ? new Date(existingConv.last_message_at).getTime()
          : 0;
        const previousState = (existingConv?.state ?? "idle") as string;
        // A booking that is mid-flow (the client hasn't finished or cancelled) must NOT be wiped
        // just because they paused. Previously a >20-min gap reset state/state_data, so a client
        // returning an hour later got "Здравствуйте" from scratch and lost their slot/language.
        // Keep an in-progress session alive far longer; only idle/done conversations reset on the
        // short gap (so a returning client who already booked still gets a fresh greeting).
        const inProgress = previousState !== "idle" && previousState !== "done";
        const sessionGapMs = inProgress ? 12 * 60 * 60 * 1000 : 20 * 60 * 1000;
        const gapMs = previousLastMessageAt ? Date.now() - previousLastMessageAt : 0;
        // NOTE: previously also force-reset whenever an appointment already existed in this
        // session (previousLastAppointmentAt >= previousSessionStartedAt), regardless of the time
        // gap — that wiped state_data (including the "Перенести/Отменить" menu attached to the
        // booking-success message) on the very NEXT reply, before the client could ever use it.
        // Dropped: state === "done" already routes to a fresh greeting+menu on its own (see
        // runWaAgentV3's idle/done handler), so the "returning client gets a clean start" goal is
        // met either way — the 20-minute gap below is what should decide a genuinely new session.
        const startsNewSession = !existingConv || gapMs > sessionGapMs;

        // ---- Upsert conversation
        const { data: conv, error: convErr } = await supabaseAdmin
          .from("wa_conversations")
          .upsert(
            {
              salon_id: salonId,
              client_phone: phone,
              client_name: senderName,
              last_message_at: nowIso,
              last_message_preview: (textBody ?? "[фото]").slice(0, 200),
              ...(startsNewSession
                ? {
                    status: "active",
                    appointment_id: null,
                    selected_branch_id: null,
                    session_started_at: nowIso,
                    state: "idle",
                    state_data: {},
                  }
                : {}),
            },
            { onConflict: "salon_id,client_phone" },
          )
          .select(
            "id, client_name, status, selected_branch_id, session_started_at, last_appointment_at, last_message_at, state, state_data",
          )
          .single();

        if (convErr || !conv) {
          console.error("[wa] conv upsert failed", convErr);
          return ack();
        }
        const convId = (conv as any).id as string;

        // ---- Dedup webhook by green_api_message_id BEFORE inserting message
        if (greenIdMessage) {
          const { data: dup } = await supabaseAdmin
            .from("wa_messages")
            .select("id")
            .eq("salon_id", salonId)
            .eq("green_api_message_id", greenIdMessage)
            .maybeSingle();
          if (dup) return ack();
        }

        // ---- Hidden owner-only test command: "/restart" fully resets the conversation so the
        // salon owner can re-run the scenario from scratch during testing. Gated to the admin's
        // own number (owner_notify_phone) so ordinary clients can't discover or trigger it — for
        // anyone else the command is NOT recognized and simply flows on as a normal message.
        const ownerNotifyPhone = secrets.owner_notify_phone
          ? normalizeChatIdToPhone(secrets.owner_notify_phone)
          : "";
        const isRestartCmd = textBody?.trim().toLowerCase() === "/restart";
        // Log rejected /restart so a misconfigured owner_notify_phone is diagnosable (it silently
        // no-op'd before). /restart only ever clears the SENDER's own conversation, so a tolerant
        // owner match is safe.
        if (isRestartCmd && !ownerPhoneMatches(phone, ownerNotifyPhone)) {
          console.warn(
            `[wa] /restart ignored: sender ${phone} does not match owner_notify_phone ${ownerNotifyPhone || "(unset)"}`,
          );
        }
        if (isRestartCmd && ownerPhoneMatches(phone, ownerNotifyPhone)) {
          const resetIso = new Date().toISOString();
          // Drop any queued-but-unprocessed inbound so the fresh session starts truly clean.
          await supabaseAdmin
            .from("wa_messages")
            .update({ processed_at: resetIso })
            .eq("conversation_id", convId)
            .is("processed_at", null);
          await supabaseAdmin
            .from("wa_conversations")
            .update({
              status: "active",
              state: "idle",
              state_data: {},
              selected_branch_id: null,
              appointment_id: null,
              session_started_at: resetIso,
              ai_paused: false,
              ai_paused_at: null,
              last_message_at: resetIso,
            })
            .eq("id", convId);
          if (secrets.greenapi_instance && secrets.greenapi_token) {
            await greenApiSendMessage(
              { instance: secrets.greenapi_instance, token: secrets.greenapi_token },
              chatId,
              "🔄 Сценарий перезапущен. Можно тестировать заново.",
            );
          }
          return ack();
        }

        // ---- V4: transcribe a voice note into textBody. Runs after webhook dedup so a
        // Green-API retry never pays for a second Gemini transcription. On success the
        // transcript flows through the normal text pipeline (history, agent, admin panel);
        // the admin also benefits — they see what was said even when the AI is paused.
        if (mt === "audioMessage" && waEngine === "v4") {
          const dlCreds: GreenApiCreds = {
            instance: secrets.greenapi_instance ?? "",
            token: secrets.greenapi_token ?? "",
          };
          const fetchAudio = async (
            u: string,
          ): Promise<{ base64: string; mime: string } | null> => {
            try {
              const r = await fetch(u);
              if (!r.ok) return null;
              const ab = await r.arrayBuffer();
              if (ab.byteLength > 8 * 1024 * 1024) return null; // voice notes are tiny; 8MB = abuse
              return {
                base64: Buffer.from(ab).toString("base64"),
                mime: r.headers.get("content-type") ?? audioMime ?? "audio/ogg",
              };
            } catch {
              return null;
            }
          };
          let audio = audioDownloadUrl ? await fetchAudio(audioDownloadUrl) : null;
          if (!audio && greenIdMessage && dlCreds.instance && dlCreds.token) {
            // Webhook often omits/expires downloadUrl — same fallback as images below.
            const fresh = await greenApiDownloadFile(dlCreds, chatId, greenIdMessage);
            if (fresh.ok && fresh.downloadUrl) audio = await fetchAudio(fresh.downloadUrl);
          }
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
            console.error("[wa] voice transcription failed:", (tr as any).error);
            // Store an audit row (already processed — the agent must not pick it up) and
            // ask the client to type instead, unless a human admin is currently handling.
            await supabaseAdmin.from("wa_messages").insert({
              conversation_id: convId,
              salon_id: salonId,
              direction: "in",
              kind: "text",
              text_body: null,
              green_api_message_id: greenIdMessage ?? null,
              processed_at: new Date().toISOString(),
              meta: { voice: true, transcription_failed: true },
            });
            const pausedNow =
              Boolean(existingConv?.ai_paused) &&
              existingConv?.ai_paused_at &&
              Date.now() - new Date(existingConv.ai_paused_at as string).getTime() < 60 * 60 * 1000;
            if (!pausedNow && dlCreds.instance && dlCreds.token) {
              await greenApiSendMessage(
                dlCreds,
                chatId,
                "Извините, не получилось разобрать голосовое сообщение 🙏 Напишите, пожалуйста, текстом.",
              );
            }
            return ack();
          }
        }

        // ---- Download image (private bucket). Green-API frequently omits downloadUrl in the
        // webhook (or it has expired by the time we process), which left the assistant blind to a
        // client's photo and it replied "Фото не получили". If the webhook URL is missing or the
        // fetch fails, we ask Green-API for a fresh URL via downloadFile using this idMessage.
        let mediaPath: string | null = null;
        if (mt === "imageMessage") {
          const dlCreds: GreenApiCreds = {
            instance: secrets.greenapi_instance ?? "",
            token: secrets.greenapi_token ?? "",
          };
          const tryStore = async (u: string): Promise<boolean> => {
            try {
              const r = await fetch(u);
              if (!r.ok) return false;
              const ab = await r.arrayBuffer();
              const ext = (imageMime?.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
              const path = `${salonId}/${convId}/${Date.now()}.${ext}`;
              const { error: upErr } = await supabaseAdmin.storage
                .from("wa-media")
                .upload(path, new Uint8Array(ab), {
                  contentType: imageMime ?? "image/jpeg",
                  upsert: false,
                });
              if (upErr) {
                console.error("[wa] media upload failed", upErr);
                return false;
              }
              mediaPath = path;
              return true;
            } catch (e) {
              console.error("[wa] media download failed", e);
              return false;
            }
          };
          let stored = imageDownloadUrl ? await tryStore(imageDownloadUrl) : false;
          if (!stored && greenIdMessage && dlCreds.instance && dlCreds.token) {
            const fresh = await greenApiDownloadFile(dlCreds, chatId, greenIdMessage);
            if (fresh.ok && fresh.downloadUrl) {
              stored = await tryStore(fresh.downloadUrl);
            } else if (!fresh.ok) {
              console.error("[wa] downloadFile fallback failed", fresh.error);
            }
          }
        }

        // ---- Insert inbound message (NOT yet processed)
        const { data: insertedMsg } = await supabaseAdmin
          .from("wa_messages")
          .insert({
            conversation_id: convId,
            salon_id: salonId,
            direction: "in",
            kind: mediaPath ? "image" : "text",
            text_body: textBody,
            media_path: mediaPath,
            green_api_message_id: greenIdMessage ?? null,
            ...(selectedId || mt === "audioMessage"
              ? {
                  meta: {
                    ...(selectedId ? { selected_id: selectedId } : {}),
                    ...(mt === "audioMessage" ? { voice: true } : {}),
                  },
                }
              : {}),
          })
          .select("id")
          .single();

        // ---- Human admin is actively handling this conversation: skip the AI. The
        // inbound message above is already stored (processed_at IS NULL) so whenever the
        // AI resumes it picks the message up normally (subject to the 12h staleness filter).
        const AI_PAUSE_MS = 60 * 60 * 1000;
        const pausedAtMs = existingConv?.ai_paused_at
          ? new Date(existingConv.ai_paused_at as string).getTime()
          : 0;
        const stillPaused =
          Boolean(existingConv?.ai_paused) &&
          pausedAtMs > 0 &&
          Date.now() - pausedAtMs < AI_PAUSE_MS;
        if (stillPaused) {
          return ack();
        }
        if (existingConv?.ai_paused) {
          // Pause window elapsed with no further manual messages — hand control back to the AI.
          await supabaseAdmin
            .from("wa_conversations")
            .update({ ai_paused: false, ai_paused_at: null })
            .eq("id", convId);
        }

        // Bail out only when the assistant cannot be used at all. Missing assistant row
        // should not prevent the bot from working; we default to enabled and use empty
        // instructions instead of silently dropping the webhook.
        const runtime = resolveAssistantRuntimeConfig(salon, assistant, secrets);
        if (!runtime.assistantEnabled || !runtime.hasGreenApiCreds) {
          return ack();
        }

        // Brief debounce: wait 350ms so that rapid follow-up messages (e.g. client sends
        // "Привет" then "хочу на стрижку" in quick succession) accumulate before we start
        // processing. The drain loop will then batch all pending messages into one turn.
        // Trimmed from 700 → 350 ms after prod perf audit — the drain-loop coalescer already
        // catches most bursts, so a shorter initial debounce cuts baseline latency in half here.
        await new Promise((r) => setTimeout(r, 350));

        // ---- Try to acquire processing lock; if another worker holds it, wait briefly
        // (it will pick up our just-inserted message in its loop).
        const lockId = crypto.randomUUID();
        const acquired = await tryAcquireLockWithWait(supabaseAdmin, convId, lockId);
        if (!acquired) {
          // Another worker is handling this conversation. Our message is queued via
          // processed_at IS NULL — that worker will pick it up.
          return ack();
        }

        // ---- Processing loop (worker drains unprocessed inbound messages)
        // Declared outside try so `finally` can clear it regardless of where an error fires.
        let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
        try {
          // IMPORTANT: reload conversation after the lock is acquired. If this
          // webhook waited while another worker processed a previous message,
          // the `conv` object above is stale and contains the old state/state_data.
          // Using that stale snapshot caused the assistant to forget context on
          // every closely-spaced WhatsApp message.
          // Reload the conversation and load branches in parallel — the two queries are
          // independent, so one round-trip instead of two shaves latency off every turn.
          const [{ data: lockedConv }, { data: branchRows }] = await Promise.all([
            supabaseAdmin
              .from("wa_conversations")
              .select(
                "id, client_name, status, selected_branch_id, session_started_at, last_appointment_at, last_message_at, state, state_data",
              )
              .eq("id", convId)
              .maybeSingle(),
            supabaseAdmin
              .from("branches")
              .select("id, name, address")
              .eq("salon_id", salonId)
              .eq("is_active", true)
              .order("sort_order"),
          ]);
          const convSnapshot: any = lockedConv ?? conv;

          const creds: GreenApiCreds = {
            instance: secrets.greenapi_instance ?? "",
            token: secrets.greenapi_token ?? "",
          };

          let branches: WaBranchInfo[] = (branchRows ?? []).map((b: any) => ({
            id: b.id,
            name: b.name,
            address: b.address ?? null,
          }));

          let curState: WaAgentState = (convSnapshot.state ?? "idle") as WaAgentState;
          let curStateData = convSnapshot.state_data ?? {};
          let curSelectedBranch: string | null = convSnapshot.selected_branch_id ?? null;

          // Super-admin pinned this assistant to exactly one branch (salon settings → Ассистент).
          // Replace the branch list with just that one and force selection from turn zero — every
          // downstream consumer (both engines: masters roster, get_masters, get_available_slots,
          // get_my_appointments, closed-day detection) already keys off `branches`/selectedBranchId,
          // so this single choke point is enough to make masters/schedule/slots/appointments/
          // knowledge from OTHER branches unreachable, without touching either engine's internals
          // for the (still fully supported) multi-branch dynamic flow. Falls back to the normal
          // dynamic flow if the pinned branch was deactivated or deleted since being set.
          const pinnedBranchId = (assistant as any)?.assistant_branch_id as
            | string
            | null
            | undefined;
          if (pinnedBranchId) {
            const pinned = branches.find((b) => b.id === pinnedBranchId);
            if (pinned) {
              branches = [pinned];
              curSelectedBranch = pinned.id;
            }
          }
          const sessionStartedAt = (convSnapshot.session_started_at ?? nowIso) as string;
          // Track the last text we actually sent in THIS drain pass so we don't fire the exact
          // same WhatsApp message twice when the client double-texts within one webhook window.
          let lastSentReply: string | null = null;
          // Coalesce at most once per drain pass, so a client sending many quick bursts can't stall
          // the worker indefinitely (each real turn still gets processed).
          let settledThisPass = false;

          // Lock heartbeat: for turns that legitimately take long (heavy Gemini tool loops,
          // photo pricing, etc.) we refresh the lock every LOCK_HEARTBEAT_MS. Prevents the
          // observed prod bug where a >60 s Gemini turn lost its lock mid-flight and a second
          // worker started a duplicate turn on the same still-unprocessed inbound message.
          heartbeatHandle = setInterval(() => {
            refreshLock(supabaseAdmin, convId, lockId).catch((e) =>
              console.error("[wa] heartbeat refresh failed", e?.message ?? e),
            );
          }, LOCK_HEARTBEAT_MS);

          for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
            // 1) Load unprocessed inbound messages for this conversation
            const { data: pending } = await supabaseAdmin
              .from("wa_messages")
              .select("id, direction, kind, text_body, media_path, created_at, meta")
              .eq("conversation_id", convId)
              .eq("direction", "in")
              .is("processed_at", null)
              .gte("created_at", sessionStartedAt)
              .order("created_at", { ascending: true })
              .limit(10);

            if (!pending || pending.length === 0) break;

            // 1b) Ignore inbound messages older than 12h — e.g. the assistant was disabled
            // for days and a backlog of stale, never-processed messages piled up. Replying to
            // those now would look like the bot randomly resurrecting a days-old conversation.
            // Stale messages are marked processed immediately (silently) without any reply;
            // if nothing fresh remains this pass, skip straight to the next drain iteration.
            const STALE_MESSAGE_MS = 12 * 60 * 60 * 1000;
            const staleCutoff = Date.now() - STALE_MESSAGE_MS;
            const stalePending = pending.filter(
              (m: any) => new Date(m.created_at).getTime() < staleCutoff,
            );
            const freshPending = pending.filter(
              (m: any) => new Date(m.created_at).getTime() >= staleCutoff,
            );
            if (stalePending.length > 0) {
              await supabaseAdmin
                .from("wa_messages")
                .update({ processed_at: new Date().toISOString() })
                .in(
                  "id",
                  stalePending.map((m: any) => m.id),
                );
            }
            if (freshPending.length === 0) continue;

            // 1c) Burst coalescing: if the client's newest message landed just now, they're likely
            // still typing the rest. Wait once and reload so we answer the WHOLE burst with a single
            // reply — instead of answering a half-typed message and then correcting ourselves a
            // second later (the "простите, не поняла… → а вот свободное время" double message).
            if (!settledThisPass) {
              const newestMs = Math.max(
                ...freshPending.map((m: any) => new Date(m.created_at).getTime()),
              );
              if (Date.now() - newestMs < COALESCE_WINDOW_MS) {
                settledThisPass = true;
                await new Promise((r) => setTimeout(r, COALESCE_WAIT_MS));
                continue; // reload pending — the follow-up message is now included
              }
            }

            // 2) Sign media URLs for any image messages IN PARALLEL. A burst with 2–3 photos
            // used to pay 2–3 × ~200 ms serially before the agent even started.
            const lastMessages: WaIncomingMessage[] = await Promise.all(
              freshPending.map(async (m: any) => {
                let signed: string | null = null;
                if (m.kind === "image" && m.media_path) {
                  const { data: s } = await supabaseAdmin.storage
                    .from("wa-media")
                    .createSignedUrl(m.media_path, 600);
                  signed = s?.signedUrl ?? null;
                }
                return {
                  id: m.id,
                  direction: "in",
                  kind: m.kind as any,
                  text_body: m.text_body,
                  media_signed_url: signed,
                  media_path: m.media_path,
                  created_at: m.created_at,
                  selected_id: m?.meta?.selected_id ?? null,
                };
              }),
            );

            // 3) Load per-engine context for the current session only. Old booked sessions are
            // useful for the admin, but feeding them to the agent made it reuse stale context.
            //   - V3 replays the message history (it doesn't keep its own transcript).
            //   - V4 keeps its own Gemini transcript in state_data.v4_history, so the 30-row
            //     history query would be wasted latency. Instead V4 gets handoffContext: the text
            //     of any manual messages the LIVE admin sent the client this session, so when the
            //     AI resumes after a takeover pause it never contradicts what the human already said.
            let history: WaIncomingMessage[] = [];
            let handoffContext: string[] = [];
            if (waEngine === "v4") {
              const { data: adminMsgs } = await supabaseAdmin
                .from("wa_messages")
                .select("text_body, created_at")
                .eq("conversation_id", convId)
                .eq("direction", "out")
                .eq("kind", "system")
                .gte("created_at", sessionStartedAt)
                .not("text_body", "is", null)
                .order("created_at", { ascending: false })
                .limit(5);
              handoffContext = ((adminMsgs ?? []) as any[])
                .map((m) => (m.text_body ?? "").trim())
                .filter(Boolean)
                .reverse();
            } else {
              const { data: histRows } = await supabaseAdmin
                .from("wa_messages")
                .select("id, direction, kind, text_body, media_path, created_at")
                .eq("conversation_id", convId)
                .gte("created_at", sessionStartedAt)
                .order("created_at", { ascending: false })
                .limit(30);
              history = ((histRows ?? []) as any[]).reverse().map((m) => ({
                id: m.id,
                direction: m.direction,
                kind: m.kind,
                text_body: m.text_body,
                created_at: m.created_at,
              }));
            }

            // 4) Run agent
            const input: WaAgentInput = {
              salon: {
                salonId,
                salonName: (salon as any).name,
                timezone: (salon as any).timezone ?? "UTC",
              },
              config: runtime.assistantConfig,
              client: { phone, name: senderName },
              history,
              lastMessages,
              branches,
              selectedBranchId: curSelectedBranch,
              state: curState,
              stateData: curStateData,
              salonInfo: {
                working_hours: (salon as any).working_hours ?? null,
                address: (salon as any).address ?? null,
              },
              ...(handoffContext.length ? { handoffContext } : {}),
            };

            let result;
            try {
              result = waEngine === "v4" ? await runWaAgentV4(input) : await runWaAgentV3(input);
            } catch (e: any) {
              console.error("[wa] runWaAgent threw", e?.message ?? e);
              const reply =
                "Извините, не получилось обработать запрос. Попробуйте, пожалуйста, ещё раз.";
              const sent = await greenApiSendMessage(creds, chatId, reply);
              await supabaseAdmin.from("wa_messages").insert({
                conversation_id: convId,
                salon_id: salonId,
                direction: "out",
                kind: "text",
                text_body: reply,
                green_api_message_id: sent.ok ? (sent.idMessage ?? null) : null,
                meta: { fatalError: e?.message ?? String(e) } as any,
              });
              // Mark pending as processed so future messages don't get stuck behind them.
              await supabaseAdmin
                .from("wa_messages")
                .update({ processed_at: new Date().toISOString() })
                .in(
                  "id",
                  freshPending.map((m: any) => m.id),
                );
              // Reset state so the client's NEXT message gets a clean run.
              await supabaseAdmin
                .from("wa_conversations")
                .update({ state: "idle", state_data: {} })
                .eq("id", convId);
              break;
            }

            // 5) Send reply — skip network if byte-for-byte identical to previous in this pass.
            // BEFORE any user-visible side effect (send / mark-processed / state-write) we
            // re-verify the lock is still OURS. If TTL elapsed and another worker took over,
            // that worker's turn is authoritative — dropping our reply here is the ONLY way to
            // avoid the "duplicate reply with different wording" incident (prod 2026-07-24).
            const stillOwn = await stillHoldingLock(supabaseAdmin, convId, lockId);
            if (!stillOwn) {
              console.warn(
                `[wa] lock lost mid-turn (conv=${convId}) — dropping stale reply + state write to avoid double-message`,
              );
              break; // exit the drain loop; the successor worker owns the conversation now
            }
            const im = result.interactiveMessage;
            const sentText = im
              ? renderInteractiveAsText(
                  result.reply,
                  im,
                  ((result.nextStateData as any)?.language as "ru" | "ky" | "en") ?? "ru",
                )
              : result.reply;
            const isDuplicateReply = sentText.trim() === (lastSentReply ?? "").trim();
            let sentIdMessage: string | undefined;
            if (!isDuplicateReply) {
              const res = await greenApiSendMessage(creds, chatId, sentText);
              sentIdMessage = res.ok ? res.idMessage : undefined;
              lastSentReply = sentText;
            }
            await supabaseAdmin.from("wa_messages").insert({
              conversation_id: convId,
              salon_id: salonId,
              direction: "out",
              kind: "text",
              text_body: sentText,
              green_api_message_id: sentIdMessage ?? null,
              meta: {
                intent: result.debug.intent ?? null,
                actions: result.debug.actions,
                errors: result.debug.errors,
                state: result.nextState,
                interactive: result.interactiveMessage?.kind ?? null,
                duplicateSuppressed: isDuplicateReply || undefined,
              } as any,
            });

            // 5b) Relay the client's photo to the salon admin when the agent flagged low-
            // confidence pricing twice in a row. Reuses the same ai_paused mechanism as a
            // human takeover: the admin is now expected to handle this client directly.
            if (result.notifyAdmin) {
              await notifyOwner({
                salonId,
                creds,
                ownerNotifyPhoneRaw: secrets.owner_notify_phone,
                kind: "photo",
                title: "Клиент прислал фото — нужна оценка администратора",
                text: result.notifyAdmin.caption,
                mediaUrl: result.notifyAdmin.mediaUrl,
              });
              await supabaseAdmin
                .from("wa_conversations")
                .update({ ai_paused: true, ai_paused_at: new Date().toISOString() })
                .eq("id", convId);
            }

            // 5c) V4 escalation: alert the salon admin that a live human is needed (the state
            // update below also pauses the bot). De-dupe: don't re-alert if we already alerted
            // the admin within the last 4h and they still haven't responded — otherwise a
            // stubborn client who keeps writing after each 60-min pause elapses would spam the
            // admin's WhatsApp with the same escalation over and over.
            if (result.notifyAdminText) {
              const lastEscalatedAt = (curStateData as any)?.last_escalated_at as
                | string
                | undefined;
              const recentlyAlerted =
                lastEscalatedAt &&
                Date.now() - new Date(lastEscalatedAt).getTime() < 4 * 60 * 60 * 1000;
              if (!recentlyAlerted) {
                await notifyOwner({
                  salonId,
                  creds,
                  ownerNotifyPhoneRaw: secrets.owner_notify_phone,
                  kind: "escalation",
                  title: "Клиенту нужен администратор",
                  text: result.notifyAdminText,
                });
                // Record on the state so subsequent turns can see it (persisted below at 7).
                (result.nextStateData as any) = {
                  ...(result.nextStateData ?? {}),
                  last_escalated_at: new Date().toISOString(),
                };
              }
            }

            // 6) Mark these inbound messages as processed
            await supabaseAdmin
              .from("wa_messages")
              .update({ processed_at: new Date().toISOString() })
              .in(
                "id",
                freshPending.map((m: any) => m.id),
              );

            // 7) Persist conversation state
            const updates: Record<string, any> = {
              last_message_at: new Date().toISOString(),
              last_message_preview: result.reply.slice(0, 200),
              state: result.nextState,
              state_data: result.nextStateData ?? {},
            };
            // V4 escalation: the agent called escalate_to_human — hand the conversation to
            // a live admin the same way a manual takeover does (bot stays quiet for the
            // ai_paused window). V3 keeps its own needs_human handling untouched.
            if (waEngine === "v4" && (result.nextStateData as any)?.needs_human) {
              updates.ai_paused = true;
              updates.ai_paused_at = new Date().toISOString();
            }
            if (result.appointmentId) {
              updates.status = "booked";
              updates.appointment_id = result.appointmentId;
              updates.last_appointment_at = new Date().toISOString();
            }
            if (result.selectedBranchId !== curSelectedBranch) {
              updates.selected_branch_id = result.selectedBranchId;
            }
            await supabaseAdmin
              .from("wa_conversations")
              .update(updates as any)
              .eq("id", convId);

            curState = result.nextState;
            curStateData = result.nextStateData ?? {};
            curSelectedBranch = result.selectedBranchId;

            // Loop again only if more inbound messages arrived during processing.
          }
        } finally {
          // Stop the heartbeat before releasing so we don't extend a lock we're about to drop.
          if (heartbeatHandle) {
            try {
              clearInterval(heartbeatHandle);
            } catch {}
          }
          // Always release the lock.
          try {
            await supabaseAdmin.rpc("wa_release_lock" as any, {
              _conversation_id: convId,
              _lock_id: lockId,
            });
          } catch (e) {
            console.error("[wa] lock release failed", e);
          }
        }

        return ack();
      },
    },
  },
});

// Deliver an owner alert (escalation / photo hand-off) as reliably as we can.
//
// Escalation is the one path that MUST NOT fail silently — it is the salon's safety net when the
// assistant can't help. Three defects made it unreliable: the WhatsApp send was skipped without a
// trace when owner_notify_phone was empty (the settings form saves "" as NULL, so one save with a
// blank field silently disabled every future alert), the send result was discarded so a Green-API
// failure (unpaid instance, bad number, network) went unnoticed, and the alert lived ONLY as a
// WhatsApp message — if it didn't land, it was gone forever.
//
// WhatsApp is the owner's channel — when it works, the alert lands there and nowhere else, so the
// admin panel stays clean. The `notifications` row is a FALLBACK, written only if WhatsApp could
// not be delivered (no owner_notify_phone, or Green-API rejected/failed). That keeps the safety
// net that caught this exact outage — the alert is never lost silently — without duplicating every
// working alert into the panel.
async function notifyOwner(opts: {
  salonId: string;
  creds: GreenApiCreds;
  ownerNotifyPhoneRaw: string | null | undefined;
  kind: "escalation" | "photo";
  title: string;
  text: string;
  mediaUrl?: string;
}): Promise<void> {
  // Last-resort record so an undelivered alert still reaches a human via the admin panel.
  const persistFallback = async (why: string) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("notifications").insert({
        salon_id: opts.salonId,
        type: `wa.${opts.kind}`,
        title: opts.title,
        body: `${opts.text}\n\n[WhatsApp не доставлен: ${why}]`.slice(0, 2000),
      } as any);
    } catch (e: any) {
      console.error(`[wa] notifyOwner: fallback notification insert failed: ${e?.message ?? e}`);
    }
  };

  const ownerPhone = opts.ownerNotifyPhoneRaw
    ? normalizeChatIdToPhone(opts.ownerNotifyPhoneRaw)
    : "";
  if (!ownerPhone) {
    console.error(
      `[wa] notifyOwner(${opts.kind}) salon=${opts.salonId}: owner_notify_phone is NOT configured — WhatsApp alert impossible; saved to the admin panel instead. Set it in salon settings.`,
    );
    await persistFallback("номер владельца не указан в настройках салона");
    return;
  }
  const chat = `${ownerPhone}@c.us`;
  const send = () =>
    opts.mediaUrl
      ? greenApiSendFileByUrl(opts.creds, chat, opts.mediaUrl, "photo.jpg", opts.text)
      : greenApiSendMessage(opts.creds, chat, opts.text);

  console.log(`[wa] notifyOwner(${opts.kind}) sending to ${ownerPhone} …`);
  let res = await send();
  if (!res.ok) {
    console.error(`[wa] notifyOwner(${opts.kind}) → ${ownerPhone} failed: ${res.error} — retrying`);
    await new Promise((r) => setTimeout(r, 600));
    res = await send();
  }
  if (res.ok) {
    // Log the success too: a silent success and a silent skip look identical in the logs
    // otherwise, which is what made this outage hard to pin down.
    console.log(`[wa] notifyOwner(${opts.kind}) → ${ownerPhone} delivered to Green-API`);
    return;
  }
  console.error(
    `[wa] notifyOwner(${opts.kind}) → ${ownerPhone} FAILED after retry: ${res.error}. Falling back to the admin panel.`,
  );
  await persistFallback(res.error ?? "неизвестная ошибка Green-API");
}

// Refresh (re-acquire) the lock while we still legitimately hold it — extends TTL by
// LOCK_TTL_SECONDS from `now`. The wa_try_acquire_lock RPC only succeeds when the current
// row's lock is either absent, expired, OR belongs to the same lock_id — so the same worker
// can extend its own TTL safely. Called on a heartbeat during long turns.
async function refreshLock(db: any, convId: string, lockId: string): Promise<boolean> {
  const { data } = await db.rpc("wa_try_acquire_lock", {
    _conversation_id: convId,
    _lock_id: lockId,
    _ttl_seconds: LOCK_TTL_SECONDS,
  });
  return data === true;
}

// Am I still the exclusive owner of this conversation's lock? Used as the last-line
// correctness check before any state-mutating write (send reply / mark processed / persist
// state). If the lock was stolen (TTL expired and another worker grabbed it), we MUST NOT
// send a stale reply or overwrite fresher state — the other worker's turn is authoritative.
async function stillHoldingLock(db: any, convId: string, lockId: string): Promise<boolean> {
  const { data } = await db
    .from("wa_conversations")
    .select("processing_lock_id, processing_lock_until")
    .eq("id", convId)
    .maybeSingle();
  if (!data) return false;
  const untilMs = data.processing_lock_until ? new Date(data.processing_lock_until).getTime() : 0;
  return data.processing_lock_id === lockId && untilMs > Date.now();
}

async function tryAcquireLockWithWait(db: any, convId: string, lockId: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    const { data, error } = await db.rpc("wa_try_acquire_lock", {
      _conversation_id: convId,
      _lock_id: lockId,
      _ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (error) {
      console.error("[wa] lock rpc error", error);
      return false;
    }
    if (data === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
}
