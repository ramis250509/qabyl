// WhatsApp Cloud API webhook receiver: one URL per salon, the official replacement for the
// Green-API route next door (src/routes/api/public/wa.$salonId.ts).
//
// GET  — Meta's subscription handshake (hub.challenge), authenticated by the per-salon verify token.
// POST — message events, authenticated by X-Hub-Signature-256 over the RAW body. The verify token is
//        NOT sent on POSTs, so the app-secret signature is the only real auth on this path.
//
// THE OLD ROUTE IS NOT TOUCHED. Both live side by side, and salons.wa_provider decides which one is
// authoritative for a given salon. That is what makes this migration reversible: flipping the column
// back to 'green_api' restores the previous behaviour without a deploy.
//
// The processing model is deliberately identical to the Instagram route: take a per-conversation
// advisory lock, drain every unprocessed inbound message inside that window, run ONE agent turn over
// the merged burst, send one reply, persist state. Meta delivers in parallel and redelivers on any
// non-200, so a channel that skips this double-replies and races its own state writes.
//
// WHAT IS DIFFERENT FROM THE GREEN-API ROUTE, and why:
//   1. Media arrives as an *id*, not a URL — two Graph calls, the second of which must carry the
//      access token or Meta answers with an HTML page under HTTP 200.
//   2. Human takeover arrives on the `smb_message_echoes` field (coexistence onboarding) instead of
//      Green-API's `outgoingMessageReceived`. Same consequence, different envelope — and it needs an
//      ownership check the Green-API path never needed, because there the device echo could only
//      ever be a human.
//   3. V4 only. V3 answers with Green-API-specific interactive senders; pinning V4 avoids shipping a
//      channel where half the UI silently degrades. Same call as Instagram.
import { createFileRoute } from "@tanstack/react-router";
import {
  mapWaCloudDeliveryStatus,
  parseWaCloudEchoes,
  parseWaCloudWebhook,
  waCloudVerifySignature,
  type WaCloudInboundEvent,
} from "@/lib/wa-cloud.server";
import { cloudTransport, type WaTransport } from "@/lib/wa-transport.server";
import {
  acquireConversationLock,
  LOCK_HEARTBEAT_MS,
  refreshConversationLock,
  releaseConversationLock,
  stillHoldingConversationLock,
} from "@/lib/chat-lock.server";
import { runWaAgentV4 } from "@/lib/wa-agent-v4.server";
import { addExcludedContact, isExcludedContact } from "@/lib/excluded-contacts.server";
import {
  hasPersonalTag,
  isEngagedChat,
  looksLikeClientMessage,
  shouldHoldForOwner,
} from "@/lib/personal-chat";
import {
  greenApiSendMessage,
  isLikelyNativeGreetingRace,
  normalizeChatIdToPhone,
  renderInteractiveAsText,
  transcribeAudio,
  type WaAgentInput,
  type WaAgentState,
  type WaBranchInfo,
  type WaIncomingMessage,
} from "@/lib/wa-agent.server";
import { resolveAssistantRuntimeConfig } from "@/lib/assistant-runtime.server";

const MAX_LOOP_ITERATIONS = 3;
// See the Green-API route for the reasoning: clients type one thought as several short bubbles, and
// answering the half-typed first one produces a reply the assistant then has to correct.
const COALESCE_WINDOW_MS = 1500;
const COALESCE_WAIT_MS = 3500;
/**
 * Сколько раз за одно окно замка можно дождаться, пока клиент допишет пачку.
 *
 * Ограничение нужно, чтобы клиент, печатающий без остановки, не держал замок бесконечно:
 * потолок ожидания — MAX_COALESCE_WAITS × COALESCE_WAIT_MS, то есть 7 с при LOCK_TTL_SECONDS 180.
 */
const MAX_COALESCE_WAITS = 2;
/**
 * Второй ответ в том же окне замка повторяет первый?
 *
 * Проверка была побайтовой (`a.trim() === b.trim()`), и этого не хватало. В прогоне (B08) клиенту
 * ушло подряд «Как вас зовут?» и «Как вас зовут, пожалуйста?» — для строгого сравнения это разные
 * строки, для человека это один и тот же вопрос дважды.
 *
 * Считаем по словам, а не по символам: приводим к нижнему регистру, выкидываем пунктуацию и
 * эмодзи, сравниваем множества слов коэффициентом Дайса. Порог намеренно высокий (0.75) — глушить
 * непохожие ответы страшнее, чем пропустить похожий: клиент останется без нужной информации.
 *
 * ЧЕГО ЭТО НЕ ЛОВИТ. Тот же вопрос ДРУГИМИ словами («К кому записать?» против «К какому мастеру
 * вас записать?») — совпадение слов там низкое. Это уже про поведение модели, а не про строки, и
 * строковым сравнением не решается.
 */
export function looksLikeSameReply(a: string, b: string | null): boolean {
  if (!b) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const wa = new Set(norm(a));
  const wb = new Set(norm(b));
  if (wa.size === 0 || wb.size === 0) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return (2 * common) / (wa.size + wb.size) >= 0.75;
}

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PROBE_GAP_MS = 4000;
// How long the assistant stays quiet after a human answers. 5 min, matching both other channels —
// 90 s proved too short for a real human dialogue and the bot barged in mid-reply.
const AI_PAUSE_MS = 5 * 60 * 1000;
const STALE_MESSAGE_MS = 12 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export const Route = createFileRoute("/api/public/wacloud/$salonId")({
  server: {
    handlers: {
      // ---- Meta subscription handshake. Echoing hub.challenge in plain text is the whole protocol;
      // the only thing to check is that hub.verify_token matches what this salon stored.
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode !== "subscribe") return new Response("ok", { status: 200 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: secrets } = await supabaseAdmin
          .from("salon_secrets")
          .select("whatsapp_cloud_verify_token")
          .eq("salon_id", params.salonId)
          .maybeSingle();
        const expected = (secrets as any)?.whatsapp_cloud_verify_token ?? "";
        if (!expected || !safeStringEquals(expected, token)) {
          console.error(`[wacloud] verify handshake rejected for salon=${params.salonId}`);
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
        const log = (msg: string, ...rest: unknown[]) =>
          console.log(`[wacloud ${rid}] ${msg}`, ...rest);
        const errLog = (msg: string, ...rest: unknown[]) =>
          console.error(`[wacloud ${rid}] ${msg}`, ...rest);
        const t0 = Date.now();
        const ms = () => Date.now() - t0;

        // Always 200 once we have accepted responsibility for a payload. A non-200 makes Meta
        // redeliver the same batch for up to 36 h and, after enough failures, unsubscribe the app
        // from the field entirely — far worse than dropping one message.
        const ack = () => new Response("ok", { status: 200 });

        // Raw text, not request.json(): the signature is computed over the exact bytes Meta sent, so
        // re-serialising a parsed object produces a different digest.
        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const [{ data: secrets }, { data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin.from("salon_secrets").select("*").eq("salon_id", salonId).maybeSingle(),
          supabaseAdmin
            .from("salons")
            .select(
              "id, name, timezone, ai_assistant_enabled, whatsapp_ai_enabled, wa_provider, working_hours, address, slug, custom_domain",
            )
            .eq("id", salonId)
            .maybeSingle(),
          supabaseAdmin
            // select("*") — same reason as both sibling routes: this row keeps gaining columns, and
            // naming one a not-yet-migrated database lacks fails the WHOLE query, which would take
            // every reply for that salon down with it.
            .from("salon_ai_assistant")
            .select("*")
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        // Every refusal is recorded, not just console-logged. Debugging "the assistant did not
        // answer" hinges on one question — did Meta reach us at all? — and a Cloudflare log line the
        // owner cannot read does not answer it. These rows surface in /admin/errors.
        const record = async (message: string, context: Record<string, unknown> = {}) => {
          const { logError } = await import("@/lib/error-log.server");
          await logError({
            source: "wacloud-webhook",
            level: "warn",
            message,
            salonId,
            context: { rid, ...context },
          });
        };

        const s = (secrets ?? {}) as Record<string, any>;
        const appSecret = s.whatsapp_cloud_app_secret ?? "";
        // No app secret means this endpoint has no authentication at all — the URL contains only a
        // salon id, which is not a secret. Refuse rather than process attacker-supplied "client
        // messages" that would drive the assistant and burn the salon's Gemini budget.
        if (!appSecret) {
          await record("Webhook отклонён: App Secret Cloud API не заполнен в настройках салона");
          return new Response("Forbidden", { status: 403 });
        }
        const signature =
          request.headers.get("x-hub-signature-256") ?? request.headers.get("X-Hub-Signature-256");
        if (!(await waCloudVerifySignature(appSecret, rawBody, signature))) {
          await record("Webhook отклонён: неверная подпись X-Hub-Signature-256", {
            hasSignatureHeader: Boolean(signature),
          });
          return new Response("Forbidden", { status: 403 });
        }

        // Салон известен из адреса; у канала спрашиваем только одно — закреплён ли он за точкой.
        const { branchForSalonChannel } = await import("@/lib/channel-routing.server");
        const branchId = await branchForSalonChannel(supabaseAdmin as any, salonId, "whatsapp");

        return await processWaCloudPayload({
          salonId,
          rawBody,
          secrets,
          salon,
          assistant,
          branchId,
          rid,
        });
      },
    },
  },
});

/**
 * A message the salon sent from the WhatsApp Business app while the number is also on the Cloud API.
 *
 * Mirrors the `outgoingMessageReceived` branch of the Green-API route, including the one piece of
 * hard-won behaviour that route carries: the WhatsApp Business app's OWN native greeting/away
 * auto-reply is sent by the device, so it echoes exactly like a human typing. It fires within
 * milliseconds of the client's first message — long before our own reply lands — so treating every
 * echo as a takeover would pause the assistant on the first message of every new conversation.
 */
async function handleEcho(opts: {
  db: any;
  salonId: string;
  echo: import("@/lib/wa-cloud.server").WaCloudEchoEvent;
  log: (m: string, ...r: unknown[]) => void;
  errLog: (m: string, ...r: unknown[]) => void;
}): Promise<void> {
  const { db, salonId, echo, log, errLog } = opts;
  const phone = normalizeChatIdToPhone(echo.clientPhone);
  const nowIso = new Date().toISOString();

  // «#личный» с телефона: номер навсегда уходит в «Контакты без Админа». Раньше проверки ниже —
  // владелица может пометить и того, кому ассистент ещё ни разу не писал. See src/lib/personal-chat.ts.
  if (hasPersonalTag(echo.text)) {
    const added = await addExcludedContact(db, salonId, phone, "Отмечено с телефона: #личный");
    if (added.ok) log(`contact ${phone} excluded by the owner's #личный tag`);
    else errLog(`#личный: could not exclude ${phone}`, added.error);
  }

  const { data: conv } = await db
    .from("wa_conversations")
    .select("id, session_started_at")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .maybeSingle();
  // No conversation means the owner messaged someone the assistant has never spoken to. Nothing to
  // pause, and creating a row here would put a chat in the panel that the client never opened.
  if (!conv) return;

  // Redelivery, or — the case Meta says cannot happen but Instagram proved can — an echo of a
  // message WE sent through the API. Either way the wamid is already on a row of ours, and pausing
  // on our own reply mutes the assistant while the client writes into silence.
  if (echo.wamid) {
    const { data: known } = await db
      .from("wa_messages")
      .select("id, direction")
      .eq("salon_id", salonId)
      .eq("green_api_message_id", echo.wamid)
      .maybeSingle();
    if (known) {
      log(`echo ${echo.wamid} is already ours/known — no takeover`);
      return;
    }
  }

  const { data: priorBotReply } = await db
    .from("wa_messages")
    .select("id")
    .eq("conversation_id", conv.id)
    .eq("direction", "out")
    .eq("kind", "text")
    .gte("created_at", conv.session_started_at)
    .limit(1)
    .maybeSingle();
  const sessionAgeMs = Date.now() - new Date(conv.session_started_at).getTime();
  const suppressPause = isLikelyNativeGreetingRace({
    hasBotReplyThisSession: Boolean(priorBotReply),
    sessionAgeMs,
  });

  if (!suppressPause) {
    // Pausing is invisible from the outside — the client simply stops getting answers — so the one
    // thing that must never be silent is the decision itself.
    errLog(`human takeover from the WhatsApp app → AI paused for conv=${conv.id} (${echo.type})`);
    await db
      .from("wa_conversations")
      .update({ ai_paused: true, ai_paused_at: nowIso })
      .eq("id", conv.id);
  }

  // Stored as kind "system" — the exact shape both sibling routes look for when building
  // handoffContext, so the owner's words reach the assistant's next turn and it resumes knowing
  // what the human promised instead of contradicting it.
  await db.from("wa_messages").insert({
    conversation_id: conv.id,
    salon_id: salonId,
    direction: "out",
    kind: "system",
    text_body: echo.text,
    green_api_message_id: echo.wamid,
    processed_at: nowIso,
    meta: {
      echo: true,
      echo_type: echo.type,
      ...(suppressPause ? { suppressedAutoPause: true, sessionAgeMs } : {}),
    },
  });
}

/**
 * Persist one inbound event. Returns the conversation id when an agent turn should follow, or null
 * when the event was handled without needing the assistant (duplicate, rate-limited, excluded
 * contact, human takeover in progress, unusable media).
 */
async function ingestEvent(opts: {
  db: any;
  salonId: string;
  ev: WaCloudInboundEvent;
  tx: WaTransport;
  salon: any;
  assistant: any;
  /**
   * Каким транспортом пришёл диалог. По умолчанию облачный — так было, когда транспорт был один,
   * и так остаётся для моста Make: он говорит с тем же Cloud API, только чужими руками.
   * У Gupshup канал свой: WABA принадлежит салону, но разговаривает с Meta посредник, и в панели
   * администратора это должно быть видно как отдельный канал, а не как облако.
   */
  channel?: string;
  /** Точка канала. Проставляется новому диалогу, чтобы ассистент не спрашивал «в какой филиал». */
  branchId?: string | null;
  errLog: (m: string, ...r: unknown[]) => void;
}): Promise<string | null> {
  const { db, salonId, ev, tx, errLog } = opts;
  const channel = opts.channel ?? "whatsapp_cloud";
  const phone = normalizeChatIdToPhone(ev.fromPhone);
  const nowIso = new Date().toISOString();

  // Salon staff / personal numbers the owner never wants the assistant to answer. Earliest possible
  // bail — no Gemini spend, no reply, no conversation state touched. Fails closed on a lookup
  // error: see src/lib/excluded-contacts.server.ts.
  if (await isExcludedContact(db, salonId, phone, errLog)) return null;

  const [{ data: existingConv }, { data: dup }] = await Promise.all([
    db
      .from("wa_conversations")
      .select(
        "id, status, session_started_at, last_message_at, state, state_data, ai_paused, ai_paused_at, client_name",
      )
      .eq("salon_id", salonId)
      .eq("client_phone", phone)
      .maybeSingle(),
    ev.wamid
      ? db
          .from("wa_messages")
          .select("id")
          .eq("salon_id", salonId)
          .eq("green_api_message_id", ev.wamid)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (dup) return null; // Meta redelivery — already stored and answered

  // ---- Personal chat? Until the chat is a client conversation, the assistant answers only a message
  // that looks like a client's; the rest stays with the owner. See src/lib/personal-chat.ts.
  let chatAlreadyEngaged = false;
  if (existingConv?.id) {
    const { data: recent, error: recentErr } = await db
      .from("wa_messages")
      .select("direction, kind, meta")
      .eq("conversation_id", existingConv.id)
      .order("created_at", { ascending: false })
      .limit(50);
    // A failed read counts as engaged: staying silent to a client costs more than one reply to an
    // acquaintance.
    chatAlreadyEngaged = Boolean(recentErr) || isEngagedChat(recent ?? []);
  }

  // ---- Rate limit. Only probe when messages arrive back-to-back: at conversational pace a flood is
  // impossible, and skipping the COUNT saves a round-trip on virtually every real message.
  const prevMsgAtMs = existingConv?.last_message_at
    ? new Date(existingConv.last_message_at).getTime()
    : 0;
  if (existingConv?.id && prevMsgAtMs > 0 && Date.now() - prevMsgAtMs < RATE_LIMIT_PROBE_GAP_MS) {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { count } = await db
      .from("wa_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", existingConv.id)
      .eq("direction", "in")
      .gte("created_at", since);
    if ((count ?? 0) >= RATE_LIMIT_MAX) {
      errLog(`rate limit tripped: phone=${phone} conv=${existingConv.id} inbound=${count}`);
      return null;
    }
  }

  // A conversation idle long enough starts fresh, unless the client is mid-booking — losing a
  // half-finished booking to a lunch break is worse than an extra-long session. Same policy as both
  // sibling routes.
  const previousState = (existingConv?.state ?? "idle") as string;
  const inProgress = previousState !== "idle" && previousState !== "done";
  const sessionGapMs = inProgress ? 12 * 60 * 60 * 1000 : 20 * 60 * 1000;
  const startsNewSession =
    !existingConv || (prevMsgAtMs > 0 && Date.now() - prevMsgAtMs > sessionGapMs);

  // The WhatsApp profile name is attacker-controlled text that ends up in the assistant's prompt —
  // "Ignore previous instructions…" is free to set as a display name.
  const rawName = ev.profileName;
  const clientName = rawName
    ? rawName.replace(/[\n\r]/g, " ").slice(0, 60)
    : (existingConv?.client_name ?? null);

  const { data: conv, error: convErr } = await db
    .from("wa_conversations")
    .upsert(
      {
        salon_id: salonId,
        client_phone: phone,
        channel,
        client_name: clientName,
        last_message_at: nowIso,
        last_message_preview: (ev.text ?? "[фото]").slice(0, 200),
        ...(startsNewSession
          ? {
              status: "active",
              appointment_id: null,
              // Канал, закреплённый за точкой, отвечает на этот вопрос заранее: клиент написал
              // на номер конкретного филиала, спрашивать его «в какой филиал?» — значит делать
              // вид, что мы не знаем того, что знаем.
              selected_branch_id: opts.branchId ?? null,
              session_started_at: nowIso,
              state: "idle",
              state_data: {},
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

  // Blue ticks + «печатает…». Fired here, before the slow part of the turn, because that latency is
  // exactly what this fills. Not awaited — a cosmetic call must never delay the reply it announces.
  // Not in a chat that may be personal: blue ticks and «печатает…» followed by silence would tell
  // the owner's contact that a bot read their message.
  const mayHold =
    !chatAlreadyEngaged &&
    !ev.imageMediaId &&
    !looksLikeClientMessage({ text: ev.text, hasImage: false });
  if (ev.wamid && !mayHold) void tx.markReadAndTyping(ev.wamid);

  // ---- Media. The webhook carries an id, so the bytes come from Graph and are copied straight into
  // our own private bucket.
  let mediaPath: string | null = null;
  if (ev.imageMediaId) {
    const media = await tx.fetchMedia(ev.imageMediaId, MAX_MEDIA_BYTES);
    if (media && !looksLikeHtml(media.bytes, media.mime)) {
      const ext = (media.mime.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
      const path = `${salonId}/${convId}/${Date.now()}.${ext}`;
      const { error: upErr } = await db.storage
        .from("wa-media")
        .upload(path, media.bytes, { contentType: media.mime || "image/jpeg", upsert: false });
      if (upErr) errLog("media upload failed", upErr.message ?? upErr);
      else mediaPath = path;
    }

    // The client sent a picture and we could not fetch it. Letting the turn continue hands the model
    // a bare caption with no image attached, and it has been observed answering that with "Ваша
    // запись подтверждена" for a payment nobody verified. A picture we failed to download must end
    // the turn honestly instead of reaching the model at all.
    if (!mediaPath) {
      errLog(`image ${ev.imageMediaId} could not be fetched — asking the client to resend`);
      await db.from("wa_messages").insert({
        conversation_id: convId,
        salon_id: salonId,
        direction: "in",
        kind: "text",
        text_body: ev.text,
        green_api_message_id: ev.wamid,
        processed_at: new Date().toISOString(),
        meta: { image_download_failed: true },
      });
      await tx.sendText(
        phone,
        "Не получилось загрузить изображение 🙏 Пришлите, пожалуйста, ещё раз — обычным фото из галереи.",
      );
      return null;
    }
  }

  // ---- Voice note → text, with the same Gemini helper both other channels use, so a voice message
  // behaves like any other message from here on (history, agent, admin panel).
  let textBody = ev.text;
  if (!textBody && ev.audioMediaId) {
    const audio = await tx.fetchMedia(ev.audioMediaId, MAX_AUDIO_BYTES);
    // WhatsApp voice notes are OGG/Opus. Gemini rejects a mime type it does not recognise, and the
    // transcription then fails for a reason that has nothing to do with the recording.
    const audioMime =
      audio && /^audio\//i.test(audio.mime) ? audio.mime.split(";")[0].trim() : "audio/ogg";
    const tr =
      audio && !looksLikeHtml(audio.bytes, audio.mime)
        ? await transcribeAudio({
            apiKey: process.env.GEMINI_API_KEY ?? "",
            audioBase64: Buffer.from(audio.bytes).toString("base64"),
            mime: audioMime,
          })
        : ({ ok: false, error: "audio download failed" } as const);
    if (tr.ok && tr.text) {
      textBody = tr.text;
    } else {
      errLog(
        `voice transcription failed: ${(tr as any).error} (served=${audio?.mime ?? "n/a"} sent=${audioMime})`,
      );
      // Stored already-processed so the agent never picks up an empty message, and the admin still
      // sees that something arrived.
      await db.from("wa_messages").insert({
        conversation_id: convId,
        salon_id: salonId,
        direction: "in",
        kind: "text",
        text_body: null,
        green_api_message_id: ev.wamid,
        processed_at: new Date().toISOString(),
        meta: { voice: true, transcription_failed: true },
      });
      await tx.sendText(
        phone,
        "Извините, не получилось разобрать голосовое сообщение 🙏 Напишите, пожалуйста, текстом.",
      );
      return null;
    }
  }

  if (!textBody && !mediaPath) return null; // reaction, sticker, location — nothing to answer

  const hold = shouldHoldForOwner({
    chatAlreadyEngaged,
    text: textBody,
    hasImage: Boolean(mediaPath),
  });
  const meta = {
    ...(ev.interactiveReplyId ? { selected_id: ev.interactiveReplyId } : {}),
    ...(hold ? { personal_hold: true } : {}),
  };

  await db.from("wa_messages").insert({
    conversation_id: convId,
    salon_id: salonId,
    direction: "in",
    kind: mediaPath ? "image" : "text",
    text_body: textBody,
    media_path: mediaPath,
    green_api_message_id: ev.wamid,
    ...(Object.keys(meta).length ? { meta } : {}),
  });
  // A held message stays unprocessed on purpose and starts no turn. If a client-looking message
  // follows, its turn drains this one too — so a client whose bubbles Meta delivered out of order
  // still gets one reply that saw all of them. On its own it is never answered: wa-reconcile skips
  // personal_hold rows.
  if (hold) return null;

  // ---- A human is handling this chat right now: the message is stored (above) but stays pending,
  // so when the pause lapses it is picked up normally.
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

/**
 * Meta answers a media URL with an HTML page — a login or error screen, served with HTTP 200 —
 * whenever the request is not accepted as authenticated. Nothing about the status code says so,
 * which is how 147 KB of HTML once ended up in the media bucket labelled as a client's photo, and
 * how a voice note reached Gemini as a web page and came back "неразборчиво".
 */
function looksLikeHtml(bytes: Uint8Array, contentType: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64)).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

/** Drain every pending message for one conversation and answer the whole burst with one reply. */
async function runAgentTurn(opts: {
  db: any;
  salonId: string;
  convId: string;
  tx: WaTransport;
  salon: any;
  assistant: any;
  assistantConfig: any;
  secrets: any;
  log: (m: string, ...r: unknown[]) => void;
  errLog: (m: string, ...r: unknown[]) => void;
  record: (m: string, c?: Record<string, unknown>) => Promise<void>;
  ms: () => number;
  /** Точка канала: если канал принадлежит филиалу, остальные для этого разговора не существуют. */
  channelBranchId?: string | null;
}): Promise<void> {
  const {
    db,
    salonId,
    convId,
    tx,
    salon,
    assistant,
    assistantConfig,
    secrets,
    log,
    errLog,
    record,
    ms,
  } = opts;

  const lockId = crypto.randomUUID();
  if (!(await acquireConversationLock(db, convId, lockId))) {
    // Another worker owns this conversation; our message is queued (processed_at IS NULL) and that
    // worker will drain it.
    return;
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    const [{ data: conv }, { data: branchRows }] = await Promise.all([
      db
        .from("wa_conversations")
        .select(
          "id, client_name, client_phone, session_started_at, state, state_data, selected_branch_id",
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

    const clientPhone = conv.client_phone as string;

    let branches: WaBranchInfo[] = (branchRows ?? []).map((b: any) => ({
      id: b.id,
      name: b.name,
      address: b.address ?? null,
    }));
    let selectedBranchId: string | null = conv.selected_branch_id ?? null;
    // Super-admin pinned the assistant to one branch — same choke point as the other two routes:
    // replacing the branch list makes every other branch's masters, slots and appointments
    // unreachable without touching the engine.
    // Точка канала сильнее настройки ассистента: клиент написал на номер конкретного филиала,
    // и предлагать ему записаться в другой — значит отправить его не туда, куда он пришёл.
    const pinnedBranchId =
      opts.channelBranchId ??
      ((assistant as any)?.assistant_branch_id as string | null | undefined);
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
    let coalesceWaits = 0;

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
          .in(
            "id",
            stale.map((m: any) => m.id),
          );
      }
      if (fresh.length === 0) continue;

      // Дождаться, пока пачка договорит, и ответить на неё ОДИН раз.
      //
      // Раньше ждали ровно однажды за всё окно замка (settledThisPass). Клиент, который пишет
      // словами по отдельному пузырю, успевал дописать уже ПОСЛЕ этого единственного ожидания —
      // и догоняющие пузыри получали собственный ответ. В прогоне (B08) это выглядело так:
      //   «…есть окошки на 17:00, 18:00 и 19:00. Какое подойдёт?»
      //   «Хорошо, на завтра в 18:00 есть свободное время. Вас записать?»
      // два сообщения подряд, оба от «администратора», второе отвечает на то, чего клиент ещё не
      // говорил. Для клиента это самый явный признак бота.
      //
      // Теперь ждём столько раз, сколько клиент продолжает дописывать, но не больше
      // MAX_COALESCE_WAITS — иначе бесконечно печатающий клиент держал бы замок.
      //
      // Ожидание НЕ тратит проход обработки (iter--): иначе лечение дублей отняло бы итерации у
      // слива очереди и превратилось бы во второй баг — потерянные сообщения.
      if (coalesceWaits < MAX_COALESCE_WAITS) {
        const newestMs = Math.max(...fresh.map((m: any) => new Date(m.created_at).getTime()));
        if (Date.now() - newestMs < COALESCE_WINDOW_MS) {
          coalesceWaits++;
          iter--;
          await new Promise((r) => setTimeout(r, COALESCE_WAIT_MS));
          continue;
        }
      }

      const lastMessages: WaIncomingMessage[] = await Promise.all(
        fresh.map(async (m: any) => {
          let signed: string | null = null;
          if (m.kind === "image" && m.media_path) {
            const { data: sg } = await db.storage
              .from("wa-media")
              .createSignedUrl(m.media_path, 600);
            signed = sg?.signedUrl ?? null;
          }
          return {
            id: m.id,
            direction: "in",
            kind: m.kind,
            text_body: m.text_body,
            media_signed_url: signed,
            media_path: m.media_path,
            created_at: m.created_at,
            selected_id: m?.meta?.selected_id ?? null,
          } as WaIncomingMessage;
        }),
      );

      // V4 keeps its own transcript in state_data.v4_history, so the only extra context it needs is
      // what a live admin said during a takeover — otherwise the assistant resumes and contradicts
      // the human. On this channel that admin may be typing on their own phone (coexistence), which
      // is exactly what handleEcho stored as kind "system".
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
          slug: salon.slug ?? null,
          customDomain: salon.custom_domain ?? null,
        },
        config: assistantConfig,
        client: { phone: clientPhone, name: conv.client_name ?? null },
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
          source: "wacloud-webhook",
          message: `runWaAgentV4 threw: ${e?.message ?? String(e)}`,
          error: e,
          salonId,
          context: { convId, clientPhone },
        });
        const reply = "Извините, не получилось обработать запрос. Попробуйте, пожалуйста, ещё раз.";
        const sent = await tx.sendText(clientPhone, reply);
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
          .in(
            "id",
            fresh.map((m: any) => m.id),
          );
        await db
          .from("wa_conversations")
          .update({ state: "idle", state_data: {} })
          .eq("id", convId);
        break;
      }

      // Last-line check before ANY visible side effect: if the lock lapsed mid-turn and another
      // worker took over, its turn is authoritative and ours must be dropped — otherwise the client
      // gets the same answer twice in two different wordings.
      if (!(await stillHoldingConversationLock(db, convId, lockId))) {
        errLog(`lock lost mid-turn (conv=${convId}) — dropping reply to avoid a double message`);
        break;
      }

      // The Cloud API does support interactive buttons and lists, unlike Instagram — but the V4
      // engine is the only one wired to this channel and it produces prose, so an interactive
      // message can only reach here via the shared engine contract. Flattening it into the numbered
      // text form keeps the reply correct rather than dropping the options entirely.
      const im = result.interactiveMessage;
      const sentText = im
        ? renderInteractiveAsText(
            result.reply,
            im,
            ((result.nextStateData as any)?.language as "ru" | "ky" | "en") ?? "ru",
          )
        : result.reply;

      const isDuplicateReply = looksLikeSameReply(sentText, lastSentReply);
      let sentMessageId: string | undefined;
      const tAgentDone = ms();
      if (!isDuplicateReply) {
        const res = await tx.sendText(clientPhone, sentText);
        if (!res.ok) {
          // THE failure that matters: the assistant did its work and Meta refused to deliver it.
          // Meta's own code is carried through verbatim because the fix differs completely per code
          // — 131047 needs a template, 190 a new token, 131026 a different number.
          await record(`WhatsApp отклонил отправку ответа: ${res.error}`, { convId });
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
          // What each tool was asked and answered — the evidence for "why was this client booked
          // at that time". Compact by construction (see compactToolResult).
          tool_trace: result.debug.toolTrace ?? undefined,
          state: result.nextState,
          duplicateSuppressed: isDuplicateReply || undefined,
        },
      });

      // Payment QR after the text: the client should read the amount and the deadline before the
      // image lands. Unlike Instagram, WhatsApp carries the caption on the image itself, so this is
      // one bubble rather than two. Best-effort — the text already carries the requisites.
      if (result.sendMedia?.url) {
        const qrRes = await tx.sendImage(
          clientPhone,
          result.sendMedia.url,
          result.sendMedia.caption,
        );
        if (!qrRes.ok)
          await record(`WhatsApp отклонил отправку QR-кода оплаты: ${qrRes.error}`, { convId });
        await db.from("wa_messages").insert({
          conversation_id: convId,
          salon_id: salonId,
          direction: "out",
          kind: "image",
          text_body: result.sendMedia.caption ?? null,
          green_api_message_id: qrRes.ok ? (qrRes.messageId ?? null) : null,
          meta: { paymentQr: true, sendError: qrRes.ok ? undefined : qrRes.error },
        });
      }

      // Escalation: alert the salon and pause the assistant so a human can step in. De-duplicated
      // over 4 h so a client who keeps writing can't spam the owner with the same alert.
      if (result.notifyAdminText) {
        const lastEscalatedAt = (stateData as any)?.last_escalated_at as string | undefined;
        const recentlyAlerted =
          lastEscalatedAt && Date.now() - new Date(lastEscalatedAt).getTime() < 4 * 60 * 60 * 1000;
        if (!recentlyAlerted) {
          await notifyOwner({ db, salonId, secrets, tx, text: result.notifyAdminText });
          (result.nextStateData as any) = {
            ...(result.nextStateData ?? {}),
            last_escalated_at: new Date().toISOString(),
          };
        }
      }

      await db
        .from("wa_messages")
        .update({ processed_at: new Date().toISOString() })
        .in(
          "id",
          fresh.map((m: any) => m.id),
        );

      const updates: Record<string, any> = {
        last_message_at: new Date().toISOString(),
        last_message_preview: sentText.slice(0, 200),
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
 * The owner's alert goes over the salon's own Cloud API number when possible. That send is
 * business-initiated and therefore subject to the 24-hour window: if the owner has not written to
 * the business number recently, Meta rejects it with 131047 and the alert would be lost. So a failed
 * send falls back to the notifications table, exactly as the other two routes do — an escalation is
 * the salon's safety net and must never disappear silently.
 */
async function notifyOwner(opts: {
  db: any;
  salonId: string;
  secrets: any;
  tx: WaTransport;
  text: string;
}): Promise<void> {
  const { db, salonId, secrets, tx, text } = opts;
  const persistFallback = async (why: string) => {
    try {
      await db.from("notifications").insert({
        salon_id: salonId,
        type: "wa.escalation",
        title: "Клиенту нужен администратор",
        body: `${text}\n\n[WhatsApp не доставлен: ${why}]`.slice(0, 2000),
      });
    } catch (e: any) {
      console.error(`[wacloud] notifyOwner fallback insert failed: ${e?.message ?? e}`);
    }
  };

  const ownerPhone = secrets?.owner_notify_phone
    ? normalizeChatIdToPhone(secrets.owner_notify_phone)
    : "";
  if (!ownerPhone) {
    await persistFallback("номер владельца не указан в настройках салона");
    return;
  }

  const res = await tx.sendText(ownerPhone, text);
  if (res.ok) return;

  // While the salon still has a working Green-API instance (the hybrid period — see
  // docs/WA-CLOUD-MIGRATION.md), it is a perfectly good second chance at reaching the owner, and
  // it is not bound by Meta's 24-hour window.
  if (secrets?.greenapi_instance && secrets?.greenapi_token) {
    const viaGreen = await greenApiSendMessage(
      { instance: secrets.greenapi_instance, token: secrets.greenapi_token },
      `${ownerPhone}@c.us`,
      text,
    );
    if (viaGreen.ok) return;
    await persistFallback(`Cloud API: ${res.error}; Green-API: ${viaGreen.error}`);
    return;
  }
  await persistFallback(res.error ?? "неизвестная ошибка Cloud API");
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

/**
 * Обработка полезной нагрузки Cloud API для одного салона.
 *
 * Вынесено из обработчика маршрута, потому что вебхуков теперь два и они отличаются только тем,
 * КАК находят салон и ЧЕЙ секрет проверяют:
 *   • /api/public/wacloud/$salonId — салон в адресе, подпись по его собственному app secret.
 *     Так подключены салоны со своим приложением Meta.
 *   • /api/public/wacloud — общий вебхук приложения Qabyl: салон ищется по phone_number_id из
 *     самой полезной нагрузки, подпись проверяется секретом платформы. Сюда попадают все, кто
 *     подключился через Embedded Signup.
 * Всё, что происходит ПОСЛЕ опознания салона, одинаково — и живёт здесь.
 *
 * Аутентификация остаётся на стороне вызывающего: сюда payload попадает уже с проверенной
 * подписью. Функция сама по себе никого не пускает.
 */
export async function processWaCloudPayload(opts: {
  salonId: string;
  rawBody: string;
  secrets: Record<string, any> | null | undefined;
  salon: any;
  assistant: any;
  /** Короткий идентификатор запроса — сшивает строки логов одного вебхука. */
  rid: string;
  /**
   * Разговоры, которые нужно прогнать, даже если в этой доставке для них ничего нет.
   *
   * Единственный потребитель — перезапуск потерянных сообщений (wa-reconcile.server.ts). Вебхук
   * Meta приходит один раз, и если тот запрос упал, сообщение клиента остаётся необработанным
   * навсегда. Повторно «доставить» его нельзя: дедупликация по wamid справедливо считает его
   * дублем и ничего не запускает. Поэтому перезапуск не притворяется доставкой, а честно говорит,
   * какие разговоры прогнать — дальше всё идёт обычным путём: замок, слив очереди, агент.
   */
  forceConversationIds?: string[];
  /**
   * Чем отвечать клиенту. По умолчанию — Cloud API на реквизитах салона; маршрут моста
   * подставляет сюда Make. Пайплайн ниже про это не знает и знать не должен.
   */
  transport?: WaTransport;
  /**
   * Значение wa_conversations.channel для новых диалогов этого маршрута.
   *
   * Мост Make его не задаёт намеренно: он разговаривает с тем же Cloud API салона, просто чужими
   * руками, и заводить ему отдельный канал значило бы разделить историю одного и того же номера
   * надвое при снятии моста. У Gupshup случай другой — там и провайдер другой, и реквизиты
   * другие, поэтому канал свой.
   */
  channel?: string;
  /**
   * Точка, за которой закреплён канал. NULL — канал общий на сеть, ассистент спросит клиента.
   *
   * Приходит из salon_channels (см. channel-routing.server.ts). Дальше работает тем же
   * механизмом, что и закрепление ассистента за филиалом из настроек: список точек сужается до
   * одной, и всё остальное — услуги, мастера, свободное время, запись — берётся только из неё.
   */
  branchId?: string | null;
}): Promise<Response> {
  const { salonId, rawBody, secrets, salon, assistant, rid } = opts;
  const log = (msg: string, ...more: unknown[]) => console.log(`[wacloud ${rid}] ${msg}`, ...more);
  const errLog = (msg: string, ...more: unknown[]) =>
    console.error(`[wacloud ${rid}] ${msg}`, ...more);
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const ack = () => new Response("ok", { status: 200 });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const record = async (message: string, context: Record<string, unknown> = {}) => {
    const { logError } = await import("@/lib/error-log.server");
    await logError({
      source: "wacloud-webhook",
      level: "warn",
      message,
      salonId,
      context: { rid, ...context },
    });
  };
  const s = (secrets ?? {}) as Record<string, any>;

  if (!salon) return ack();

  // Здесь стояла отбраковка по salons.wa_provider: пока существовал Green-API, ответ сразу из
  // двух движков присылал бы клиенту два сообщения. Транспорт удалён — второго движка больше
  // нет, а колонку никто не мигрировал, и она осталась в 'green_api' у ВСЕХ салонов. То есть
  // проверка перестала защищать и стала ронять каждое входящее сообщение в тишину: салон
  // подключён, Meta доставляет, в переписке пусто.
  //
  // Салон здесь уже опознан по whatsapp_cloud_phone_number_id из salon_secrets — то есть у него
  // заведены реквизиты Cloud API. Другого способа сюда попасть нет, и отдельное подтверждение
  // «а точно ли он на Cloud» ничего не добавляет.

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (payload?.object && payload.object !== "whatsapp_business_account") return ack();

  const tx =
    opts.transport ??
    cloudTransport({
      phoneNumberId: s.whatsapp_cloud_phone_number_id ?? "",
      token: s.whatsapp_cloud_token ?? "",
    });

  const { events, statuses } = parseWaCloudWebhook(payload);
  // Echoes ride the SAME URL under a different field, so both parsers run over every payload
  // and either may come back empty.
  const { echoes } = parseWaCloudEchoes(payload);
  if (events.length === 0 && statuses.length === 0 && echoes.length === 0) return ack();

  // ---- Delivery outcomes for messages WE sent. The honest replacement for a pre-booking
  // "is this number on WhatsApp" probe: the provider reports what actually happened after the
  // send, instead of us predicting it beforehand.
  for (const st of statuses) {
    const mapped = mapWaCloudDeliveryStatus(st.status, st.errorCode);
    if (!mapped) continue;
    const { error: markErr } = await supabaseAdmin
      .from("appointments")
      .update({
        confirmation_status: mapped.status,
        confirmation_detail: mapped.detail,
        confirmation_at: new Date().toISOString(),
      } as any)
      .eq("salon_id", salonId)
      .eq("confirmation_message_id", st.wamid);
    if (markErr) errLog("delivery status update failed", markErr);
    else log(`delivery ${st.status} → ${mapped.status} for ${st.wamid}`);
    // A failed send is the owner's problem to see, not just ours.
    if (mapped.status === "failed") {
      await record(
        `Сообщение не доставлено: ${mapped.detail ?? st.error ?? "причина неизвестна"}`,
        {
          wamid: st.wamid,
          recipient: st.recipientPhone,
        },
      );
    }
  }

  // ---- Human takeover (coexistence): the owner answered from their phone.
  for (const echo of echoes) {
    await handleEcho({ db: supabaseAdmin, salonId, echo, log, errLog });
  }

  const forced = opts.forceConversationIds ?? [];
  if (events.length === 0 && forced.length === 0) return ack();

  // ---- Ingest each client message, then run at most one agent turn per conversation.
  const toRun = new Set<string>(forced);
  for (const ev of events) {
    const convId = await ingestEvent({
      db: supabaseAdmin,
      salonId,
      ev,
      tx,
      salon,
      assistant,
      channel: opts.channel,
      branchId: opts.branchId ?? null,
      errLog,
    });
    if (convId) toRun.add(convId);
  }

  // "whatsapp" жёстко: через эту функцию проходят все три WhatsApp-маршрута (своё приложение
  // салона, общее приложение Qabyl, мост Gupshup) и ни одного другого канала.
  const runtime = resolveAssistantRuntimeConfig(salon, assistant, secrets, "whatsapp");
  if (!runtime.assistantEnabled) return ack();

  // Биллинг: салон, заблокированный за неоплату или исчерпавший сообщения тарифа, ассистентом не
  // отвечает. Сообщения клиентов при этом уже сохранены выше — владелец видит их в переписках и
  // на телефоне. Ворота сами пробуют автодокупку и при любой своей ошибке пропускают (fail-open).
  {
    const { assistantGate, recordUsage } = await import("@/lib/billing.server");
    const gate = await assistantGate(salonId);
    if (!gate.allowed) {
      await record(`Ассистент не ответил: ${gate.reason}`);
      return ack();
    }
    // Режим продаж входит не во все тарифы: выключаем его на этот ответ, настройку салона не трогаем.
    if (gate.features && !gate.features.sales_mode) runtime.assistantConfig.sales_mode = false;
    if (toRun.size) await recordUsage(salonId, "ai_reply", toRun.size);
  }
  if (!tx.ready) {
    await record(`Ассистент не может ответить: не заполнено — ${tx.missing}`);
    return ack();
  }

  for (const convId of toRun) {
    await runAgentTurn({
      db: supabaseAdmin,
      salonId,
      convId,
      tx,
      salon,
      assistant,
      assistantConfig: runtime.assistantConfig,
      secrets,
      log,
      errLog,
      record,
      ms,
      channelBranchId: opts.branchId ?? null,
    });
  }

  return ack();
}
