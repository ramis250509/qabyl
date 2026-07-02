// Green-API webhook receiver: one URL per salon, secured by per-salon token in `?token=`.
// Implements per-conversation atomic lock + state-machine loop so parallel webhooks
// from Green-API don't trample each other.
import { createFileRoute } from "@tanstack/react-router";
import {
  greenApiSendMessage,
  greenApiSendButtons,
  greenApiSendListMessage,
  greenApiSendFileByUrl,
  normalizeChatIdToPhone,
  runWaAgentV3,
  type GreenApiCreds,
  type WaAgentInput,
  type WaAgentState,
  type WaBranchInfo,
  type WaIncomingMessage,
  type WaInteractiveMessage,
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
      manage_cutoff_hours: assistant?.manage_cutoff_hours ?? 0,
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
            .select("enabled, greeting, tone_instructions, pricing_rules, languages, manage_cutoff_hours")
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        if (!secrets?.greenapi_webhook_token || secrets.greenapi_webhook_token !== token) {
          return new Response("Forbidden", { status: 403 });
        }
        if (!salon) return ack();

        const webhookType = payload?.typeWebhook;
        if (webhookType !== "incomingMessageReceived" && webhookType !== "outgoingMessageReceived") {
          return ack();
        }

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
        let selectedId: string | null = null; // V3: button/list selection
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
        } else if (mt === "buttonsResponseMessage") {
          selectedId = md?.buttonsResponseMessage?.selectedButtonId ?? null;
          textBody = md?.buttonsResponseMessage?.selectedButtonBody ?? selectedId;
        } else if (mt === "listResponseMessage") {
          selectedId = md?.listResponseMessage?.listResponseRow?.rowId ?? null;
          textBody = md?.listResponseMessage?.listResponseRow?.title ?? selectedId;
        } else {
          // Unsupported types — just ack quietly.
          return ack();
        }

        const nowIso = new Date().toISOString();

        // ---- Human admin took over: a message sent manually from the phone connected
        // to this WhatsApp number. Green-API reports this as outgoingMessageReceived,
        // distinct from outgoingAPIMessageReceived (messages sent via the API — i.e. our
        // own bot replies, a type we never subscribe to). So every event reaching this
        // branch is a genuine manual message from salon staff — pause the AI for this
        // conversation instead of letting it keep replying alongside a human.
        if (webhookType === "outgoingMessageReceived") {
          const { data: convForPause } = await supabaseAdmin
            .from("wa_conversations")
            .select("id")
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
            await supabaseAdmin
              .from("wa_conversations")
              .update({ ai_paused: true, ai_paused_at: nowIso })
              .eq("id", convForPause.id);
            await supabaseAdmin.from("wa_messages").insert({
              conversation_id: convForPause.id,
              salon_id: salonId,
              direction: "out",
              kind: "system",
              text_body: textBody,
              green_api_message_id: greenIdMessage ?? null,
            });
          }
          return ack();
        }

        // ---- Load previous conversation before upsert.
        // We need the pre-message timestamps to decide whether this WhatsApp turn
        // belongs to the same short booking session or starts a new clean one.
        const { data: existingConv } = await supabaseAdmin
          .from("wa_conversations")
          .select("id, status, session_started_at, last_appointment_at, last_message_at, state, ai_paused, ai_paused_at")
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
            ...(selectedId ? { meta: { selected_id: selectedId } } : {}),
          })
          .select("id")
          .single();

        // ---- Human admin is actively handling this conversation: skip the AI. The
        // inbound message above is already stored (processed_at IS NULL) so whenever the
        // AI resumes it picks the message up normally (subject to the 12h staleness filter).
        const AI_PAUSE_MS = 60 * 60 * 1000;
        const pausedAtMs = existingConv?.ai_paused_at ? new Date(existingConv.ai_paused_at as string).getTime() : 0;
        const stillPaused = Boolean(existingConv?.ai_paused) && pausedAtMs > 0 && Date.now() - pausedAtMs < AI_PAUSE_MS;
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
            instance: secrets.greenapi_instance ?? "",
            token: secrets.greenapi_token ?? "",
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
            const stalePending = pending.filter((m: any) => new Date(m.created_at).getTime() < staleCutoff);
            const freshPending = pending.filter((m: any) => new Date(m.created_at).getTime() >= staleCutoff);
            if (stalePending.length > 0) {
              await supabaseAdmin
                .from("wa_messages")
                .update({ processed_at: new Date().toISOString() })
                .in("id", stalePending.map((m: any) => m.id));
            }
            if (freshPending.length === 0) continue;

            // 2) Sign media URLs for any image messages
            const lastMessages: WaIncomingMessage[] = [];
            for (const m of freshPending) {
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
                selected_id: (m as any).meta?.selected_id ?? null,
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
              salonInfo: {
                working_hours: (salon as any).working_hours ?? null,
                address: (salon as any).address ?? null,
              },
            };

            let result;
            try {
              result = await runWaAgentV3(input);
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
                .in("id", freshPending.map((m: any) => m.id));
              // Reset state so the client's NEXT message gets a clean run.
              await supabaseAdmin
                .from("wa_conversations")
                .update({ state: "idle", state_data: {} })
                .eq("id", convId);
              break;
            }

            // 5) Send reply — skip network if byte-for-byte identical to previous in this pass.
            // If result has an interactiveMessage (V3), send it instead of plain text.
            const isDuplicateReply = result.reply.trim() === (lastSentReply ?? "").trim();
            let sentIdMessage: string | undefined;
            if (!isDuplicateReply) {
              const im: WaInteractiveMessage | undefined = result.interactiveMessage;
              if (im) {
                let res;
                if (im.kind === "buttons") {
                  res = await greenApiSendButtons(creds, chatId, im.text, im.buttons);
                } else {
                  const wireSections = im.sections.map((sec) => ({
                    title: sec.title,
                    rows: sec.rows.map(({ rowId, title, description }) => ({ rowId, title, description })),
                  }));
                  res = await greenApiSendListMessage(creds, chatId, im.text, im.buttonText, wireSections);
                }
                sentIdMessage = res.ok ? res.idMessage : undefined;
                if (!res.ok) {
                  // Interactive failed — fall back to plain text
                  const fallback = await greenApiSendMessage(creds, chatId, result.reply);
                  sentIdMessage = fallback.ok ? fallback.idMessage : undefined;
                }
              } else {
                const res = await greenApiSendMessage(creds, chatId, result.reply);
                sentIdMessage = res.ok ? res.idMessage : undefined;
              }
              lastSentReply = result.reply;
            }
            await supabaseAdmin.from("wa_messages").insert({
              conversation_id: convId,
              salon_id: salonId,
              direction: "out",
              kind: "text",
              text_body: result.reply,
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
            if (result.notifyAdmin && secrets.owner_notify_phone) {
              const ownerPhone = normalizeChatIdToPhone(secrets.owner_notify_phone);
              if (ownerPhone) {
                await greenApiSendFileByUrl(
                  creds,
                  `${ownerPhone}@c.us`,
                  result.notifyAdmin.mediaUrl,
                  "photo.jpg",
                  result.notifyAdmin.caption,
                );
                await supabaseAdmin
                  .from("wa_conversations")
                  .update({ ai_paused: true, ai_paused_at: new Date().toISOString() })
                  .eq("id", convId);
              }
            }

            // 6) Mark these inbound messages as processed
            await supabaseAdmin
              .from("wa_messages")
              .update({ processed_at: new Date().toISOString() })
              .in("id", freshPending.map((m: any) => m.id));

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
