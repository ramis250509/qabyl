// Official WhatsApp Cloud API webhook (one URL per salon), used via the Dualhook
// coexistence gateway. Mirrors the Green-API route's per-conversation lock + drain-loop
// state machine, but parses the Cloud API payload and sends interactive lists natively.
//
// Auth (both reuse salon_secrets.greenapi_webhook_token as a generic WhatsApp webhook token,
// so no new columns and no extra env var are needed for verification):
//   GET  — Meta subscription handshake: hub.verify_token must equal the salon's webhook token.
//   POST — per-salon token in ?token= must equal the salon's webhook token.
//
// Credentials to SEND replies:
//   - phone_number_id comes from the inbound payload's metadata (reply from the same number)
//   - access token from WA_CLOUD_ACCESS_TOKEN (WABA-level system-user token)
// so the only deployment secret is WA_CLOUD_ACCESS_TOKEN.
import { createFileRoute } from "@tanstack/react-router";
import {
  cloudApiSendText,
  cloudApiSendInteractive,
  normalizeChatIdToPhone,
  renderInteractiveAsText,
  runWaAgentV3,
  type CloudApiCreds,
  type WaAgentInput,
  type WaAgentState,
  type WaBranchInfo,
  type WaIncomingMessage,
} from "@/lib/wa-agent.server";
import { resolveAssistantRuntimeConfig } from "./wa.$salonId";

const LOCK_TTL_SECONDS = 25;
const MAX_LOOP_ITERATIONS = 3;
const LOCK_WAIT_TIMEOUT_MS = 8000;
const LOCK_POLL_INTERVAL_MS = 400;

type ParsedInbound = {
  phone: string;
  senderName: string | null;
  cloudMessageId: string | undefined;
  phoneNumberId: string | undefined;
  textBody: string | null;
  selectedId: string | null;
};

// Pull the single logical inbound message out of a Cloud API webhook payload. Returns null
// for anything we don't act on (status receipts, unsupported types, empty payloads).
function parseCloudInbound(payload: any): ParsedInbound | null {
  const change = payload?.entry?.[0]?.changes?.find((c: any) => c?.field === "messages");
  const value = change?.value;
  const msg = value?.messages?.[0];
  if (!msg) return null; // statuses-only or empty → nothing to process

  const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
  const contact = value?.contacts?.[0];
  const senderName: string | null = contact?.profile?.name ?? null;
  const rawFrom: string = msg.from ?? contact?.wa_id ?? "";
  const phone = normalizeChatIdToPhone(rawFrom);
  const cloudMessageId: string | undefined = msg.id;

  let textBody: string | null = null;
  let selectedId: string | null = null;
  const t = msg.type;
  if (t === "text") {
    textBody = msg.text?.body ?? null;
  } else if (t === "interactive") {
    const it = msg.interactive?.type;
    if (it === "list_reply") {
      selectedId = msg.interactive?.list_reply?.id ?? null;
      textBody = msg.interactive?.list_reply?.title ?? selectedId;
    } else if (it === "button_reply") {
      selectedId = msg.interactive?.button_reply?.id ?? null;
      textBody = msg.interactive?.button_reply?.title ?? selectedId;
    } else {
      return null;
    }
  } else if (t === "button") {
    // Legacy quick-reply button (from a template) — keep both the payload (button id)
    // and the visible text so the state machine can match either.
    selectedId = msg.button?.payload ?? null;
    textBody = msg.button?.text ?? selectedId;
  } else {
    // Unsupported (image/audio/location/…) — ack quietly for now.
    return null;
  }

  if (!phone) return null;
  return { phone, senderName, cloudMessageId, phoneNumberId, textBody, selectedId };
}

export const Route = createFileRoute("/api/public/wa-cloud/$salonId")({
  server: {
    handlers: {
      // Meta subscription verification handshake — hub.verify_token must equal this salon's
      // webhook token (the same token used in ?token= for POSTs).
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const verifyToken = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode !== "subscribe" || !verifyToken || !params.salonId) {
          return new Response("Forbidden", { status: 403 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: secrets } = await supabaseAdmin
          .from("salon_secrets")
          .select("greenapi_webhook_token")
          .eq("salon_id", params.salonId)
          .maybeSingle();
        if (secrets?.greenapi_webhook_token && verifyToken === secrets.greenapi_webhook_token) {
          return new Response(challenge ?? "", { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      },
      POST: async ({ request, params }) => {
        const salonId = params.salonId;
        const url = new URL(request.url);
        const token = url.searchParams.get("token") || request.headers.get("x-wa-token") || "";
        if (!salonId || !token) return new Response("Forbidden", { status: 403 });

        let payload: any = null;
        try {
          payload = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const ack = () => new Response("ok", { status: 200 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const [{ data: secrets }, { data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin
            .from("salon_secrets")
            .select("greenapi_webhook_token, owner_notify_phone")
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
              "enabled, greeting, tone_instructions, pricing_rules, languages, manage_cutoff_hours",
            )
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        if (!secrets?.greenapi_webhook_token || secrets.greenapi_webhook_token !== token) {
          return new Response("Forbidden", { status: 403 });
        }
        if (!salon) return ack();

        const parsed = parseCloudInbound(payload);
        if (!parsed) return ack();
        const { phone, senderName, cloudMessageId, textBody, selectedId } = parsed;

        const accessToken = process.env.WA_CLOUD_ACCESS_TOKEN ?? "";
        const phoneNumberId = parsed.phoneNumberId ?? "";
        if (!accessToken || !phoneNumberId) {
          console.error("[wa-cloud] missing access token or phone_number_id");
          return ack();
        }
        const creds: CloudApiCreds = { phoneNumberId, accessToken };

        // Assistant enabled? (missing assistant row defaults to enabled)
        const assistantEnabled =
          (salon as any)?.ai_assistant_enabled !== false && ((assistant as any)?.enabled ?? true);
        if (!assistantEnabled) return ack();

        const nowIso = new Date().toISOString();

        // ---- Load previous conversation (for session-gap logic), then upsert.
        const { data: existingConv } = await supabaseAdmin
          .from("wa_conversations")
          .select(
            "id, session_started_at, last_appointment_at, last_message_at, state, ai_paused, ai_paused_at",
          )
          .eq("salon_id", salonId)
          .eq("client_phone", phone)
          .maybeSingle();

        const previousLastMessageAt = existingConv?.last_message_at
          ? new Date(existingConv.last_message_at).getTime()
          : 0;
        const previousState = (existingConv?.state ?? "idle") as string;
        const inProgress = previousState !== "idle" && previousState !== "done";
        const sessionGapMs = inProgress ? 12 * 60 * 60 * 1000 : 20 * 60 * 1000;
        // See wa.$salonId.ts for why the old "already booked → force reset" condition was
        // dropped: it wiped state_data (incl. the post-booking Перенести/Отменить menu) on the
        // very next reply. state === "done" already routes to a fresh greeting on its own.
        const startsNewSession =
          !existingConv || (previousLastMessageAt ? Date.now() - previousLastMessageAt : 0) > sessionGapMs;

        const { data: conv, error: convErr } = await supabaseAdmin
          .from("wa_conversations")
          .upsert(
            {
              salon_id: salonId,
              client_phone: phone,
              client_name: senderName,
              last_message_at: nowIso,
              last_message_preview: (textBody ?? "[сообщение]").slice(0, 200),
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
          console.error("[wa-cloud] conv upsert failed", convErr);
          return ack();
        }
        const convId = (conv as any).id as string;

        // ---- Dedup by Cloud message id (stored in green_api_message_id) BEFORE insert.
        if (cloudMessageId) {
          const { data: dup } = await supabaseAdmin
            .from("wa_messages")
            .select("id")
            .eq("salon_id", salonId)
            .eq("green_api_message_id", cloudMessageId)
            .maybeSingle();
          if (dup) return ack();
        }

        await supabaseAdmin.from("wa_messages").insert({
          conversation_id: convId,
          salon_id: salonId,
          direction: "in",
          kind: "text",
          text_body: textBody,
          green_api_message_id: cloudMessageId ?? null,
          ...(selectedId ? { meta: { selected_id: selectedId } } : {}),
        });

        // ---- Respect the human-takeover pause (same mechanism as Green-API).
        const AI_PAUSE_MS = 60 * 60 * 1000;
        const pausedAtMs = existingConv?.ai_paused_at
          ? new Date(existingConv.ai_paused_at as string).getTime()
          : 0;
        if (existingConv?.ai_paused && pausedAtMs > 0 && Date.now() - pausedAtMs < AI_PAUSE_MS) {
          return ack();
        }
        if (existingConv?.ai_paused) {
          await supabaseAdmin
            .from("wa_conversations")
            .update({ ai_paused: false, ai_paused_at: null })
            .eq("id", convId);
        }

        // Brief debounce so rapid follow-up messages batch into one turn.
        await new Promise((r) => setTimeout(r, 700));

        const lockId = crypto.randomUUID();
        const acquired = await tryAcquireLockWithWait(supabaseAdmin, convId, lockId);
        if (!acquired) return ack();

        try {
          const { data: lockedConv } = await supabaseAdmin
            .from("wa_conversations")
            .select(
              "id, client_name, status, selected_branch_id, session_started_at, last_appointment_at, last_message_at, state, state_data",
            )
            .eq("id", convId)
            .maybeSingle();
          const convSnapshot: any = lockedConv ?? conv;

          const runtime = resolveAssistantRuntimeConfig(salon, assistant, secrets);

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
          let lastSentReply: string | null = null;

          for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
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

            const lastMessages: WaIncomingMessage[] = freshPending.map((m: any) => ({
              id: m.id,
              direction: "in",
              kind: m.kind as any,
              text_body: m.text_body,
              media_signed_url: null,
              media_path: m.media_path,
              created_at: m.created_at,
              selected_id: m.meta?.selected_id ?? null,
            }));

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
              console.error("[wa-cloud] runWaAgent threw", e?.message ?? e);
              const reply =
                "Извините, не получилось обработать запрос. Попробуйте, пожалуйста, ещё раз.";
              await cloudApiSendText(creds, phone, reply);
              await supabaseAdmin
                .from("wa_messages")
                .update({ processed_at: new Date().toISOString() })
                .in(
                  "id",
                  freshPending.map((m: any) => m.id),
                );
              await supabaseAdmin
                .from("wa_conversations")
                .update({ state: "idle", state_data: {} })
                .eq("id", convId);
              break;
            }

            // Send: interactive lists/buttons render natively on Cloud API; fall back to a
            // numbered-text menu only if the interactive send fails.
            const im = result.interactiveMessage;
            let sentText = im
              ? renderInteractiveAsText(
                  result.reply,
                  im,
                  ((result.nextStateData as any)?.language as "ru" | "ky" | "en") ?? "ru",
                )
              : result.reply;
            const dedupKey = (im ? `interactive:${result.reply}` : result.reply).trim();
            const isDuplicate = dedupKey === (lastSentReply ?? "").trim();
            let sentIdMessage: string | undefined;
            if (!isDuplicate) {
              if (im) {
                const res = await cloudApiSendInteractive(creds, phone, im);
                if (res.ok) {
                  sentIdMessage = res.idMessage;
                  sentText = result.reply;
                } else {
                  console.error(
                    "[wa-cloud] interactive send failed, falling back to text",
                    res.error,
                  );
                  const fb = await cloudApiSendText(creds, phone, sentText);
                  sentIdMessage = fb.ok ? fb.idMessage : undefined;
                }
              } else {
                const res = await cloudApiSendText(creds, phone, sentText);
                sentIdMessage = res.ok ? res.idMessage : undefined;
              }
              lastSentReply = dedupKey;
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
                provider: "cloud_api",
              } as any,
            });

            await supabaseAdmin
              .from("wa_messages")
              .update({ processed_at: new Date().toISOString() })
              .in(
                "id",
                freshPending.map((m: any) => m.id),
              );

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
            if (result.selectedBranchId !== curSelectedBranch)
              updates.selected_branch_id = result.selectedBranchId;
            await supabaseAdmin
              .from("wa_conversations")
              .update(updates as any)
              .eq("id", convId);

            curState = result.nextState;
            curStateData = result.nextStateData ?? {};
            curSelectedBranch = result.selectedBranchId;
          }
        } finally {
          try {
            await supabaseAdmin.rpc("wa_release_lock" as any, {
              _conversation_id: convId,
              _lock_id: lockId,
            });
          } catch (e) {
            console.error("[wa-cloud] lock release failed", e);
          }
        }

        return ack();
      },
    },
  },
});

async function tryAcquireLockWithWait(db: any, convId: string, lockId: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    const { data, error } = await db.rpc("wa_try_acquire_lock", {
      _conversation_id: convId,
      _lock_id: lockId,
      _ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (error) {
      console.error("[wa-cloud] lock rpc error", error);
      return false;
    }
    if (data === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
}
