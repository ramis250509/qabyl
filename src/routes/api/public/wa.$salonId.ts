// Green-API webhook receiver: one URL per salon, secured by per-salon token in `?token=`.
// Implements per-conversation atomic lock + state-machine loop so parallel webhooks
// from Green-API don't trample each other.
import { createFileRoute } from "@tanstack/react-router";
import {
  greenApiSendMessage,
  normalizeChatIdToPhone,
  runWaAgent,
  type GreenApiCreds,
  type WaAgentInput,
  type WaAgentState,
  type WaBranchInfo,
  type WaIncomingMessage,
} from "@/lib/wa-agent.server";

const LOCK_TTL_SECONDS = 25;
const MAX_LOOP_ITERATIONS = 3;
const LOCK_WAIT_TIMEOUT_MS = 8000;
const LOCK_POLL_INTERVAL_MS = 400;

export function resolveAssistantRuntimeConfig(salon: any, assistant: any, secrets: any) {
  const assistantEnabled = (salon?.ai_assistant_enabled ?? true) !== false && (assistant?.enabled ?? true);
  const hasGreenApiCreds = Boolean(secrets?.greenapi_instance && secrets?.greenapi_token);
  return {
    assistantEnabled,
    hasGreenApiCreds,
    assistantConfig: {
      greeting: assistant?.greeting ?? null,
      tone_instructions: assistant?.tone_instructions ?? null,
      pricing_rules: assistant?.pricing_rules ?? null,
      languages: assistant?.languages?.length ? assistant.languages : ["ru"],
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
        const token =
          url.searchParams.get("token") || request.headers.get("x-wa-token") || "";
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
            .select("greenapi_instance, greenapi_token, greenapi_webhook_token")
            .eq("salon_id", salonId)
            .maybeSingle(),
          supabaseAdmin
            .from("salons")
            .select("id, name, timezone, ai_assistant_enabled")
            .eq("id", salonId)
            .maybeSingle(),
          supabaseAdmin
            .from("salon_ai_assistant")
            .select("enabled, greeting, tone_instructions, pricing_rules, languages")
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        if (!secrets?.greenapi_webhook_token || secrets.greenapi_webhook_token !== token) {
          return new Response("Forbidden", { status: 403 });
        }
        if (!salon) return ack();

        if (payload?.typeWebhook !== "incomingMessageReceived") return ack();

        const md = payload?.messageData ?? {};
        const sd = payload?.senderData ?? {};
        const chatId: string | undefined = sd?.chatId;
        if (!chatId || !chatId.endsWith("@c.us")) return ack();

        const senderName: string | null = sd?.senderName ?? sd?.chatName ?? null;
        const phone = normalizeChatIdToPhone(chatId);
        const greenIdMessage: string | undefined = payload?.idMessage;

        // ---- Extract content
        let textBody: string | null = null;
        let imageDownloadUrl: string | null = null;
        let imageMime: string | null = null;
        const mt = md?.typeMessage;
        if (mt === "textMessage" || mt === "extendedTextMessage") {
          textBody =
            md?.textMessageData?.textMessage ??
            md?.extendedTextMessageData?.text ??
            null;
        } else if (mt === "imageMessage") {
          imageDownloadUrl = md?.fileMessageData?.downloadUrl ?? null;
          imageMime = md?.fileMessageData?.mimeType ?? "image/jpeg";
          textBody = md?.fileMessageData?.caption ?? null;
        } else {
          // Unsupported types — just ack quietly.
          return ack();
        }

        const nowIso = new Date().toISOString();

        // ---- Load previous conversation before upsert.
        // We need the pre-message timestamps to decide whether this WhatsApp turn
        // belongs to the same short booking session or starts a new clean one.
        const { data: existingConv } = await supabaseAdmin
          .from("wa_conversations")
          .select("id, status, session_started_at, last_appointment_at, last_message_at, state")
          .eq("salon_id", salonId)
          .eq("client_phone", phone)
          .maybeSingle();

        const previousLastMessageAt = existingConv?.last_message_at
          ? new Date(existingConv.last_message_at).getTime()
          : 0;
        const previousLastAppointmentAt = existingConv?.last_appointment_at
          ? new Date(existingConv.last_appointment_at).getTime()
          : 0;
        const previousSessionStartedAt = existingConv?.session_started_at
          ? new Date(existingConv.session_started_at).getTime()
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
        const startsNewSession =
          !existingConv ||
          gapMs > sessionGapMs ||
          (previousLastAppointmentAt > 0 && previousLastAppointmentAt >= previousSessionStartedAt);

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

        // ---- Download image (private bucket)
        let mediaPath: string | null = null;
        if (imageDownloadUrl) {
          try {
            const r = await fetch(imageDownloadUrl);
            if (r.ok) {
              const ab = await r.arrayBuffer();
              const ext = (imageMime?.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
              mediaPath = `${salonId}/${convId}/${Date.now()}.${ext}`;
              const { error: upErr } = await supabaseAdmin.storage
                .from("wa-media")
                .upload(mediaPath, new Uint8Array(ab), {
                  contentType: imageMime ?? "image/jpeg",
                  upsert: false,
                });
              if (upErr) {
                console.error("[wa] media upload failed", upErr);
                mediaPath = null;
              }
            }
          } catch (e) {
            console.error("[wa] media download failed", e);
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
          })
          .select("id")
          .single();

        // Bail out only when the assistant cannot be used at all. Missing assistant row
        // should not prevent the bot from working; we default to enabled and use empty
        // instructions instead of silently dropping the webhook.
        const runtime = resolveAssistantRuntimeConfig(salon, assistant, secrets);
        if (!runtime.assistantEnabled || !runtime.hasGreenApiCreds) {
          return ack();
        }

        // Brief debounce: wait 700ms so that rapid follow-up messages (e.g. client sends
        // "Привет" then "хочу на стрижку" in quick succession) accumulate before we start
        // processing. The drain loop will then batch all pending messages into one turn.
        await new Promise((r) => setTimeout(r, 700));

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
        try {
          // IMPORTANT: reload conversation after the lock is acquired. If this
          // webhook waited while another worker processed a previous message,
          // the `conv` object above is stale and contains the old state/state_data.
          // Using that stale snapshot caused the assistant to forget context on
          // every closely-spaced WhatsApp message.
          const { data: lockedConv } = await supabaseAdmin
            .from("wa_conversations")
            .select(
              "id, client_name, status, selected_branch_id, session_started_at, last_appointment_at, last_message_at, state, state_data",
            )
            .eq("id", convId)
            .maybeSingle();
          const convSnapshot: any = lockedConv ?? conv;

          const creds: GreenApiCreds = {
            instance: secrets.greenapi_instance,
            token: secrets.greenapi_token,
          };

          // Load branches once.
          const { data: branchRows } = await supabaseAdmin
            .from("branches")
            .select("id, name, address")
            .eq("salon_id", salonId)
            .eq("is_active", true)
            .order("sort_order");
          const branches: WaBranchInfo[] = (branchRows ?? []).map((b: any) => ({
            id: b.id,
            name: b.name,
            address: b.address ?? null,
          }));

          let curState: WaAgentState = (convSnapshot.state ?? "idle") as WaAgentState;
          let curStateData = convSnapshot.state_data ?? {};
          let curSelectedBranch: string | null = convSnapshot.selected_branch_id ?? null;
          const sessionStartedAt = (convSnapshot.session_started_at ?? nowIso) as string;
          // Track the last text we actually sent in THIS drain pass so we don't fire the exact
          // same WhatsApp message twice when the client double-texts within one webhook window.
          let lastSentReply: string | null = null;

          for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
            // 1) Load unprocessed inbound messages for this conversation
            const { data: pending } = await supabaseAdmin
              .from("wa_messages")
              .select("id, direction, kind, text_body, media_path, created_at")
              .eq("conversation_id", convId)
              .eq("direction", "in")
              .is("processed_at", null)
              .gte("created_at", sessionStartedAt)
              .order("created_at", { ascending: true })
              .limit(10);

            if (!pending || pending.length === 0) break;

            // 2) Sign media URLs for any image messages
            const lastMessages: WaIncomingMessage[] = [];
            for (const m of pending) {
              let signed: string | null = null;
              if (m.kind === "image" && m.media_path) {
                const { data: s } = await supabaseAdmin.storage
                  .from("wa-media")
                  .createSignedUrl(m.media_path, 600);
                signed = s?.signedUrl ?? null;
              }
              lastMessages.push({
                id: m.id,
                direction: "in",
                kind: m.kind as any,
                text_body: m.text_body,
                media_signed_url: signed,
                media_path: m.media_path,
                created_at: m.created_at,
              });
            }

            // 3) Load current-session history only. Old booked sessions are useful for
            // the admin, but sending them to the agent made it reuse stale context.
            const { data: histRows } = await supabaseAdmin
              .from("wa_messages")
              .select("id, direction, kind, text_body, media_path, created_at")
              .eq("conversation_id", convId)
              .gte("created_at", sessionStartedAt)
              .order("created_at", { ascending: false })
              .limit(30);
            const history: WaIncomingMessage[] = ((histRows ?? []) as any[])
              .reverse()
              .map((m) => ({
                id: m.id,
                direction: m.direction,
                kind: m.kind,
                text_body: m.text_body,
                created_at: m.created_at,
              }));

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
            };

            let result;
            try {
              result = await runWaAgent(input);
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
                green_api_message_id: sent.ok ? sent.idMessage ?? null : null,
                meta: { fatalError: e?.message ?? String(e) } as any,
              });
              // Mark pending as processed so future messages don't get stuck behind them.
              await supabaseAdmin
                .from("wa_messages")
                .update({ processed_at: new Date().toISOString() })
                .in("id", pending.map((m: any) => m.id));
              // Reset state so the client's NEXT message gets a clean run.
              await supabaseAdmin
                .from("wa_conversations")
                .update({ state: "idle", state_data: {} })
                .eq("id", convId);
              break;
            }

            // 5) Send reply — but skip the network send if it is byte-for-byte identical to the
            // previous reply in this same pass (prevents the duplicated "Когда удобнее…" we saw).
            const isDuplicateReply = result.reply.trim() === (lastSentReply ?? "").trim();
            const sent = isDuplicateReply
              ? { ok: true, idMessage: undefined as string | undefined }
              : await greenApiSendMessage(creds, chatId, result.reply);
            if (!isDuplicateReply) lastSentReply = result.reply;
            await supabaseAdmin.from("wa_messages").insert({
              conversation_id: convId,
              salon_id: salonId,
              direction: "out",
              kind: "text",
              text_body: result.reply,
              green_api_message_id: sent.ok ? sent.idMessage ?? null : null,
              meta: {
                intent: result.debug.intent ?? null,
                actions: result.debug.actions,
                errors: result.debug.errors,
                state: result.nextState,
                duplicateSuppressed: isDuplicateReply || undefined,
              } as any,
            });

            // 6) Mark these inbound messages as processed
            await supabaseAdmin
              .from("wa_messages")
              .update({ processed_at: new Date().toISOString() })
              .in("id", pending.map((m: any) => m.id));

            // 7) Persist conversation state
            const updates: Record<string, any> = {
              last_message_at: new Date().toISOString(),
              last_message_preview: result.reply.slice(0, 200),
              state: result.nextState,
              state_data: result.nextStateData ?? {},
            };
            if (result.appointmentId) {
              updates.status = "booked";
              updates.appointment_id = result.appointmentId;
              updates.last_appointment_at = new Date().toISOString();
            }
            if (result.selectedBranchId !== curSelectedBranch) {
              updates.selected_branch_id = result.selectedBranchId;
            }
            await supabaseAdmin.from("wa_conversations").update(updates as any).eq("id", convId);

            curState = result.nextState;
            curStateData = result.nextStateData ?? {};
            curSelectedBranch = result.selectedBranchId;

            // Loop again only if more inbound messages arrived during processing.
          }
        } finally {
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

async function tryAcquireLockWithWait(
  db: any,
  convId: string,
  lockId: string,
): Promise<boolean> {
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
