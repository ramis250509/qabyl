// WhatsApp assistant — server-only.
// Direct Google AI Studio (Gemini API) integration + explicit state machine.
// No Lovable Gateway, no tool-loop hallucinations — deterministic TS code drives
// services/masters/slots from DB; Gemini only classifies intent and renders text.

import { type PhotoPricingConfig, type PhotoClassification } from "./photo-pricing";

type AdminClient = Awaited<ReturnType<typeof getAdmin>>;
async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

// Public base URL for the client's self-service booking link. Read per-call (Cloudflare binds
// env at request time); production default is qabyl.com.
function appBaseUrl(): string {
  try {
    return (process.env.PUBLIC_APP_URL ?? "https://qabyl.com").replace(/\/+$/, "");
  } catch {
    return "https://qabyl.com";
  }
}

// Look up a freshly-created appointment's manage_token and build its self-service URL. Best-effort:
// a failure here must never break the booking confirmation, so it returns null on any error.
async function fetchManageUrl(db: AdminClient, appointmentId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("appointments")
      .select("manage_token")
      .eq("id", appointmentId)
      .maybeSingle();
    const token = (data as any)?.manage_token as string | undefined;
    return token ? `${appBaseUrl()}/manage/${token}` : null;
  } catch {
    return null;
  }
}

// "I'll go check / one moment" filler the client must never see (see the v4 twin). v3 already
// builds the full answer in `factual` before composing, so this is a defense-in-depth catch on
// the rare case Gemini prepends filler while phrasing — we then render `factual` deterministically.
const V3_STALL_RE =
  /(сейчас\s+(проверю|гляну|узна|посмотрю|уточню|выясню|определю|подберу|рассчита|загляну)|\b(проверю|проверяю|уточняю|уточню|выясняю|посмотрю|гляну|подберу)\b|секундоч|минуточ|минутку|подожд|обожд|ожидайте|одну\s+секунд|азыр\s+(текшер|кара|көр|бил)|текшерип\s+көр|күтө\s+тур|бир\s+аз\s+күт|let me (check|see)|one moment|hold on|bear with)/i;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Note: gemini-1.5-* models were retired on Sept 24, 2025 → 404 on new API keys.
//
// Модель переопределяется переменной окружения, но ПО УМОЛЧАНИЮ не меняется. Понадобилось это
// не ради продакшна, а ради прогонов на бесплатном ключе: там суточная квота считается ОТДЕЛЬНО
// НА КАЖДУЮ МОДЕЛЬ (около 20 запросов), поэтому единственный способ прогнать что-то бесплатно —
// развести ассистента, симулированного клиента и судью по разным моделям. Прод продолжает ходить
// на gemini-2.5-flash, пока переменная не задана.
const MODEL_TEXT = process.env.GEMINI_MODEL_TEXT || "gemini-2.5-flash";
const MODEL_VISION = process.env.GEMINI_MODEL_VISION || "gemini-2.5-flash";

// How many free slots we offer for a chosen day. High enough to show a full working day
// (grouped into Утром/День/Вечер), since the client explicitly wants every free time — the
// numbered-text menu has no WhatsApp 10-row cap, unlike a native interactive list.
const MAX_SLOTS_SHOWN = 48;

// ============================================================
// Public types
// ============================================================

export type WaIncomingMessage = {
  id: string;
  direction: "in" | "out";
  kind: "text" | "image" | "system";
  text_body: string | null;
  media_signed_url?: string | null;
  media_mime?: string | null;
  media_path?: string | null;
  created_at: string;
  selected_id?: string | null; // V3: button/list selection rowId or buttonId
};

export type WaAssistantConfig = {
  greeting: string | null;
  tone_instructions: string | null;
  pricing_rules: string | null;
  languages: string[];
  // V4: free-text salon facts (parking, payment, promos…) injected into the agent's
  // system prompt so it can answer arbitrary questions about the salon. Reference
  // material only — the model treats these as "context to quote", not as behaviour rules.
  knowledge_base?: string | null;
  // V4: imperative behaviour rules the salon owner wants the assistant to follow
  // ("always list prices before asking for a day", "never suggest another day
  // if the client asked for tomorrow", etc.). Injected in the OVERRIDES block at
  // the end of the system prompt and marked [ПРАВИЛО] — outranks generic rules.
  ai_rules?: string | null;
  // V4: opt-in "красивое оформление" (migration 20260812120000). Off by default, and off means
  // today's behaviour: the prompt forbids lists/markdown and humanizeReply() flattens whatever
  // the model produces anyway. On, the assistant may use bullets, line breaks and several emoji,
  // and the post-processor leaves that structure alone. Without this flag an owner asking for
  // lists in ai_rules could never get them — the generic FORMAT rule and the post-processor
  // both out-ranked the setting.
  rich_formatting?: boolean | null;
  // V4: how clients typically address the admin (Айка, Эже, Админ…) — context only, so the
  // agent recognises such a message is directed at it and doesn't ask "к кому вы обращаетесь?".
  client_addressing?: string | null;
  // Salon-configured deadline: cancel/reschedule via the bot is refused when the visit
  // starts in less than this many hours (0 / null = no limit, client asked to call the salon).
  manage_cutoff_hours?: number | null;
  // V4: business vertical — selects the assistant persona and expert knowledge base
  // (beauty | barbershop | massage | cosmetology | epilation | dental). Default 'beauty'.
  industry?: string | null;
  // V4: answers to the industry-specific "knowledge book" questions, keyed by question id
  // (see src/lib/industries.ts). Rendered into the system prompt as labelled salon facts.
  knowledge_answers?: Record<string, string> | null;
  // V4: which of the two sales styles the owner chose — 'light' (default: calm consulting,
  // booking offered when the conversation leads there) or 'active' (need diagnosis, objection
  // work, drives to a booking and, where configured, a prepayment). Medical/safety boundaries
  // and the facts the assistant may state are identical in both. V4 only.
  sales_style?: string | null;
  /**
   * Legacy boolean that 'sales_style' replaced (migration 20260812150000). Still read as a
   * fallback so a config assembled from an older row — or an older cached payload — keeps the
   * behaviour its owner picked: true means 'active'.
   */
  sales_mode?: boolean | null;
  // V5 sales playbook (salon_ai_assistant.sales_* columns, migration 20260810120000).
  // Raw JSONB as it comes out of the DB — parseSalesPlaybook() in sales-playbook.server.ts
  // normalises it. Kept raw here so a malformed value can never break the transport layer.
  sales_usp?: unknown;
  sales_objections?: unknown;
  sales_promos?: unknown;
  // off | auto | eager — how freely the assistant may hand out the online-booking link.
  booking_link_mode?: string | null;
  // Language the assistant OPENS a conversation in, before the client has produced a
  // confident language signal (migration 20260811120000). Only decides the first move —
  // the agent still adapts to whatever the client actually writes, exactly as before.
  start_language?: string | null;
  // Two-step selling: the cheap first step the assistant routes to in chat, instead of pitching
  // an expensive programme a lead will never buy from a DM. NULL = book what was asked about.
  entry_service_id?: string | null;
  // Owner-written explanation of what a large price covers. Injected verbatim so the assistant
  // never does arithmetic on prices or invents an instalment plan.
  sales_price_framing?: string | null;
};

export type WaSalonContext = {
  salonId: string;
  salonName: string;
  timezone: string;
  // Public-booking identity. Only needed by the send_booking_link tool, hence optional:
  // every existing caller that doesn't pass it simply has no link to send.
  slug?: string | null;
  customDomain?: string | null;
};

export type WaBranchInfo = {
  id: string;
  name: string;
  address: string | null;
};

export type WaAgentState =
  | "idle"
  | "awaiting_branch"
  | "collecting"
  | "awaiting_category" // V3: shown when a salon has more services than fit one 10-row list
  | "awaiting_service" // V3
  | "awaiting_photo"
  // Prepayment: the slot is held and we are waiting for the client to send a
  // payment receipt. While in this state an inbound image is treated as a
  // receipt and never as a "I want this hairstyle" reference photo.
  | "awaiting_receipt"
  | "awaiting_price_confirm"
  | "awaiting_date_choice" // V3
  | "awaiting_part_of_day"
  | "awaiting_slot_choice"
  | "awaiting_master_choice"
  | "awaiting_name"
  | "awaiting_final_confirm"
  | "awaiting_manage_choice" // V3: client has 2+ upcoming appointments, pick which one
  | "awaiting_manage_action" // V3: cancel / reschedule / leave alone
  | "awaiting_reschedule_date" // V3
  | "awaiting_reschedule_slot" // V3
  | "awaiting_manage_confirm" // V3: final yes/no before applying cancel or reschedule
  | "done";

export type WaAgentStateData = {
  service_id?: string;
  service_name?: string;
  service_price_type?: "fixed" | "range";
  priced_value?: number;
  price_skipped?: boolean; // Vision pricing failed → master prices on site, don't re-ask for a photo
  branch_id?: string | null;
  day?: string; // YYYY-MM-DD local to salon tz
  part_of_day?: "morning" | "afternoon" | "evening";
  specific_time?: string; // HH:MM — persisted so a stated time survives across turns
  slot_start?: string; // ISO
  slot_end?: string;
  candidate_master_ids?: string[];
  master_id?: string;
  master_name?: string;
  client_name?: string;
  language?: "ru" | "ky" | "en";
  last_prompt?: string; // key of the last question we asked, to avoid verbatim loops
  greeted?: boolean; // we have already greeted the client in this session → never greet twice
  reask_count?: number; // consecutive turns we re-asked the SAME question after an unrecognized reply
  needs_human?: boolean; // bot gave up after repeated confusion → conversation flagged for a live admin
  // Prepayment hold awaiting a receipt. Set when create_appointment booked through
  // create_appointment_with_prepayment; the webhook reads it to route the client's
  // next photo into the receipt verifier instead of the agent.
  prepayment_appointment_id?: string;
  prepayment_amount?: number;
  prepayment_currency?: string;
  prepayment_hold_expires_at?: string; // ISO
  // The payment QR was already delivered for this hold — never send the same image twice
  // in one conversation (a second QR reads as "the first one didn't work").
  prepayment_qr_sent_for?: string; // appointment id
  // Where this client came from, when it wasn't a cold DM — today set by the Instagram
  // comment→DM trigger ("написал ЦЕНА под постом про кератин"). Rendered into the system
  // prompt so the assistant continues that thread instead of greeting a stranger.
  entry_context?: string;
  // Sales governor (see sales-playbook.server.ts → SalesTurnState). Counts how many times
  // we pushed for a booking without the client advancing, which objections were already
  // handled, and when the online-booking link was last sent.
  sales?: {
    closeAttempts: number;
    handled: string[];
    slotRounds: number;
    bookingLinkSentAt?: string | null;
  };
};

export type WaSalonInfo = {
  working_hours: Record<string, string> | null; // { mon: "10:00–20:00", sun: "Выходной", ... }
  address: string | null;
};

export type WaAgentInput = {
  salon: WaSalonContext;
  config: WaAssistantConfig;
  // Transport this conversation arrived on. Absent = WhatsApp (every pre-Instagram caller).
  // The agent is channel-agnostic except for one thing: on WhatsApp the client's phone number
  // comes free with the transport, on Instagram it does not exist at all — so the assistant has
  // to ask for it before it can create an appointment (appointments require a real phone).
  channel?: "whatsapp" | "instagram";
  // On Instagram this is "" until the client tells us their number; the agent then collects it
  // and it is persisted into state_data.client_phone for subsequent turns.
  client: { phone: string; name: string | null };
  history: WaIncomingMessage[];
  lastMessages: WaIncomingMessage[]; // unprocessed inbound messages merged into this turn
  branches: WaBranchInfo[];
  selectedBranchId: string | null;
  state: WaAgentState;
  stateData: WaAgentStateData;
  salonInfo?: WaSalonInfo | null; // optional: for schedule/address questions
  // V4: text of any manual messages the live salon admin sent the client in this session (kind=
  // system, direction=out). Injected into the prompt so that when the AI resumes after a takeover
  // pause it knows what the human already told the client and never contradicts them.
  handoffContext?: string[];
};

export type WaInteractiveMessage =
  | { kind: "buttons"; text: string; buttons: Array<{ id: string; text: string }> }
  | {
      kind: "list";
      text: string;
      buttonText: string;
      sections: Array<{
        title?: string;
        rows: Array<{ rowId: string; title: string; description?: string; fullName?: string }>;
      }>;
    };

export type WaAgentResult = {
  reply: string;
  nextState: WaAgentState;
  nextStateData: WaAgentStateData;
  appointmentId: string | null;
  selectedBranchId: string | null;
  debug: {
    intent?: string;
    entities?: unknown;
    actions: string[];
    errors: string[];
    /**
     * V4: what the model asked each tool and what the tool answered, compact. Persisted on the
     * outgoing message so «ассистент вчера неправильно записал» can be reconstructed from the
     * database: which date/time/master the model passed, and whether the server accepted it.
     */
    toolTrace?: Array<{ name: string; args: unknown; result: unknown; ms: number }>;
  };
  interactiveMessage?: WaInteractiveMessage; // V3: send as WhatsApp button/list instead of plain text
  // V3: relay the client's photo to the salon admin (owner_notify_phone) — set when photo
  // pricing confidence stayed low after a retry. The webhook performs the actual send.
  notifyAdmin?: { mediaUrl: string; caption: string };
  // V4: a plain-text alert the webhook forwards to the salon admin (owner_notify_phone) — set
  // when the agent escalates a conversation to a live human. The webhook performs the send.
  notifyAdminText?: string;
  // V5: an image the transport must send to the CLIENT right after the text reply — today
  // only the salon's payment QR when a prepayment hold is created. Deliberately a result
  // field rather than a send inside the agent: the agent has no transport credentials and
  // must stay channel-agnostic (same pattern as notifyAdmin above).
  sendMedia?: { url: string; caption?: string; fileName?: string };
};

export type GreenApiCreds = { instance: string; token: string };

// ============================================================
// Green-API helpers
// ============================================================

export function normalizeChatIdToPhone(chatId: string): string {
  return chatId.replace(/@c\.us$/, "").replace(/[^\d]/g, "");
}

// Does an inbound sender phone belong to the salon owner (owner_notify_phone)? Both are reduced
// to digits, then compared exactly OR by their last 9 digits — so a country-code/format mismatch
// (e.g. owner saved as "0700…" but WhatsApp sends "996700…") still matches. Used to gate the
// hidden /restart test command; a wrong owner_notify_phone was why /restart silently no-op'd.
export function ownerPhoneMatches(senderPhone: string, ownerPhone: string): boolean {
  const a = (senderPhone ?? "").replace(/[^\d]/g, "");
  const b = (ownerPhone ?? "").replace(/[^\d]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 9 || b.length < 9) return false;
  return a.slice(-9) === b.slice(-9);
}

export async function greenApiSendMessage(
  creds: GreenApiCreds,
  chatId: string,
  message: string,
): Promise<{ ok: boolean; idMessage?: string; error?: string }> {
  try {
    const url = `https://api.green-api.com/waInstance${creds.instance}/sendMessage/${creds.token}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(txt);
    } catch {}
    if (!r.ok) {
      return { ok: false, error: `green-api ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, idMessage: json?.idMessage };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * WhatsApp "печатает…" indicator, the Green-API equivalent of igSendTypingOn.
 *
 * Why it matters here specifically: an agent turn is 5–15 s of Gemini + tool calls, and a
 * silent thread for that long reads as "никто не отвечает" — the single most common reason a
 * client re-sends or leaves. So this fills latency that ALREADY EXISTS; it deliberately adds
 * no artificial delay of its own. Slowing a fast reply down to look human would trade a real
 * metric (time-to-answer) for a cosmetic one.
 *
 * Fire-and-forget by design: `typingTime` is clamped to Green-API's documented 1000–20000 ms
 * window, the request gets a short timeout, and every failure is swallowed — a cosmetic call
 * must never be able to delay or break the actual reply.
 */
export async function greenApiSendTyping(
  creds: GreenApiCreds,
  chatId: string,
  typingTimeMs = 10_000,
): Promise<void> {
  try {
    const typingTime = Math.min(20_000, Math.max(1000, Math.round(typingTimeMs)));
    const url = `https://api.green-api.com/waInstance${creds.instance}/sendTyping/${creds.token}`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, typingTime }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* cosmetic only — never let this affect the reply */
  }
}

// Relays a file (e.g. a client's photo) to an arbitrary chat — used to forward a client's
// photo to the salon admin's WhatsApp when the AI can't confidently price it from the photo
// alone. Takes any fetchable URL (we pass our own Supabase signed URL, not Green-API's,
// so it isn't subject to Green-API's own media TTL). No storage bucket of our own involved.
export async function greenApiSendFileByUrl(
  creds: GreenApiCreds,
  chatId: string,
  urlFile: string,
  fileName: string,
  caption?: string,
): Promise<{ ok: boolean; idMessage?: string; error?: string }> {
  try {
    const url = `https://api.green-api.com/waInstance${creds.instance}/sendFileByUrl/${creds.token}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, urlFile, fileName, caption }),
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(txt);
    } catch {}
    if (!r.ok) {
      return { ok: false, error: `green-api ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, idMessage: json?.idMessage };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// Fetch a fresh, downloadable URL for an inbound media message. Green-API's incoming webhook
// often omits fileMessageData.downloadUrl (or it has already expired by the time we process),
// which left the assistant unable to "see" a client's photo. downloadFile returns a working URL
// on demand from the message's own idMessage, so we can still download and price the photo.
export async function greenApiDownloadFile(
  creds: GreenApiCreds,
  chatId: string,
  idMessage: string,
): Promise<{ ok: boolean; downloadUrl?: string; error?: string }> {
  try {
    const url = `https://api.green-api.com/waInstance${creds.instance}/downloadFile/${creds.token}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, idMessage }),
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(txt);
    } catch {}
    if (!r.ok)
      return { ok: false, error: `green-api downloadFile ${r.status}: ${txt.slice(0, 200)}` };
    return { ok: true, downloadUrl: json?.downloadUrl };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ============================================================
// Time / language helpers
// ============================================================

export function nowInTz(tz: string): {
  isoLocalDate: string;
  humanDate: string;
  hour: number;
  minute: number;
  dow: number;
} {
  const now = new Date();
  const isoLocalDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const humanDate = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const hour = Number(parts.hour ?? "0");
  const minute = Number(parts.minute ?? "0");
  // Get day-of-week (0=Sunday) in the salon timezone.
  const wdName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wdName] ?? 0;
  return { isoLocalDate, humanDate, hour, minute, dow };
}

function addDaysISO(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function buildDateMap(
  tz: string,
  days = 14,
): Array<{ iso: string; label: string; relative: string }> {
  const { isoLocalDate } = nowInTz(tz);
  const out: Array<{ iso: string; label: string; relative: string }> = [];
  const labels = ["сегодня", "завтра", "послезавтра"];
  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(isoLocalDate, i);
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    const human = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(dt);
    out.push({ iso, label: human, relative: labels[i] ?? `+${i} дн` });
  }
  return out;
}

const PART_LABEL_RU: Record<"morning" | "afternoon" | "evening", string> = {
  morning: "утром (до 12:00)",
  afternoon: "днём (12:00–17:00)",
  evening: "вечером (после 17:00)",
};
// Which parts of the day still make sense to offer for "today", given the current local hour.
// (Assume salons generally close by ~21:00; evening is offered until then.)
function availablePartsToday(nowHour: number): Array<"morning" | "afternoon" | "evening"> {
  const parts: Array<"morning" | "afternoon" | "evening"> = [];
  if (nowHour < 12) parts.push("morning");
  if (nowHour < 17) parts.push("afternoon");
  if (nowHour < 21) parts.push("evening");
  return parts;
}

// Common Kyrgyz words, incl. casual transliterations typed WITHOUT ң/ү/ө (бугун, эртен, тушун).
// NB: ASCII \b does not work around Cyrillic, so use Unicode-aware letter boundaries
// (?<![\p{L}]) / (?![\p{L}]). Words that also exist in Russian (бар, etc.) are excluded to
// avoid misdetecting Russian as Kyrgyz.
const KY_WORD_RE =
  /(?<![\p{L}])(алейкум|ассалму|байке|эже|аке|иним|кандайс[\p{L}]*|сала?мат[\p{L}]*|салам(атсызбы|атчылык)?|жакшы|кандай|канча|ооба|жок|макул|бүгүн|бугун|эртең|эртен|эртеси|кеч(инде|ке|ки)?|таңда|түш(тө|кү)?|менин|жаз[\p{L}]*|куну|күнү|кереги|керек|рахмат|тушун[\p{L}]*|түшүн[\p{L}]*|саат|болот|кайра|кызмат[\p{L}]*)(?![\p{L}])/iu;

export function detectLanguage(text: string): "ru" | "ky" | "en" {
  if (!text) return "ru";
  const lower = text.toLowerCase();
  const hasKyrgyzLetters = /[ңүөҢҮӨ]/.test(text);
  const hasLatinKyrgyzSignals =
    /\b(salam|salamat|bugun|bugin|erten|kec|kyrgyz|kizmat|chach|kyzmat|kyrgyzstan|sizin|biz|jany|ja?an|manikur|pedikur)\b/i.test(
      lower,
    );
  // Islamic greeting used as standard Kyrgyz greeting in Kyrgyzstan — treat as Kyrgyz signal.
  const hasIslamicGreeting = /ассаламу?\s*а?лейку?м|ассалму\s*а?лейку?м/i.test(text);
  if (hasKyrgyzLetters || KY_WORD_RE.test(lower) || hasLatinKyrgyzSignals || hasIslamicGreeting)
    return "ky";
  if (/[а-яё]/i.test(lower)) return "ru";
  if (/^[\x00-\x7f\s]+$/.test(text) && /[a-z]/i.test(text)) return "en";
  return "ru";
}

// A message carries a "confident" language signal when it has Kyrgyz-unique letters / words,
// or is plainly Latin (English). Plain Cyrillic without Kyrgyz markers is NOT confident — that
// keeps a Kyrgyz conversation from flipping to Russian on a short word like "бугун".
export function confidentLanguage(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/[ңүөҢҮӨ]/.test(text)) return true;
  if (KY_WORD_RE.test(lower)) return true;
  if (/ассаламу?\s*а?лейку?м|ассалму/i.test(text)) return true;
  if (
    /\b(salam|salamat|bugun|bugin|erten|kec|kizmat|chach|kyrgyz|jany|sizin|biz|kanday|kansha)\b/i.test(
      lower,
    )
  )
    return true;
  if (/^[\x00-\x7f\s]+$/.test(text) && /[a-z]/i.test(text)) return true;
  return false;
}

function clampLanguage(lang: string | undefined, allowed: string[]): "ru" | "ky" | "en" {
  const l = (lang ?? "ru").toLowerCase();
  const allow = allowed.map((x) => x.toLowerCase());
  if ((l === "ru" || l === "ky" || l === "en") && allow.includes(l)) return l;
  if (allow.includes("ru")) return "ru";
  if (allow.includes("en")) return "en";
  return "ru";
}

// A message that is PURELY a greeting (ru/ky/en), with no service/date/name/other content
// mixed in. Used to restart the dialog when a client says hello again mid-flow — the salon
// wants a fresh greeting + menu, not a failed parse of "Здравствуйте" as a date. "Softer" words
// (добрый/день/эже/как дела) are only accepted alongside a strong greeting core, so a bare
// "день" or "как дела" never counts as a greeting on its own.
const GREETING_STRONG_RE =
  /(привет|здравству|здрав|здрас|здаров|здоров|салам|ассал|алейк|алекум|кандайс|саламат|hello|\bhi\b|\bhey\b|hallo)/i;
const GREETING_SOFT_WORDS = new Set([
  "добрый",
  "доброе",
  "доброго",
  "утро",
  "утра",
  "день",
  "дня",
  "денек",
  "вечер",
  "ночи",
  "как",
  "дела",
  "эже",
  "эжеке",
  "байке",
  "байкеке",
  "аке",
  "агай",
  "иним",
]);
function isPureGreeting(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  if (!GREETING_STRONG_RE.test(norm)) return false;
  const toks = norm.split(/\s+/).filter(Boolean);
  if (toks.length === 0 || toks.length > 5) return false;
  return toks.every((t) => GREETING_SOFT_WORDS.has(t) || GREETING_STRONG_RE.test(t));
}

// Vague "tell me more" wording with no concrete request. Ad leads click through from a targeted
// post with a prefilled "Здравствуйте, можно узнать об этом поподробнее" — those should get the
// salon's greeting + menu, not a confused parse. Deliberately excludes a named service/date/time.
const GENERIC_INQUIRY_RE =
  /(поподробн|подробн|расскаж|можно узнать|хочу узнать|хотел[аи]?\s*бы\s*узнать|интересует|об этом|про это|про акци|по акци|узнать больше|информаци|подскаж|көбүрөөк|кабарлаш|билсем болобу|маалымат)/i;

// Should this message reset the dialog to the salon's greeting + service menu? True for a pure
// greeting, or a greeting followed only by a generic inquiry (the ad-lead case). A greeting
// followed by a concrete request (service/date/time) is NOT reset — the normal flow handles it.
function shouldGreetRestart(text: string): boolean {
  if (isPureGreeting(text)) return true;
  if (!GREETING_STRONG_RE.test(normalizeForMatch(text))) return false;
  return GENERIC_INQUIRY_RE.test(text);
}

// How long after a fresh session starts we still treat an "outgoingMessageReceived" event as a
// possible race with WhatsApp Business App's own NATIVE greeting/away-message auto-reply (fired by
// the device itself, not via our API — Green-API reports it identically to a human typing manually)
// rather than genuine staff takeover. Derived from worst-case latency before our own bot's reply
// lands: 700ms debounce + up to 8s LOCK_WAIT_TIMEOUT_MS + Gemini latency (~1-5s) + margin.
const NATIVE_GREETING_RACE_WINDOW_MS = 20_000;

// Should a Green-API "outgoingMessageReceived" event be treated as the native auto-greeting racing
// the client's first message, rather than a human manually taking over? True only when the bot
// hasn't sent its own reply yet THIS session AND the session just started — an outgoing event later
// in a stale/broken session (bot never replied, staff steps in minutes later) must still pause.
export function isLikelyNativeGreetingRace(opts: {
  hasBotReplyThisSession: boolean;
  sessionAgeMs: number;
}): boolean {
  return (
    !opts.hasBotReplyThisSession &&
    opts.sessionAgeMs >= 0 &&
    opts.sessionAgeMs < NATIVE_GREETING_RACE_WINDOW_MS
  );
}

// ============================================================
// Gemini REST wrapper (no SDK — stays Worker-safe)
// ============================================================

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function callGemini(opts: {
  model: string;
  apiKey: string;
  systemInstruction?: string;
  parts: GeminiPart[];
  contents?: GeminiContent[];
  responseMimeType?: "application/json" | "text/plain";
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  // Integer seed for deterministic sampling. With temperature:0 + seed, the same content
  // produces the same output on repeat calls — required for photo pricing where two
  // identical photos must not yield different price ranges.
  seed?: number;
  // Caps tokens spent per image (MEDIA_RESOLUTION_LOW/MEDIUM/HIGH) — controls Gemini's
  // per-image billing without us having to resize anything ourselves (we can't: Cloudflare
  // Workers has no native image codecs, so a library like sharp isn't an option here).
  mediaResolution?: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const body: any = {
    contents: opts.contents ?? [{ role: "user", parts: opts.parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
      // Gemini 2.5 Flash can spend the token budget on hidden "thinking".
      // Allow callers (vision, JSON-only flows) to disable thinking with thinkingBudget=0
      // so the entire output budget goes to the actual response.
      thinkingConfig: { thinkingBudget: opts.thinkingBudget ?? 5000 },
    },
  };
  if (typeof opts.seed === "number") body.generationConfig.seed = opts.seed;
  if (opts.responseMimeType) body.generationConfig.responseMimeType = opts.responseMimeType;
  if (opts.responseSchema) body.generationConfig.responseSchema = opts.responseSchema;
  if (opts.mediaResolution) body.generationConfig.mediaResolution = opts.mediaResolution;
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }

  const url = `${GEMINI_BASE}/${opts.model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  let lastQuotaError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const txt = await r.text();
      if (r.status === 429) {
        // Quota exhausted on the user's direct Gemini API key. Retrying won't help — break
        // immediately. There is NO Lovable fallback: every call goes through the salon's own
        // Gemini key so we never spend Lovable credits (surfaced as-is below).
        lastQuotaError = `gemini 429: ${txt.slice(0, 200)}`;
        break;
      }
      if (r.status >= 500) {
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
          continue;
        }
        return { ok: false, error: `gemini ${r.status}: ${txt.slice(0, 300)}` };
      }
      if (!r.ok) return { ok: false, error: `gemini ${r.status}: ${txt.slice(0, 300)}` };
      let json: any;
      try {
        json = JSON.parse(txt);
      } catch {
        return { ok: false, error: `gemini bad json: ${txt.slice(0, 200)}` };
      }
      const candidate = json?.candidates?.[0];
      const finishReason: string | undefined = candidate?.finishReason;
      // Filter out Gemini's internal thinking parts (thought: true) before extracting text.
      // When thinkingBudget > 0 the API returns thought-parts alongside the real output;
      // joining them all produces corrupt JSON / garbled text.
      const text: string | undefined = candidate?.content?.parts
        ?.filter((p: any) => !p?.thought)
        ?.map((p: any) => p?.text ?? "")
        .join("")
        .trim();
      if (finishReason === "MAX_TOKENS") {
        if (attempt < 2) {
          body.generationConfig.maxOutputTokens = Math.min(
            8192,
            Math.max(1024, Number(body.generationConfig.maxOutputTokens ?? 2048) * 2),
          );
          continue;
        }
        return { ok: false, error: `gemini truncated by max tokens: ${text?.slice(0, 120) ?? ""}` };
      }
      if (!text)
        return { ok: false, error: `gemini empty response: ${JSON.stringify(json).slice(0, 200)}` };
      return { ok: true, text };
    } catch (e: any) {
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        continue;
      }
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  // No fallback: the user explicitly requested that every call go through their own
  // Gemini API key (paid subscription) and never spend Lovable credits. Surface the
  // 429/quota error as-is so they can see it in logs and top up Gemini billing.
  return { ok: false, error: lastQuotaError ?? "gemini unknown" };
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[ұ]/g, "у")
    .replace(/[ң]/g, "н")
    .replace(/[ө]/g, "о")
    .replace(/[ү]/g, "у")
    .replace(/[^a-zа-яңүө0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

// Collapse elongated repeats so "нееет"/"дааа"/"окееей" match their base form.
function deElongate(s: string): string {
  return s.replace(/(.)\1{2,}/g, "$1");
}

// Typo-tolerant membership test: true if any token is within `maxDist` edits of any target.
// Targets must already be in normalizeForMatch form (lowercased, ё→е). Short words (<3) are
// matched exactly to avoid "да"/"не" colliding with everything.
function fuzzyHit(tokens: string[], targets: string[], maxDist = 1): boolean {
  for (const rawTok of tokens) {
    const tok = deElongate(rawTok);
    if (!tok) continue;
    for (const tg of targets) {
      if (tok === tg) return true;
      if (tok.length < 3 || tg.length < 3) continue;
      if (Math.abs(tok.length - tg.length) > maxDist) continue;
      if (levenshtein(tok, tg) <= maxDist) return true;
    }
  }
  return false;
}

// Client is explicitly telling us they didn't understand — switch to a simpler, clearer reply
// immediately instead of repeating the same prompt. Covers ru/ky (incl. ASCII transliteration)/en.
const CONFUSED_RE =
  /(не понял|не поняла|не понятно|непонятно|не пойму|что значит|что вы имеете|тушун\w*\s*жок|тушунбод\w*|түшүн\w*\s*жок|түшүнбөд\w*|түшүнгөн жок|don'?t understand|didn'?t understand|what do you mean|no entiendo)/i;

function serviceAliases(name: string): string[] {
  const n = normalizeForMatch(name);
  const aliases = new Set<string>([n]);
  if (/стри|стриж|hair|cut|chach|чач/.test(n)) {
    aliases.add("стрижка");
    aliases.add("чач кыркуу");
    aliases.add("чач кыруу");
    aliases.add("чач кесүү");
    aliases.add("чач кыруу");
  }
  if (/маник|ногт|nail|manik|маникюр/.test(n)) aliases.add("маникюр");
  if (/педик/.test(n)) aliases.add("педикюр");
  if (/окраш|краш|color|kolor|окрашивание/.test(n)) aliases.add("окрашивание");
  if (/бров/.test(n)) aliases.add("брови");
  if (/ресниц/.test(n)) aliases.add("ресницы");
  if (/уклад/.test(n)) aliases.add("укладка");
  if (/макияж|make|makiyazh/.test(n)) aliases.add("макияж");
  return [...aliases].filter(Boolean);
}

function findServiceByText(
  text: string,
  services: Array<{
    id: string;
    name: string;
    category: string | null;
    price: number;
    price_max: number | null;
    price_type: string;
  }>,
) {
  const t = normalizeForMatch(text);
  if (!t) return null;
  const hasServiceSignal =
    /(услуга|услуги|сервис|кызмат|чач|маник|педик|окраш|бров|ресниц|уклад|макияж|hair|nail|cut|color)/i.test(
      text,
    );
  let best: { service: (typeof services)[number]; score: number } | null = null;
  for (const service of services) {
    for (const alias of serviceAliases(service.name)) {
      const a = normalizeForMatch(alias);
      if (!a) continue;
      let score = 0;
      if (t.includes(a) || a.includes(t)) score = 100;
      else if (a.length >= 5 && t.includes(a.slice(0, 5))) score = 86;
      else {
        for (const token of t.split(" ")) {
          if (token.length < 4) continue;
          const dist = levenshtein(token, a);
          const maxLen = Math.max(token.length, a.length);
          const similarity = 1 - dist / maxLen;
          // Lowered from 0.62 to 0.55 for better typo tolerance (e.g., "стрижка" ↔ "стриж")
          if (similarity >= 0.55) score = Math.max(score, Math.round(similarity * 80));
        }
      }
      if (score > (best?.score ?? 0)) best = { service, score };
    }
  }
  // Lowered threshold from 55 to 45 to catch more fuzzy matches, and allow service-like short phrases.
  if (best && best.score >= 45) return best.service;
  if (hasServiceSignal && !best) {
    // Only use multi-char tokens (≥3 chars) to avoid matching prepositions like "а", "в", "на".
    const firstToken = t.split(" ").find((tok) => tok.length >= 3) ?? "";
    if (firstToken) {
      const fallback = services.find(
        (s) =>
          normalizeForMatch(s.name).includes(firstToken) ||
          t.includes(normalizeForMatch(s.name).split(" ")[0] ?? ""),
      );
      if (fallback) return fallback;
    }
  }
  return null;
}

function deterministicParse(opts: {
  text: string;
  services: Array<{
    id: string;
    name: string;
    category: string | null;
    price: number;
    price_max: number | null;
    price_type: string;
  }>;
  branches: WaBranchInfo[];
  dateMap: Array<{ iso: string; label: string; relative: string }>;
}): { intent?: Intent; entities: Entities; language?: "ru" | "ky" | "en" } {
  const raw = opts.text.trim();
  const t = normalizeForMatch(raw);
  const entities: Entities = {};
  let intent: Intent | undefined;

  if (!t) return { entities };
  const lang = detectLanguage(raw);

  // Use raw text here — normalizeForMatch strips colons, turning "12:45" into "12 45" (minutes lost).
  // Accept ":", "." or "-" as the minute separator ("12:45", "12.45", "12-45"). Prefixes
  // "в"/"на"/"к" before the number are covered by the (?:^|\s) anchor.
  // A message that is just a single lone digit ("3") is a slot ordinal, NOT 03:00 — skip time parse.
  const loneSingleDigit = /^\s*\d\s*$/.test(raw);
  const timeMatch = loneSingleDigit
    ? null
    : raw.match(/(?:^|\s)(?:в\s*)?(\d{1,2})(?:[:.\-](\d{2}))?(?:\s*(утра|дня|вечера))?(?:\s|$)/i);
  if (timeMatch && Number(timeMatch[1]) <= 23) {
    let h = Number(timeMatch[1]);
    const min = timeMatch[2] ?? "00";
    const suffix = timeMatch[3];
    if (suffix === "вечера" && h < 12) h += 12;
    if (suffix === "дня" && h < 12 && h <= 6) h += 12;
    entities.specific_time = `${String(h).padStart(2, "0")}:${min}`;
    intent = "choose_specific_time";
  }

  if (/(^|\s)(сегодня|бугун|бүгүн)(\s|$)/.test(t)) {
    entities.day_relative = "today";
    intent = intent ?? "choose_day";
  } else if (/(^|\s)(завтра|эртен|эртең)(\s|$)/.test(t)) {
    entities.day_relative = "tomorrow";
    intent = intent ?? "choose_day";
  } else if (/(^|\s)(послезавтра)(\s|$)/.test(t)) {
    entities.day_relative = "day_after_tomorrow";
    intent = intent ?? "choose_day";
  }

  const toks = t.split(/\s+/).filter(Boolean);
  // More comprehensive patterns for morning/afternoon/evening in Russian and Kyrgyz (incl. typos)
  if (/(^|\s)(утр[^а-яю]*|таң|тан|таңда|таңкы|эртең менен|эртен менен|рано)(\s|$)/.test(t)) {
    entities.part_of_day = "morning";
    intent = intent ?? "choose_part_of_day";
  } else if (/(^|\s)(дн[^и]*|туш|түш|түштө|тушто|түшкү|полдень)(\s|$)/.test(t)) {
    entities.part_of_day = "afternoon";
    intent = intent ?? "choose_part_of_day";
  } else if (/(^|\s)(вечер[^а-яю]*|кеч|кечинде|кечке|кечки|поздно)(\s|$)/.test(t)) {
    entities.part_of_day = "evening";
    intent = intent ?? "choose_part_of_day";
  } else if (!entities.part_of_day) {
    // Typo-tolerant fallback for the part of day ("вечром", "утрам", elongated "днеее").
    if (fuzzyHit(toks, ["утром", "утро", "утра"])) {
      entities.part_of_day = "morning";
      intent = intent ?? "choose_part_of_day";
    } else if (fuzzyHit(toks, ["днем", "день", "дня"])) {
      entities.part_of_day = "afternoon";
      intent = intent ?? "choose_part_of_day";
    } else if (fuzzyHit(toks, ["вечером", "вечер", "вечера"])) {
      entities.part_of_day = "evening";
      intent = intent ?? "choose_part_of_day";
    }
  }

  // Exact yes / no / any-master, now incl. Kyrgyz (ооба/макул = yes, жок = no, баары бир = any).
  // Extended patterns to catch more variations including typos and abbreviations.
  if (
    /(^|\s)(да|ага|ок|окей|оке|хорошо|хорош|записывайте|подтверждаю|подтверди|верно|правильно|так точно|конечно|давай|давайте|ладно|ооба|макул|макуль|туура|болот|жакшы|yes|угу|yep|yeah)(\s|$)/.test(
      t,
    )
  )
    intent = intent ?? "confirm_yes";
  if (/(^|\s)(нет|неа|ни|другое|не подходит|жок|no|неэ|нее)(\s|$)/.test(t))
    intent = intent ?? "deny_no";
  if (
    /(^|\s)(любой|любому|без разницы|не принципиально|все равно|всё равно|любое|неважно|не важно|баары бир|баарыбир|бары бир|равно)(\s|$)/.test(
      t,
    )
  )
    intent = intent ?? "any_master";
  // Typo-tolerant yes/no for short confirmations ("оке", "нееет", "ооаба", "макуль") — increased maxDist.
  if (!intent) {
    if (fuzzyHit(toks, ["окей", "хорошо", "ооба", "макул", "хорош"], 2)) intent = "confirm_yes";
    else if (fuzzyHit(toks, ["неа", "нет", "жок", "ни"], 1)) intent = "deny_no";
  }
  if (/(^|\s)(отмена|не нужно|передумал)(\s|$)/.test(t)) intent = "cancel";

  // Numbered slot selection: "первый", "2", "четвёртое", "последнее" etc.
  const ordinals: Record<string, number> = {
    первый: 1,
    первое: 1,
    первую: 1,
    первая: 1,
    "1": 1,
    второй: 2,
    второе: 2,
    вторую: 2,
    вторая: 2,
    "2": 2,
    третий: 3,
    третье: 3,
    третью: 3,
    третья: 3,
    "3": 3,
    четвертый: 4,
    четвертое: 4,
    четвертую: 4,
    четвертая: 4,
    четвёртый: 4,
    четвёртое: 4,
    четвёртую: 4,
    "4": 4,
    последний: -1,
    последнее: -1,
    последнюю: -1,
    последняя: -1,
  };
  const ordWord = t.split(/\s+/).find((w) => ordinals[w] !== undefined);
  if (ordWord != null && ordinals[ordWord] !== undefined) {
    entities.slot_number = ordinals[ordWord];
    intent = intent ?? "choose_specific_time";
  } else {
    // bare single digit: "4" means 4th slot
    const bareNum = t.match(/^(\d)$/);
    if (bareNum) {
      const n = Number(bareNum[1]);
      if (n >= 1 && n <= 9) {
        entities.slot_number = n;
        intent = intent ?? "choose_specific_time";
      }
    }
  }

  // Schedule/hours question — takes priority over day extraction so "вы работаете завтра?" stays a schedule question
  const isScheduleQ =
    /(вы\s+работаете|вы\s+открыты|у\s+вас\s+выходной|часы\s+работы|расписани[ея]|как\s+вы\s+работаете|когда\s+(вы\s+)?открыв|во\s+сколько\s+(открыв|закрыв)|до\s+скольки|иштейсизби|иш\s+убакытыңыз|саат\s+нечеде\s+ачылас)/i.test(
      raw,
    );
  if (isScheduleQ) {
    intent = "ask_schedule";
    entities.day_relative = undefined; // "завтра" in schedule question is NOT a booking day
  }

  // Capability question: "вы делаете X?", "у вас есть X?", "можно ли X?"
  // Only set if intent not already decided by strong booking signals
  const isCapabilityQ =
    /(вы\s+(делаете|можете|сможете|умеете)|у\s+вас\s+(есть|делают|можно|имеется)|можно\s+ли\s+у\s+вас|сизде\s+(?:бар|жасайс)|сиз\s+(?:жасайсызбы|кыласызбы|кыла\s+аласызбы))/i.test(
      raw,
    );
  if (isCapabilityQ && (!intent || ["greet", "smalltalk", "other"].includes(intent))) {
    intent = "ask_capability";
  }

  const service = findServiceByText(raw, opts.services);
  if (service) {
    entities.service_id = service.id;
    // Do NOT override ask_services / ask_capability — client is asking, not choosing yet.
    if (!intent || ["greet", "smalltalk", "other"].includes(intent)) intent = "choose_service";
  }

  const branch = opts.branches.find((b) => {
    const name = normalizeForMatch(b.name);
    const address = normalizeForMatch(b.address ?? "");
    return (name && t.includes(name)) || (address && t.includes(address));
  });
  if (branch) {
    entities.branch_id = branch.id;
    intent = "choose_branch";
  }

  if (
    !intent &&
    /(какие|какая|что есть|услуги|прайс|цены|стоимость|сколько|кызмат|услуга)/.test(t)
  ) {
    intent = /(сколько|цена|цены|стоимость|прайс)/.test(t) ? "ask_price" : "ask_services";
  }
  if (!intent && /(здрав|привет|салам|ассаламу|ассалму|алейкум|hello|hi|salam|salamat)/.test(t))
    intent = "greet";
  if (!intent) intent = "other";

  return { intent, entities, language: lang };
}

function sanitizeHistoryMessage(m: WaIncomingMessage): string {
  const raw = (m.text_body ?? (m.kind === "image" ? "[фото]" : "")).trim();
  if (!raw) return "";

  // Previous broken deploys sometimes stored raw internal instructions in
  // wa_messages ("Спроси...", "Скажи..."). Never feed those back into Gemini —
  // otherwise the model treats them as real dialog and the bot appears amnesic.
  if (
    m.direction === "out" &&
    /^(спроси|скажи|поприветствуй|извинись|предложи|уточни)\b/i.test(raw)
  ) {
    return "[assistant asked a booking question]";
  }

  return raw;
}

// ============================================================
// Intent classifier
// ============================================================

type Intent =
  | "greet"
  | "smalltalk"
  | "ask_services"
  | "ask_schedule" // "вы работаете завтра?", "когда открываетесь?"
  | "ask_capability" // "вы делаете маникюр?", "можно ли у вас X?"
  | "choose_service"
  | "choose_day"
  | "choose_part_of_day"
  | "choose_specific_time"
  | "choose_master"
  | "any_master"
  | "confirm_yes"
  | "deny_no"
  | "cancel"
  | "ask_price"
  | "send_photo"
  | "give_name"
  | "choose_branch"
  | "other";

type Entities = {
  service_id?: string;
  service_query?: string;
  day_iso?: string;
  day_relative?: "today" | "tomorrow" | "day_after_tomorrow" | null;
  part_of_day?: "morning" | "afternoon" | "evening";
  specific_time?: string; // HH:MM
  slot_number?: number; // 1-based from displayed list; -1 = last
  master_name?: string;
  client_name?: string;
  branch_id?: string;
};

// When the resolved intent is weak (greeting/other/smalltalk) but the message clearly carried
// booking entities, promote it so the state machine advances instead of looping on "what
// service?". Priority: specific time > day > part of day > service.
// Also promote strong intents like ask_price/ask_services if booking entities are present.
function promoteIntentFromEntities(intent: Intent, e: Entities): Intent {
  const weak =
    intent === "other" ||
    intent === "greet" ||
    intent === "smalltalk" ||
    intent === "ask_price" ||
    intent === "ask_services";
  if (!weak) return intent;
  if (e.specific_time || e.slot_number != null) return "choose_specific_time";
  if (e.day_relative || e.day_iso) return "choose_day";
  if (e.part_of_day) return "choose_part_of_day";
  if (e.service_id) return "choose_service";
  if (e.branch_id) return "choose_branch";
  return intent;
}

async function classify(opts: {
  apiKey: string;
  salon: WaSalonContext;
  history: WaIncomingMessage[];
  lastText: string;
  services: Array<{
    id: string;
    name: string;
    category: string | null;
    price: number;
    price_max: number | null;
    price_type: string;
  }>;
  branches: WaBranchInfo[];
  dateMap: Array<{ iso: string; label: string; relative: string }>;
}): Promise<{ intent: Intent; entities: Entities; language: "ru" | "ky" | "en" }> {
  const compactHistory = opts.history
    .slice(-10)
    .map(
      (m) =>
        `${m.direction === "in" ? "client" : "assistant"}: ${sanitizeHistoryMessage(m).slice(0, 200)}`,
    )
    .filter((line) => !line.endsWith(": "))
    .join("\n");

  const services = opts.services
    .slice(0, 80)
    .map(
      (s) =>
        `${s.id} | ${s.name}${s.category ? " (" + s.category + ")" : ""} | ${s.price_type === "range" ? `${s.price}–${s.price_max}` : s.price}`,
    )
    .join("\n");

  const branches = opts.branches
    .map((b) => `${b.id} | ${b.name}${b.address ? ", " + b.address : ""}`)
    .join("\n");
  const dates = opts.dateMap
    .slice(0, 14)
    .map((d) => `${d.iso} = ${d.relative} (${d.label})`)
    .join("\n");

  const sys = `Ты — парсер сообщений клиента бизнеса сферы услуг. Получаешь последнее сообщение клиента и историю диалога. Возвращаешь СТРОГО JSON по схеме, без markdown.
Никогда не выдумывай id — service_id и branch_id выбирай ровно из переданных таблиц или оставляй пустыми.
Определи язык клиента: "ru", "ky" (кыргызский — слова кандай, салам, бүгүн, эртең, кеч, ң/ү/ө) или "en".
Для дат используй таблицу. Если клиент сказал "сегодня"/"завтра" — поставь day_relative; если назвал дату — day_iso по таблице.
Время суток: до 12:00 = morning, 12:00–17:00 = afternoon, после 17:00 = evening.
Если клиент пишет HH:MM или "в 14", "в 6 вечера" — заполни specific_time как "HH:MM" в 24-часовом формате.
Намерения:
- greet: приветствие, "ассаламу алейкум", "здравствуйте", "привет"
- smalltalk: светская беседа без запроса ("как дела?", "кандайс?", "спасибо", "ладно")
- ask_services: "какие услуги?", "что у вас есть?", "расскажите о ваших услугах"
- ask_schedule: вопрос о часах/расписании ("вы работаете завтра?", "когда открываетесь?", "до скольки работаете?", "у вас выходной в воскресенье?", "иштейсизби?")
- ask_capability: вопрос, делает ли салон услугу ("вы делаете маникюр?", "можно ли у вас сделать X?", "вы сможете X?", "сиз маникюр кыласызбы?") — если есть подходящая услуга, укажи service_id
- choose_service: клиент ХОЧЕТ записаться на услугу (не просто спрашивает о ней) — подбери service_id
- choose_day: клиент назвал день для записи
- choose_part_of_day: клиент указал часть дня (утро/день/вечер)
- choose_specific_time: клиент назвал конкретный час (specific_time)
- choose_master: клиент выбрал мастера по имени (master_name)
- any_master: "любой", "непринципиально", "всё равно"
- confirm_yes: "да", "ок", "записывайте", "хорошо записывайте"
- deny_no: "нет", "не подходит", "другое время"
- cancel: "отмена", "не нужно", "передумал"
- ask_price: вопрос про стоимость без конкретной услуги
- send_photo: клиент пишет, что пришлёт фото (или прислал фото — см. кадры в истории)
- give_name: клиент представился, имя в client_name
- choose_branch: клиент назвал филиал (branch_id из таблицы филиалов)
- other: ничего из перечисленного
ВАЖНО: "как дела?", "кандайс?", "эмне кылатасыз?" — это smalltalk, НЕ other. "Вы делаете маникюр?" — это ask_capability, НЕ choose_service. "Вы работаете завтра?" — это ask_schedule, НЕ choose_day.
Можно выбирать несколько entities одновременно (например choose_service + choose_specific_time).
В этом случае intent — самое "продвигающее" (например choose_specific_time важнее choose_service).`;

  const user = `СЕЙЧАС (${opts.salon.timezone}): см. таблицу дат, первая строка = сегодня.

ТАБЛИЦА ДАТ:
${dates}

УСЛУГИ САЛОНА (id | название | цена сом):
${services || "(нет услуг)"}

ФИЛИАЛЫ:
${branches || "(нет филиалов)"}

ИСТОРИЯ (последние сообщения):
${compactHistory || "(пусто)"}

ПОСЛЕДНЕЕ СООБЩЕНИЕ КЛИЕНТА: ${JSON.stringify(opts.lastText)}

Верни JSON: {"intent": "...", "language": "ru|ky|en", "entities": { ... } }`;

  const schema = {
    type: "object",
    properties: {
      intent: { type: "string" },
      language: { type: "string", enum: ["ru", "ky", "en"] },
      entities: {
        type: "object",
        properties: {
          service_id: { type: "string" },
          service_query: { type: "string" },
          day_iso: { type: "string" },
          day_relative: { type: "string", enum: ["today", "tomorrow", "day_after_tomorrow"] },
          part_of_day: { type: "string", enum: ["morning", "afternoon", "evening"] },
          specific_time: { type: "string" },
          master_name: { type: "string" },
          client_name: { type: "string" },
          branch_id: { type: "string" },
        },
      },
    },
    required: ["intent", "language"],
  };

  const res = await callGemini({
    model: MODEL_TEXT,
    apiKey: opts.apiKey,
    systemInstruction: sys,
    parts: [{ text: user }],
    responseMimeType: "application/json",
    responseSchema: schema,
    temperature: 0.3,
    maxOutputTokens: 1024,
  });

  const deterministic = deterministicParse({
    text: opts.lastText,
    services: opts.services,
    branches: opts.branches,
    dateMap: opts.dateMap,
  });

  if (!res.ok || !res.text) {
    console.error("[wa-agent] classify gemini error:", res.error);
    return {
      intent: (deterministic.intent ?? "other") as Intent,
      entities: deterministic.entities,
      language: deterministic.language ?? detectLanguage(opts.lastText),
    };
  }
  try {
    const parsed = JSON.parse(res.text);
    const geminiEntities = (parsed.entities ?? {}) as Entities;
    const mergedEntities: Entities = { ...geminiEntities, ...deterministic.entities };
    const geminiIntent = (parsed.intent ?? "other") as Intent;
    const intent =
      deterministic.intent === "choose_service" &&
      mergedEntities.service_id &&
      // When deterministic confidently found a service, override Gemini's weak intents
      [
        "other",
        "greet",
        "smalltalk",
        "ask_services",
        "ask_price",
        "confirm_yes",
        "deny_no",
      ].includes(geminiIntent)
        ? deterministic.intent
        : // Trust deterministic when it explicitly found a query intent that Gemini misread as service choice
          ["ask_services", "ask_price"].includes(deterministic.intent as string) &&
            geminiIntent === "choose_service" &&
            !mergedEntities.service_id
          ? deterministic.intent
          : deterministic.intent &&
              deterministic.intent !== "other" &&
              (geminiIntent === "other" || geminiIntent === "greet" || geminiIntent === "smalltalk")
            ? deterministic.intent
            : geminiIntent;
    return {
      intent: promoteIntentFromEntities(intent as Intent, mergedEntities),
      entities: mergedEntities,
      language: (deterministic.language ?? parsed.language ?? detectLanguage(opts.lastText)) as
        | "ru"
        | "ky"
        | "en",
    };
  } catch {
    return {
      intent: (deterministic.intent ?? "other") as Intent,
      entities: deterministic.entities,
      language: deterministic.language ?? detectLanguage(opts.lastText),
    };
  }
}

// ============================================================
// Reply composer (Gemini renders final text in user's language)
// ============================================================

async function compose(opts: {
  apiKey: string;
  salon: WaSalonContext;
  language: "ru" | "ky" | "en";
  tone: string | null;
  greeting?: string | null;
  history?: WaIncomingMessage[];
  factualContext: string; // what the user must hear, in any language; Gemini translates/polishes
  greet?: boolean; // true on the very first assistant message → warm greeting up front
  islamicGreeting?: boolean; // client opened with "Ассалму алейкум" — respond with "Ваалейкум Ассалам"
}): Promise<string> {
  const langName =
    opts.language === "ky" ? "кыргызском" : opts.language === "en" ? "английском" : "русском";
  // Prepend a warm greeting on first contact (unless the reply already greets).
  const greetReply = (reply: string): string => {
    if (!opts.greet) return reply;
    // If client used Islamic greeting but reply doesn't respond in kind — override it.
    if (opts.islamicGreeting && /^\s*(ваалейкум|wa.?alaikum)/iu.test(reply)) return reply;
    if (
      !opts.islamicGreeting &&
      /^\s*(здрав|привет|саламат|салам|ваалейкум|hello|hi|hey|добр)/iu.test(reply)
    )
      return reply;
    // Islamic greeting overrides the salon's custom greeting for all languages.
    const useConfigGreeting =
      !opts.islamicGreeting &&
      opts.language === "ru" &&
      opts.greeting &&
      /\p{L}/u.test(opts.greeting);
    const g = opts.islamicGreeting
      ? "Ваалейкум ас-салям!"
      : useConfigGreeting
        ? opts.greeting!.trim()
        : opts.language === "ky"
          ? `Саламатсызбы! Мен «${opts.salon.salonName}» салонунун жардамчысымын.`
          : opts.language === "en"
            ? `Hello! I'm your assistant at "${opts.salon.salonName}".`
            : "Здравствуйте!";
    const shortHint =
      opts.language === "ru" &&
      /коротко|кратко|без лишних слов|по делу/i.test(`${opts.tone ?? ""} ${opts.greeting ?? ""}`)
        ? "Коротко: "
        : "";
    return `${g} ${shortHint}${reply}`.trim();
  };
  const sys = `Ты — живой администратор салона «${opts.salon.salonName}», пишешь клиенту в WhatsApp.
СТРОГО на ${langName} языке. Никаких других языков, никакого markdown.
1–3 коротких предложения, по-человечески и дружелюбно, без канцелярита и шаблонных роботных фраз. Эмодзи — максимум один.
${opts.tone ? `ОБЯЗАТЕЛЬНЫЕ правила тона и формулировок от салона (соблюдай их в каждом ответе): ${opts.tone}` : ""}
Если в контексте есть явные инструкции салона (например про приветствие, короткость, формат ответа, язык или стиль), соблюдай их в каждом ответе.
Если клиент пишет очень коротко или с опечатками, отвечай понятно и не спорь с ним.
ЗАПРЕЩЕНО писать «минуточку», «сейчас проверю», «подождите» — у тебя единственный ответ за этот ход.
Не выдумывай факты, опирайся только на переданный контекст. Не упоминай "контекст" или "система".
ВАЖНО: если в задаче написано «Спроси...», «Скажи...», «Поприветствуй...» — НЕ копируй эти слова клиенту. Выполни действие естественной фразой.`;

  const compactHistory = (opts.history ?? [])
    .slice(-8)
    .map((m) => `${m.direction === "in" ? "client" : "assistant"}: ${sanitizeHistoryMessage(m)}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");

  // Deterministic answers for list/choice prompts are safer than asking Gemini
  // to paraphrase them: the model was adding non-existent services in live chats.
  // Accept any dash-like character (—, –, -) to be robust against editor differences.
  if (/^[-–—]\s+[^\n]+/m.test(opts.factualContext)) {
    return greetReply(
      instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName),
    );
  }

  const greetInstruction = opts.greet
    ? "Это ПЕРВОЕ сообщение клиенту — начни с короткого тёплого приветствия от салона, затем выполни задачу.\n\n"
    : "";
  const styleInstruction = opts.tone ? `Соблюдай правила стиля салона: ${opts.tone}\n\n` : "";
  const res = await callGemini({
    model: MODEL_TEXT,
    apiKey: opts.apiKey,
    systemInstruction: sys,
    parts: [
      {
        text: `${compactHistory ? `История текущего диалога:\n${compactHistory}\n\n` : ""}${greetInstruction}${styleInstruction}Задача для ответа клиенту:\n${opts.factualContext}\n\nНапиши ГОТОВУЮ реплику клиенту, не инструкцию.`,
      },
    ],
    temperature: 0.7,
    maxOutputTokens: 1024,
  });
  if (!res.ok || !res.text) {
    console.error("[wa-agent] compose gemini error:", res.error);
    // Safe deterministic fallback — never leak raw instruction text and never
    // lose the current booking step if Gemini quota/API is temporarily down.
    return greetReply(
      instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName),
    );
  }
  const cleaned = res.text.replace(/^```[a-z]*|```$/gi, "").trim();
  if (/^(спроси|скажи|поприветствуй|извинись|предложи|уточни)\b/i.test(cleaned)) {
    return greetReply(
      instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName),
    );
  }
  // Guard against the exact production symptom: Gemini returned a partial
  // sentence like "...на какую услугу хотели бы записа" with finishReason STOP.
  // WhatsApp must never receive half-words, so fall back to deterministic text
  // for the current factual step when the answer has no sentence terminator.
  if (!/[.!?…]$/.test(cleaned)) {
    return greetReply(
      instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName),
    );
  }
  // Gemini was already told to greet on first contact; greetReply is a no-op if it did.
  return greetReply(cleaned);
}

// Language-aware clarification used when the client keeps replying with something we can't
// parse for the question we're currently on. Deterministic (not paraphrased by Gemini) so the
// wording is GUARANTEED to differ from the previous verbatim question — kills the repeat loop.
function stuckClarifyReply(questionKey: string | undefined, language: "ru" | "ky" | "en"): string {
  const L = <T>(ru: T, ky: T, en: T): T => (language === "ky" ? ky : language === "en" ? en : ru);
  switch (questionKey) {
    case "photo":
    case "photo_retry":
      return L(
        "Пришлите, пожалуйста, фото — нажмите на иконку изображения рядом с полем сообщения.",
        "Сүрөттү жөнөтүңүзчү — билдирүү талаасынын жанындагы сүрөт баскычын басыңыз.",
        "Please send a photo — tap the photo icon next to the message field.",
      );
    case "service":
      return L(
        "Извините, не совсем поняла 🙂 Напишите, пожалуйста, название услуги — например «стрижка» или «маникюр».",
        "Кечиресиз, толук түшүнбөй калдым 🙂 Кызматтын атын жазыңызчы — мисалы «чач кыркуу» же «маникюр».",
        "Sorry, I didn't quite get that 🙂 Please type the service name — e.g. “haircut” or “manicure”.",
      );
    case "part":
      return L(
        "Кажется, я не совсем поняла 🙂 Подскажите, когда удобнее — утром, днём или вечером?",
        "Сизди толук түшүнбөй калдым окшойт 🙂 Качан ыңгайлуу — эртең менен, түштө же кечинде?",
        "Sorry, I didn't quite catch that 🙂 When works best — morning, afternoon, or evening?",
      );
    case "slot":
      return L(
        "Не совсем поняла 🙂 Назовите удобное время цифрами — например 12:30 — или номер из списка.",
        "Толук түшүнбөдүм 🙂 Ыңгайлуу убакытты сан менен жазыңыз — мисалы 12:30 — же тизмедеги номерди.",
        "I didn't quite get that 🙂 Tell me a time in numbers — e.g. 12:30 — or a number from the list.",
      );
    case "master":
      return L(
        "Подскажите имя мастера из списка или напишите «не принципиально».",
        "Тизмедеги устанын атын айтыңыз же «баары бир» деп жазыңыз.",
        "Tell me a master's name from the list, or just say “any”.",
      );
    case "name":
      return L(
        "Подскажите, пожалуйста, ваше имя — как к вам обращаться?",
        "Атыңызды айтыңызчы — сизге кандай кайрылсам болот?",
        "Could you tell me your name, please?",
      );
    case "confirm":
      return L(
        "Чтобы записать, напишите «да», либо назовите другое удобное время.",
        "Жазыш үчүн «ооба» деп жазыңыз, же башка ыңгайлуу убакыт айтыңыз.",
        "To book, reply “yes”, or tell me another time that suits you.",
      );
    default:
      return L(
        "Извините, не совсем поняла 🙂 Уточните, пожалуйста, чем могу помочь с записью?",
        "Кечиресиз, толук түшүнбөдүм 🙂 Жазылууда эмне менен жардам берейин?",
        "Sorry, I didn't quite get that 🙂 How can I help you book an appointment?",
      );
  }
}

// Graceful hand-off when the bot has tried twice and still can't understand the client.
// We stop repeating and route the conversation to a live admin (see `needs_human`).
function humanHandoffReply(language: "ru" | "ky" | "en", salonName?: string): string {
  const n = salonName ? ` «${salonName}»` : "";
  if (language === "ky")
    return `Жазышууда сизди түшүнүү мага кыйыныраак болуп жатат 🙏 Сурооңузду${n} салонунун администраторуна өткөрөм — ал жакында жооп берип, жазылууга жардам берет.`;
  if (language === "en")
    return `I'm having a little trouble understanding you over chat 🙏 I'll pass your request to the${n} salon's admin — they'll reply shortly and help you book.`;
  return `Кажется, мне сложно понять вас в переписке 🙏 Передаю ваш запрос администратору салона${n} — он скоро ответит и поможет с записью.`;
}

function instructionFallbackReply(
  factual: string,
  language: "ru" | "ky" | "en",
  salonName?: string,
): string {
  const text = factual.replace(/\s+/g, " ").trim();
  const serviceList = [...factual.matchAll(/^[-–—]\s+(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (serviceList.length) {
    const list = serviceList.map((s) => `— ${s}`).join("\n");
    const namePrefix = salonName ? `«${salonName}» — ` : "";
    if (language === "ky")
      return `${namePrefix}бизде бар кызматтар:\n${list}\n\nКайсы кызматка жазыласыз?`;
    if (language === "en") return `We offer:\n${list}\n\nWhich service would you like to book?`;
    return `У нас есть:\n${list}\n\nНа какую услугу вас записать?`;
  }
  const confirmMatch = text.match(
    /подтвердить запись:\s*услуга «(.+?)»,\s*(.+?)\s+в\s+([0-9:]+),\s*мастер\s+(.+?)\./i,
  );
  if (confirmMatch) {
    if (language === "ky")
      return `Тактап коёюн: «${confirmMatch[1]}», ${confirmMatch[2]} саат ${confirmMatch[3]}, мастер ${confirmMatch[4]}. Баары туурабы, жазайынбы?`;
    if (language === "en")
      return `Let's confirm: ${confirmMatch[1]}, ${confirmMatch[2]} at ${confirmMatch[3]}, master ${confirmMatch[4]}. Shall I book it?`;
    return `Подтвердите, пожалуйста: «${confirmMatch[1]}», ${confirmMatch[2]} в ${confirmMatch[3]}, мастер ${confirmMatch[4]}. Всё верно, записываю?`;
  }
  // Ambiguous yes/no while confirming a specific slot.
  const ambiguousConfirm = text.match(/подтверждаете запись на\s+(.+?)\s+в\s+([0-9:]+)/i);
  if (ambiguousConfirm) {
    if (language === "ky")
      return `${ambiguousConfirm[1]} саат ${ambiguousConfirm[2]} жазайынбы? «Ооба» деп жазыңыз же башка убакыт айтыңыз.`;
    if (language === "en")
      return `Shall I book ${ambiguousConfirm[1]} at ${ambiguousConfirm[2]}? Reply "yes" or suggest another time.`;
    return `Записываю на ${ambiguousConfirm[1]} в ${ambiguousConfirm[2]}? Напишите «да» или назовите другое время.`;
  }
  // Several masters free for the chosen slot.
  const masterChoice = text.match(/на\s+([0-9:]+)\s+свободны мастера\s+(.+?)\.\s*спроси/i);
  if (masterChoice) {
    if (language === "ky") {
      const names = masterChoice[2].replace(/ и /g, " жана ");
      return `${masterChoice[1]} бош усталар: ${names}. Кимге жазайын, же «баары бир»?`;
    }
    if (language === "en")
      return `Available masters at ${masterChoice[1]}: ${masterChoice[2]}. Who should I book, or "any"?`;
    return `На ${masterChoice[1]} свободны мастера ${masterChoice[2]}. К кому записать или «не принципиально»?`;
  }
  // Requested specific time not available — offer the nearest ones.
  const nearestMatch = text.match(/в\s+([0-9:]+)\b.*свободного окна нет.*ближайшие:\s*([^.]*)/i);
  if (nearestMatch) {
    if (language === "ky")
      return `${nearestMatch[1]} бош эмес. Жакынкы убакыттар: ${nearestMatch[2]}. Кайсынысы туура келет?`;
    if (language === "en")
      return `${nearestMatch[1]} isn't free. Nearest times: ${nearestMatch[2]}. Which one works?`;
    return `На ${nearestMatch[1]} свободного окна нет. Ближайшее время: ${nearestMatch[2]}. Какое подойдёт?`;
  }
  // Vision/download failed but salon's price range was voiced in the factual.
  const rangeFail = text.match(/ориентировочная стоимость «(.+?)» — (\d+)[–-](\d+) сом/i);
  if (rangeFail) {
    if (language === "ky")
      return `«${rangeFail[1]}» үчүн болжолдуу баасы — ${rangeFail[2]}–${rangeFail[3]} сом (так баасын уста жеринде айтат). Кайсы күнгө жазыласыз?`;
    if (language === "en")
      return `Approximate price for «${rangeFail[1]}» — ${rangeFail[2]}–${rangeFail[3]} som (master will confirm on site). What day works for you?`;
    return `Ориентировочная стоимость «${rangeFail[1]}» — ${rangeFail[2]}–${rangeFail[3]} сом (точную мастер озвучит на месте). На какой день вас записать?`;
  }
  if (/не получилось открыть фото|не получилось оценить по фото/i.test(text)) {
    if (language === "ky")
      return "Сүрөттү ача алган жокмын. Дагы бир жолу жөнөтүңүзчү, же баасын уста жеринде айтат.";
    if (language === "en")
      return "I couldn't open the photo. Please send it again, or the master will price it on site.";
    return "Не получилось открыть фото. Пришлите его ещё раз, пожалуйста, или мастер уточнит цену на месте.";
  }
  if (/прислать фото|пришлите фото|присл\w* фото/i.test(text)) {
    if (language === "ky") return "Баасын тагыраак билиш үчүн сүрөт жөнөтүңүзчү.";
    if (language === "en") return "Please send a photo so we can price it more accurately.";
    return "Пришлите, пожалуйста, фото — так мастер оценит стоимость точнее.";
  }
  const priceConfirm = text.match(/около\s+(\d+)\s*сом/i);
  if (priceConfirm && /ориентировочная стоимость|на какой день записать/i.test(text)) {
    // New flow: show price + disclaimer + ask for day (no confirmation step)
    if (language === "ky")
      return `Болжолдуу баасы — ${priceConfirm[1]} сом (так баасын уста жеринде айтат). Кайсы күнгө жазыласыз: бүгүн, эртең же башка күнгө?`;
    if (language === "en")
      return `Approximate price — ${priceConfirm[1]} som (master will confirm on site). What day works for you?`;
    return `Примерная стоимость — около ${priceConfirm[1]} сом (точную мастер озвучит на месте). На какой день вас записать?`;
  }
  if (priceConfirm && /продолжаем|подбор времени|стоимость по фото/i.test(text)) {
    if (language === "ky")
      return `Болжолдуу баасы — ${priceConfirm[1]} сом. Убакыт тандоону улантабызбы?`;
    if (language === "en")
      return `Approximate price — ${priceConfirm[1]} som. Shall we continue picking a time?`;
    return `Примерная стоимость — около ${priceConfirm[1]} сом. Продолжаем подбор времени?`;
  }
  if (/только что заняли/i.test(text)) {
    if (language === "ky")
      return "Тилекке каршы, бул убакытты азыр ээлеп коюшту. Башка убакыт тандайлыбы?";
    if (language === "en") return "Sorry, that time was just taken. Shall we pick another slot?";
    return "К сожалению, это время только что заняли. Давайте выберем другое окно?";
  }
  if (/нет доступных мастеров/i.test(text)) {
    if (language === "ky") return "Бул кызматка азыр бош уста жок. Башка кызматты тандаңызчы.";
    if (language === "en")
      return "No masters are available for this service right now. Please choose another service.";
    return "На эту услугу сейчас нет свободных мастеров. Выберите, пожалуйста, другую услугу.";
  }
  if (/отменил запрос/i.test(text)) {
    if (language === "ky") return "Жакшы! Эгер оюңуз өзгөрсө — жөн гана жазыңыз.";
    if (language === "en") return "No problem! If you change your mind, just message us.";
    return "Хорошо! Если передумаете — просто напишите, всегда поможем.";
  }
  if (/после завершения записи|ждём вас|ждем вас/i.test(text)) {
    if (language === "ky") return "Рахмат! Сизди күтөбүз.";
    if (language === "en") return "Thank you! We'll be waiting for you.";
    return "Спасибо! Будем рады видеть вас.";
  }
  if (/проблеме с записью|извинись/i.test(text)) {
    if (language === "ky") return "Кечиресиз! Кайра жазылуу үчүн жазыңыз же салонго чалыңыз.";
    if (language === "en")
      return "Sorry about that! Please write again to rebook, or call the salon directly.";
    return "Извините за это! Напишите ещё раз, чтобы переписаться, или позвоните в салон напрямую.";
  }
  if (/услуги ещё не настроены|услуги еще не настроены/i.test(text)) {
    if (language === "ky")
      return "Кечиресиз, кызматтар азырынча тууралануда. Салонго түз кайрылыңызчы.";
    if (language === "en")
      return "Sorry, services aren't set up yet. Please contact the salon directly.";
    return "Извините, услуги пока настраиваются. Пожалуйста, свяжитесь с салоном напрямую.";
  }
  if (/другое время или день|на какое другое время|на какое время записать/i.test(text)) {
    if (language === "ky") return "Кайсы убакытка же күнгө жазайын?";
    if (language === "en") return "What time or day should I book for?";
    return "На какое время или день вас записать?";
  }
  if (/в\s+какой\s+филиал|филиал.*записат/i.test(text)) {
    const lines = text.match(/^[-–—]\s+.+/gm) ?? [];
    const list = lines.length ? "\n" + lines.join("\n") : "";
    if (language === "ky") return `Кайсы филиалга жазыласыз?${list}`;
    if (language === "en") return `Which branch would you like to visit?${list}`;
    return `В какой филиал запишем?${list}`;
  }
  if (/поприветствуй|помочь с записью|на какую услугу записать/i.test(text)) {
    if (language === "ky") return `Кайсы кызматка жазыласыз?`;
    if (language === "en") return `Which service would you like to book?`;
    return `На какую услугу вас записать?`;
  }
  const partAsk = text.match(/удобнее\.?\s*доступные варианты:\s*([^.]*)/i);
  if (partAsk) {
    if (language === "ky") return `Кайсы убакыт ыңгайлуу: ${partAsk[1]}?`;
    if (language === "en") return `What time works for you: ${partAsk[1]}?`;
    return `Когда вам удобнее: ${partAsk[1]}?`;
  }
  if (/утром|дн[её]м|вечером|morning|afternoon|evening/i.test(text)) {
    if (language === "ky") return "Кайсы убакыт ыңгайлуу: эртең менен, түштө же кечинде?";
    if (language === "en")
      return "What time of day is better for you: morning, afternoon, or evening?";
    return "Когда удобнее: утром, днём или вечером?";
  }
  if (/какой день|какой день|на какой день/i.test(text)) {
    if (language === "ky") return "Кайсы күнгө жазыласыз: бүгүн, эртең же башка күнгө?";
    if (language === "en")
      return "Which day would you like to book for: today, tomorrow, or another day?";
    return "На какой день вас записать: сегодня, завтра или на другую дату?";
  }
  const freeMatch = text.match(/на\s+(.+?)\s+свободно:\s*([^.]*)/i);
  if (freeMatch) {
    if (language === "ky")
      return `${freeMatch[1]} бош убакыттар: ${freeMatch[2]}. Кайсы убакытты тандайсыз?`;
    if (language === "en")
      return `Available times for ${freeMatch[1]}: ${freeMatch[2]}. Which time would you like?`;
    return `На ${freeMatch[1]} свободно: ${freeMatch[2]}. Какое время выбрать?`;
  }
  if (/свободных окон нет|свободного окна нет/i.test(text)) {
    if (language === "ky") return "Бул убакытка бош орун жок. Башка убакытты же күндү тандайсызбы?";
    if (language === "en")
      return "There are no available slots for that time. Would you like another time or day?";
    return "На это время свободных окон нет. Выберем другое время или день?";
  }
  const bookedMatch = text.match(
    /салон «(.+?)»,\s*(.+?)\s+в\s+([0-9:]+),\s*мастер\s+(.+?),\s*услуга\s+«(.+?)»/i,
  );
  if (bookedMatch) {
    const [, salon, date, time, master, service] = bookedMatch;
    if (language === "ky")
      return `Даяр! 🎉 Сизди «${salon}» салонуна ${date}, саат ${time} жаздык. Уста ${master}, кызмат «${service}». Күтөбүз! 😊`;
    if (language === "en")
      return `All set! 🎉 You're booked at "${salon}" on ${date} at ${time}. Master ${master}, service "${service}". See you! 😊`;
    return `Готово! 🎉 Записали вас в «${salon}» на ${date} в ${time}. Мастер ${master}, услуга «${service}». Ждём вас в гости! 😊`;
  }
  if (/как обращаться|имя/i.test(text)) {
    if (language === "ky") return "Атыңыз ким?";
    if (language === "en") return "What name should I use for the booking?";
    return "Подскажите, пожалуйста, как к вам обращаться?";
  }
  // Schedule question with hours data
  const schedHours = text.match(/расписание:\s*(.+?)\.\s*Ответь/i);
  if (schedHours) {
    if (language === "ky") return `Иштөө убактыбыз: ${schedHours[1]}.`;
    if (language === "en") return `Our working hours: ${schedHours[1]}.`;
    return `Режим работы: ${schedHours[1]}.`;
  }
  // Schedule question without hours data
  if (/данных о расписании нет|уточнить у администратора/i.test(text)) {
    if (language === "ky") return "Иштөө убакытын администратор менен тактасаңыз болот.";
    if (language === "en") return "Please check our working hours with the admin directly.";
    return "Точные часы работы уточните у администратора, пожалуйста.";
  }
  // Capability question: yes, we do it
  const doCapability = text.match(/делаем ли мы «(.+?)».*стоимость\s+(.+?)(?:\.|Мягко|$)/is);
  if (doCapability) {
    if (language === "ky")
      return `Ооба, «${doCapability[1]}» жасайбыз! Баасы — ${doCapability[2].trim()}.`;
    if (language === "en")
      return `Yes, we do "${doCapability[1]}"! Price — ${doCapability[2].trim()}.`;
    return `Да, делаем «${doCapability[1]}»! Стоимость — ${doCapability[2].trim()}.`;
  }
  // Capability question: general (list what we offer)
  if (/спрашивает о возможностях/i.test(text)) {
    if (language === "ky") return "Биздин кызматтар жөнүндө суроо берсеңиз — жардам берем!";
    if (language === "en")
      return "Happy to tell you about our services! What would you like to know?";
    return "Расскажу о наших услугах с удовольствием! Что именно вас интересует?";
  }
  // Smalltalk — friendly, no booking push
  if (/без навязывания записи|просто светская беседа/i.test(text)) {
    if (language === "ky") return "Рахмат! Жардам керек болсо — жазыңыз.";
    if (language === "en") return "Thanks! Feel free to ask if you need anything.";
    return "Рады помочь! Если возникнут вопросы — пишите.";
  }

  if (language === "ky") return "Тактап коюңузчу, кандай кызматка жазыласыз?";
  if (language === "en") return "Please clarify, which service would you like to book?";
  return "Подскажите, пожалуйста, на какую услугу вас записать?";
}

// ============================================================
// Slot loading / merging
// ============================================================

export type DbMaster = {
  id: string;
  name: string;
  branch_id: string | null;
  sort_order: number;
  service_ids: string[];
  specialization?: string | null;
  bio?: string | null;
};

type MergedSlot = {
  start: string;
  end: string;
  master_ids: string[];
};

const SERVICE_COLUMNS =
  "id, name, category, price, price_max, price_type, duration_min, duration_max_min";

export async function loadServicesForSalon(db: AdminClient, salonId: string) {
  const query = (columns: string) =>
    db
      .from("services")
      .select(columns)
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .order("sort_order");
  // ПОРЯДОК ДЕПЛОЯ НЕ ГАРАНТИРОВАН. Код уезжает на Cloudflare сам, миграции применяются руками —
  // значит существует окно, где воркер уже новый, а колонки photo_pricing_config в базе ещё нет.
  // PostgREST на неизвестную колонку отвечает 42703, и это не «оценка по фото не работает», а
  // «список услуг пустой»: ассистент перестаёт знать прайс целиком. Дешевле один повторный
  // запрос без колонки, чем салон, которому ИИ сутки отвечает «не вижу услуг».
  const withPhoto = await query(`${SERVICE_COLUMNS}, photo_pricing_config`);
  if (!withPhoto.error) return ((withPhoto.data as any[]) ?? []) as any[];
  const fallback = await query(SERVICE_COLUMNS);
  return ((fallback.data as any[]) ?? []) as any[];
}

// The service list the AI assistant actually shows/matches against in WhatsApp — layered
// on top of loadServicesForSalon() with the admin's per-assistant category order/visibility
// (salon_ai_assistant.ai_category_order / ai_hidden_categories) and per-service overrides
// (ai_service_overrides). Absence of any override = identical to the regular services list.
// Used everywhere V3 builds or searches the service menu so a service hidden from the AI
// can't be booked by typing its name either — hiding stays consistent either way.
export async function loadAiVisibleServicesForSalon(db: AdminClient, salonId: string) {
  const [services, assistantRes, overridesRes] = await Promise.all([
    loadServicesForSalon(db, salonId),
    db
      .from("salon_ai_assistant")
      .select("ai_category_order, ai_hidden_categories")
      .eq("salon_id", salonId)
      .maybeSingle(),
    db
      .from("ai_service_overrides")
      .select("service_id, is_enabled, sort_order")
      .eq("salon_id", salonId),
  ]);
  const hiddenCategories = new Set(
    ((assistantRes.data as any)?.ai_hidden_categories as string[]) ?? [],
  );
  const categoryOrder = ((assistantRes.data as any)?.ai_category_order as string[]) ?? [];
  const overrides = new Map(
    ((overridesRes.data as any[]) ?? []).map((o) => [o.service_id as string, o]),
  );

  const visible = (services as any[]).filter((s) => {
    if (hiddenCategories.has((s.category ?? "").trim())) return false;
    const ov = overrides.get(s.id);
    return ov ? ov.is_enabled !== false : true;
  });

  const catRank = new Map<string, number>();
  let nextRank = categoryOrder.length;
  for (const s of visible) {
    const cat = (s.category ?? "").trim();
    if (!catRank.has(cat)) {
      const idx = categoryOrder.indexOf(cat);
      catRank.set(cat, idx >= 0 ? idx : nextRank++);
    }
  }
  return visible
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const catA = catRank.get((a.s.category ?? "").trim()) ?? 0;
      const catB = catRank.get((b.s.category ?? "").trim()) ?? 0;
      if (catA !== catB) return catA - catB;
      const ovA = overrides.get(a.s.id)?.sort_order;
      const ovB = overrides.get(b.s.id)?.sort_order;
      if (ovA != null && ovB != null) return ovA - ovB;
      if (ovA != null) return -1;
      if (ovB != null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

export async function loadMastersForService(
  db: AdminClient,
  salonId: string,
  serviceId: string,
  branchId: string | null,
): Promise<DbMaster[]> {
  const { data } = await db
    .from("masters")
    .select("id, name, branch_id, sort_order, specialization, bio, master_services(service_id)")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .order("sort_order");
  const all = (data ?? []).map((m: any) => ({
    id: m.id,
    name: m.name,
    branch_id: m.branch_id ?? null,
    sort_order: m.sort_order ?? 0,
    service_ids: (m.master_services ?? []).map((s: any) => s.service_id),
    specialization: m.specialization ?? null,
    bio: m.bio ?? null,
  })) as DbMaster[];
  return all.filter(
    (m) =>
      m.service_ids.includes(serviceId) &&
      (branchId == null || m.branch_id == null || m.branch_id === branchId),
  );
}

// Filter for part of day in salon TZ.
function isInPart(iso: string, tz: string, part: "morning" | "afternoon" | "evening"): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const h = Number(parts.hour ?? "0");
  if (part === "morning") return h < 12;
  if (part === "afternoon") return h >= 12 && h < 17;
  return h >= 17;
}

export function formatTimeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatDateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

export async function fetchMergedSlots(opts: {
  db: AdminClient;
  masters: DbMaster[];
  serviceId: string;
  day: string;
  tz: string;
  part?: "morning" | "afternoon" | "evening";
  minStartTime?: Date;
  limit?: number;
}): Promise<MergedSlot[]> {
  // Fan out one RPC per master IN PARALLEL. The previous serial for-await loop was the single
  // biggest cause of the 60–120s "AI is slow" regression: for a salon with N masters the drain
  // spent N × RPC round-trip (200–500 ms each from Cloudflare Worker → Supabase) just for slots,
  // and the V4 tool loop can call this 3–5× per turn (get_available_slots, check_time,
  // mastersFreeAtRequestedTime, emptyDayReasonScoped fallbacks). 10 masters × 400 ms × 4 calls
  // = 16 s BURNT on serialization alone. Promise.all reduces it to ~1 round-trip regardless of N.
  const perMaster = await Promise.all(
    opts.masters.map(async (m) => {
      const { data, error } = await opts.db.rpc("get_available_slots", {
        _master_id: m.id,
        _service_id: opts.serviceId,
        _date: opts.day,
      });
      // Historically this line was `const { data } = ...` — errors were silently discarded, so a
      // malformed UUID (Postgres "invalid input syntax for type uuid") turned into 0 slots for the
      // rest of the pipeline, and the tool reported "hours_not_configured" as if the schedule was
      // simply missing. Log so future occurrences are visible in Cloudflare Observability.
      if (error) {
        console.warn(
          `[wa] get_available_slots RPC error master=${m.id} service=${opts.serviceId} day=${opts.day}: ${
            (error as any)?.message ?? String(error)
          }`,
        );
      }
      return {
        masterId: m.id,
        rows: (data ?? []) as Array<{ slot_start: string; slot_end: string }>,
      };
    }),
  );
  const map = new Map<string, MergedSlot>();
  for (const { masterId, rows } of perMaster) {
    for (const s of rows) {
      const key = s.slot_start as string;
      if (opts.part && !isInPart(key, opts.tz, opts.part)) continue;
      if (opts.minStartTime && new Date(key).getTime() <= opts.minStartTime.getTime()) continue;
      const cur = map.get(key);
      if (cur) {
        if (!cur.master_ids.includes(masterId)) cur.master_ids.push(masterId);
      } else {
        map.set(key, { start: key, end: s.slot_end as string, master_ids: [masterId] });
      }
    }
  }
  const list = Array.from(map.values()).sort((a, b) => (a.start < b.start ? -1 : 1));
  return list.slice(0, opts.limit ?? 4);
}

// ============================================================
// Photo pricing (Gemini Vision)
// ============================================================

export async function classifyPhotoForPrice(opts: {
  apiKey: string;
  /** Одно фото — короткая форма для одно-снимочных услуг и для тестов контракта. */
  imageBase64?: string;
  mime?: string;
  /**
   * Несколько снимков сразу. Цена маникюра зависит и от того, что на ногтях СЕЙЧАС, и от
   * сложности ЖЕЛАЕМОГО дизайна: два разных фото, один вызов. Классифицировать их по очереди
   * нельзя — модель должна видеть оба, чтобы понять, какой из них референс.
   */
  images?: { base64: string; mime: string }[];
  serviceName: string;
  config: PhotoPricingConfig;
}): Promise<PhotoClassification | { error: string }> {
  const images = opts.images?.length
    ? opts.images
    : opts.imageBase64
      ? [{ base64: opts.imageBase64, mime: opts.mime ?? "image/jpeg" }]
      : [];
  if (!images.length) return { error: "no image" };
  const criteria = opts.config.criteria.map((c) => ({
    id: c.id,
    label: c.label,
    // На каком снимке искать признак. Без этой пометки модель на паре «ногти сейчас + референс»
    // читала дизайн с фото «до» и уверенно возвращала «однотон» там, где клиент хотел роспись.
    shot: c.shot === "reference" ? "желаемый результат (референс)" : "текущее состояние клиента",
    options: c.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  // Цена считается только по желаемому результату (например, объём ресниц) — фото «как сейчас»
  // клиента не просили, значит всё присланное и есть пример. Без подсказки модель на снимке
  // красивых ресниц гадала, свои ли это, и отправляла признак в uncertain.
  const referenceOnly = opts.config.criteria.every((c) => c.shot === "reference");
  const result = await callGemini({
    model: MODEL_VISION,
    apiKey: opts.apiKey,
    systemInstruction: `Оцени фото для услуги «${opts.serviceName}». Верни только видимые признаки из списка: ${JSON.stringify(criteria)}. У каждого признака поле shot говорит, на каком из присланных фото его искать: «текущее состояние клиента» или «желаемый результат (референс)».${referenceOnly ? " Клиента просили прислать только пример желаемого результата — считай референсом каждое присланное фото." : ""} Если нужного снимка среди присланных нет — добавь признак в uncertain, НЕ переноси его на другое фото. Не определяй и не называй цену. В values перечисли пары criterion_id/option_id только для различимых признаков; неразличимые добавь в uncertain. Если ни одно фото не относится к услуге — relevant=false. Не угадывай по плохому свету, обрезанным волосам или неподходящему ракурсу.`,
    parts: [
      ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.base64 } })),
      {
        text:
          images.length > 1
            ? `Фото ${images.length}, порядок — от старого к новому. Определи видимые признаки. Не угадывай.`
            : "Определи видимые признаки по фото. Не угадывай.",
      },
    ],
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        relevant: { type: "boolean" },
        values: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion_id: { type: "string" },
              option_id: { type: "string" },
            },
            required: ["criterion_id", "option_id"],
          },
        },
        uncertain: { type: "array", items: { type: "string" } },
      },
      required: ["relevant", "values", "uncertain"],
    },
    temperature: 0,
    maxOutputTokens: 512,
    thinkingBudget: 0,
    mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
  });
  if (!result.ok || !result.text) return { error: result.error ?? "vision failed" };
  try {
    const value = JSON.parse(result.text);
    if (
      typeof value.relevant !== "boolean" ||
      !Array.isArray(value.values) ||
      !Array.isArray(value.uncertain)
    )
      return { error: "invalid vision classification" };
    const values: Record<string, string> = {};
    for (const pair of value.values) {
      if (typeof pair?.criterion_id === "string" && typeof pair?.option_id === "string")
        values[pair.criterion_id] = pair.option_id;
    }
    return {
      relevant: value.relevant,
      values,
      uncertain: value.uncertain.filter((x: unknown) => typeof x === "string"),
    };
  } catch {
    return { error: "invalid vision JSON" };
  }
}

// Deterministic 32-bit hash from a string — used to derive a stable Gemini `seed` per
// (image + service + salon-config). Same photo + same salon → same seed → same price on
// repeat calls. Cheap and dependency-free (djb2-xor).
function stableSeed(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i);
  // Gemini seed field is a positive int32; mask to 31 bits so we're always in-range.
  return h & 0x7fffffff;
}

// Quantize a price to the nearest step, clamped inside [min, max]. Prevents "4732" answers
// and lets the salon think in round numbers (default 500 сом buckets).
function quantizePrice(p: number, step: number, min: number, max: number): number {
  const q = Math.round(p / step) * step;
  return Math.max(min, Math.min(max, q));
}

// Exported (see wa-agent-v4.server.ts) so V4 can call the SAME deterministic photo pricer.
// Previously V4 let the main model author the price band inline, which meant the same photo
// yielded different bands on repeat calls. V4's `estimate_price_from_photo` tool now delegates
// to this function so the seed+quantize+temperature:0 pipeline is one source of truth.
export async function priceFromPhoto(opts: {
  apiKey: string;
  imageBase64: string;
  mime: string;
  serviceName: string;
  priceMin: number;
  priceMax: number;
  pricingRules: string | null;
  language: "ru" | "ky" | "en";
  // Quantization step in salon currency (default: 500). All returned prices are rounded to
  // this bucket so two runs on the same photo cannot differ by a few сом.
  priceStep?: number;
}): Promise<
  | {
      // Narrow range the client sees ("3000–3500 сом"). low === high when confidence is high
      // and the model committed to a single bucket.
      price_low: number;
      price_high: number;
      // Backwards-compatible midpoint used by legacy call sites that still expect a single number.
      price: number;
      explanation: string;
      confidence: "high" | "medium" | "low";
    }
  | { error: string }
> {
  const langName =
    opts.language === "ky" ? "кыргызском" : opts.language === "en" ? "английском" : "русском";
  const step = opts.priceStep ?? 500;
  // Ceiling/floor to a valid multiple of `step` so the LLM is asked to pick within a
  // quantized set from the start (fewer rounding surprises after the fact).
  const stepMin = Math.ceil(opts.priceMin / step) * step;
  const stepMax = Math.floor(opts.priceMax / step) * step;
  const sys = `Ты оцениваешь стоимость услуги «${opts.serviceName}» по фото клиента.

ТВОЯ ЗАДАЧА — рассуждать как опытный мастер салона, а не выдавать среднее число. По шагам:
1) Что видно на фото (длина/густота/состояние волос, длина/форма/дизайн ногтей, объём работы, признаки повреждений, сложность).
2) Каков предполагаемый объём работы и расход материалов — короткая, длинная, простая, сложная.
3) Какой узкий ценовой диапазон это даёт внутри вилки [${opts.priceMin}, ${opts.priceMax}] сом.

ПРАВИЛА ОТВЕТА (жёстко):
- Итоговые price_low и price_high ОБЯЗАНЫ быть кратны ${step} сомам и лежать в [${stepMin}, ${stepMax}].
- Ширина диапазона (price_high − price_low) ≤ ${step} сомам. Если очень уверен — верни price_low = price_high (одно значение).
- price_low ≤ price_high; оба ≥ 0.
- Короткие/тонкие/простые случаи → нижняя часть вилки, длинные/густые/сложные → верхняя.
${opts.pricingRules ? `- Правила оценки от салона (СОБЛЮДАЙ): ${opts.pricingRules}` : ""}

ЧЕСТНОСТЬ ПО УВЕРЕННОСТИ (confidence):
- "low" — фото нечёткое, не с того ракурса, не показывает нужное или это вообще не то, о чём просит клиент. НЕ гадай — верни широкий диапазон (может доходить до всей вилки) и в explanation честно скажи, чего не хватает.
- "medium" — видно достаточно, но есть сомнения. Диапазон обычно шириной ${step} сомам.
- "high" — фото ясно показывает всё нужное. price_low обычно = price_high.

Поле "explanation" ОБЯЗАТЕЛЬНО пиши на ${langName} языке — клиент пишет боту именно на нём, смешение языков недопустимо. 1 короткое предложение по существу (что видишь + от чего зависит цена).

Верни СТРОГО JSON:
{"price_low": число, "price_high": число, "explanation": "1 предложение на ${langName}", "confidence": "high"|"medium"|"low"}`;

  // Same photo + same service + same price band + same salon rules → same seed → same
  // model output. This is the CORE fix for the "4500–5000 vs 4000–4500 on repeat" bug.
  const seed = stableSeed(
    `${opts.serviceName}|${opts.priceMin}|${opts.priceMax}|${step}|${opts.pricingRules ?? ""}|${opts.language}|${opts.imageBase64.length}|${opts.imageBase64.slice(0, 4096)}|${opts.imageBase64.slice(-4096)}`,
  );

  const res = await callGemini({
    model: MODEL_VISION,
    apiKey: opts.apiKey,
    systemInstruction: sys,
    parts: [
      { inline_data: { mime_type: opts.mime, data: opts.imageBase64 } },
      { text: "Оцени стоимость по фото по правилам выше." },
    ],
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        price_low: { type: "number" },
        price_high: { type: "number" },
        explanation: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["price_low", "price_high", "explanation", "confidence"],
    },
    // temperature: 0 + integer seed → maximally deterministic sampling. Any residual jitter
    // is bucketed away by quantizePrice() below.
    temperature: 0,
    seed,
    maxOutputTokens: 1024,
    // Vision call returns a tiny JSON — don't waste budget on hidden "thinking",
    // it leaves nothing for the actual output and we get finishReason=MAX_TOKENS.
    thinkingBudget: 0,
    // MEDIUM balances cost against the visual detail price estimation actually needs
    // (nail art complexity, hair length) — LOW is available as a cheaper fallback if
    // Gemini spend on this call still needs trimming later.
    mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
  });
  if (!res.ok || !res.text) return { error: res.error ?? "vision failed" };
  try {
    const j = JSON.parse(res.text);
    let lo = quantizePrice(Number(j.price_low), step, opts.priceMin, opts.priceMax);
    let hi = quantizePrice(Number(j.price_high), step, opts.priceMin, opts.priceMax);
    if (hi < lo) [lo, hi] = [hi, lo];
    // Cap width at 1 step — anything wider means the model hedged; keep the model's midpoint
    // but tighten to a single bucket for consistency with the prompt contract.
    if (hi - lo > step) {
      const mid = quantizePrice((lo + hi) / 2, step, opts.priceMin, opts.priceMax);
      lo = mid;
      hi = Math.min(opts.priceMax, mid + step);
    }
    const confidence: "high" | "medium" | "low" =
      j.confidence === "low" || j.confidence === "medium" ? j.confidence : "high";
    // Legacy `price` = midpoint of the range, quantized to the bucket. Existing call sites
    // that only look at a single number still work, they just get a stable rounded value.
    const price = quantizePrice((lo + hi) / 2, step, opts.priceMin, opts.priceMax);
    return {
      price_low: lo,
      price_high: hi,
      price,
      explanation: String(j.explanation ?? ""),
      confidence,
    };
  } catch (e: any) {
    return { error: e?.message ?? "parse failed" };
  }
}

export async function downloadImageAsBase64(
  url: string,
): Promise<{ base64: string; mime: string } | { error: string }> {
  // Simulator passes a data URL directly — extract base64 without any network request.
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) return { error: "invalid data url" };
    const header = url.slice(0, comma);
    const base64 = url.slice(comma + 1);
    const mime = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
    if (!base64) return { error: "empty data url" };
    return { base64, mime };
  }

  // Green-API signed URLs expire (~600s) and the network can stall — without a timeout a slow
  // fetch would hang the whole webhook (and the per-conversation lock) until it gave up.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return { error: `download ${r.status}` };
    const mime = r.headers.get("content-type") ?? "image/jpeg";
    const ab = await r.arrayBuffer();
    // We don't resize before sending to Gemini either way (no image codecs available on
    // Cloudflare Workers) — mediaResolution already caps Gemini's per-image cost, so the
    // only reason for a cap here is bounding our own fetch/memory use, not Gemini spend.
    if (ab.byteLength > 8 * 1024 * 1024) return { error: "image too large" };
    // Buffer is available in the Nitro/Node server runtime and is far faster than a
    // char-by-char btoa loop on large images.
    const base64 =
      typeof Buffer !== "undefined"
        ? Buffer.from(ab).toString("base64")
        : (() => {
            const bytes = new Uint8Array(ab);
            let bin = "";
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
          })();
    return { base64, mime };
  } catch (e: any) {
    if (e?.name === "AbortError") return { error: "download timed out" };
    return { error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// Voice message transcription (V4)
// ============================================================

// Transcribe a WhatsApp voice note (opus/ogg) with Gemini Flash — audio is a native input,
// no separate STT service needed. Returns plain text in the language actually spoken
// (ru/ky mixed speech is common in KG). Used by the V4 webhook path only.
export async function transcribeAudio(opts: {
  apiKey: string;
  audioBase64: string;
  mime: string; // e.g. "audio/ogg; codecs=opus"
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const res = await callGemini({
    model: MODEL_TEXT,
    apiKey: opts.apiKey,
    systemInstruction:
      "Ты — транскрибатор голосовых сообщений WhatsApp. Верни ТОЛЬКО дословный текст сообщения " +
      "на языке говорящего (русский или кыргызский, без перевода). Без комментариев, без кавычек. " +
      "Если запись пустая или неразборчива — верни ровно [неразборчиво].",
    parts: [
      { inline_data: { mime_type: opts.mime.split(";")[0].trim(), data: opts.audioBase64 } },
      { text: "Транскрибируй это голосовое сообщение." },
    ],
    temperature: 0,
    maxOutputTokens: 1024,
    thinkingBudget: 0,
  });
  if (!res.ok || !res.text) return { ok: false, error: res.error ?? "transcribe failed" };
  const text = res.text.trim();
  if (!text || /^\[неразборчиво\]$/i.test(text)) return { ok: false, error: "unintelligible" };
  return { ok: true, text };
}

// ============================================================
// State machine helpers
// ============================================================

function pickMasterFromCandidates(masters: DbMaster[], ids: string[]): DbMaster | null {
  const filtered = masters.filter((m) => ids.includes(m.id));
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  return filtered[0];
}

function matchMasterByName(masters: DbMaster[], name: string | undefined): DbMaster | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  const exact =
    masters.find((m) => m.name.toLowerCase() === norm) ??
    masters.find((m) => m.name.toLowerCase().startsWith(norm)) ??
    masters.find((m) => m.name.toLowerCase().includes(norm));
  if (exact) return exact;
  // Typo-tolerant fallback: closest name within ~40% edit distance ("Айгул" → "Айгуль", "Мария" → "Маша").
  let best: DbMaster | null = null;
  let bestDist = Infinity;
  for (const m of masters) {
    const cand = m.name.toLowerCase();
    const maxLen = Math.max(norm.length, cand.length);
    if (maxLen < 3) continue; // Allow matching even short names if they're close
    const d = levenshtein(norm, cand);
    // Increased tolerance: was maxLen/3 (~33%), now 40% for better fuzzy matches
    if (d <= Math.ceil(maxLen * 0.4) && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

// ============================================================
// Main entry
// ============================================================

export async function runWaAgent(input: WaAgentInput): Promise<WaAgentResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      reply: "Ассистент временно недоступен. Администратор салона ответит вам в ближайшее время.",
      nextState: input.state,
      nextStateData: input.stateData,
      appointmentId: null,
      selectedBranchId: input.selectedBranchId,
      debug: { actions: [], errors: ["GEMINI_API_KEY missing"] },
    };
  }

  const db = await getAdmin();
  const debug: WaAgentResult["debug"] = { actions: [], errors: [] };

  // Combine last unprocessed inbound messages into one logical client message.
  const lastTexts = input.lastMessages
    .filter((m) => m.direction === "in")
    .map((m) => (m.text_body ?? (m.kind === "image" ? "[фото]" : "")).trim())
    .filter(Boolean);
  const lastImage = [...input.lastMessages]
    .reverse()
    .find((m) => m.kind === "image" && m.media_signed_url);
  const combinedLastText = lastTexts.join(". ");

  const allowedLangs = input.config.languages?.length ? input.config.languages : ["ru"];
  const dateMap = buildDateMap(input.salon.timezone, 14);
  const services = await loadServicesForSalon(db, input.salon.salonId);

  // First contact = the assistant hasn't said anything yet in this session → greet warmly.
  // We trust an explicit `greeted` flag over history: history is loaded from `session_started_at`
  // and can be empty after a reload, which previously made the bot greet again and again.
  let isFirstContact =
    input.stateData.greeted !== true && !input.history.some((m) => m.direction === "out");

  // Determine language up front: prefer stored stateData, else detect.
  let language: "ru" | "ky" | "en" =
    (input.stateData.language as any) ??
    clampLanguage(detectLanguage(combinedLastText), allowedLangs);

  // Classify intent only if there is at least one inbound text or image.
  let intent: Intent = "other";
  let entities: Entities = {};
  if (combinedLastText || lastImage) {
    const c = await classify({
      apiKey,
      salon: input.salon,
      history: input.history,
      lastText: combinedLastText || "[фото]",
      services: services as any,
      branches: input.branches,
      dateMap,
    });
    intent = c.intent;
    entities = c.entities;
    // Sticky language: once a conversation language is set, keep it. Only switch when the new
    // message confidently signals another language — prevents a Kyrgyz chat from flipping to
    // Russian on a plain-Cyrillic word like "бугун".
    const detectedLang = clampLanguage(c.language, allowedLangs);
    const storedLang = input.stateData.language as "ru" | "ky" | "en" | undefined;
    if (!storedLang) language = detectedLang;
    else if (detectedLang !== storedLang && confidentLanguage(combinedLastText))
      language = detectedLang;
    else language = storedLang;
    debug.intent = intent;
    debug.entities = entities;
  }

  // Re-greet when user explicitly says hello and no booking is in progress yet.
  // Handles the case where session persists (12h timeout) but the user starts fresh.
  if (intent === "greet" && !input.stateData.service_id) {
    isFirstContact = true;
  }

  // Working copy of state
  let state: WaAgentState = input.state;
  let sd: WaAgentStateData = { ...input.stateData, language };
  // Once we greet, remember it for the whole session so we never greet twice.
  if (isFirstContact) sd.greeted = true;
  let selectedBranchId: string | null = input.selectedBranchId;
  let appointmentId: string | null = null;
  let factual = "";
  // Self-service link appended to the booking-confirmation reply. The INSERT confirmation
  // trigger skips ai_assistant bookings (the agent replies itself), so the link would never
  // reach WhatsApp-booked clients otherwise — the agent's own reply carries it.
  let bookingManageUrl: string | null = null;

  const tone = input.config.tone_instructions;
  const islamicGreeting = /ассаламу?\s*а?лейку?м|ассалму|салам\s+а?ллейку?м/i.test(
    combinedLastText,
  );
  const compose1 = (text: string) =>
    compose({
      apiKey,
      salon: input.salon,
      language,
      tone,
      greeting: input.config.greeting,
      history: input.history,
      factualContext: text,
      greet: isFirstContact,
      islamicGreeting,
    });

  // ----- Reset on cancel
  if (intent === "cancel") {
    sd = { language };
    state = "idle";
    factual = `Клиент отменил запрос. Скажи кратко: "хорошо, если передумаете — напишите".`;
    return {
      reply: await compose1(factual),
      nextState: state,
      nextStateData: sd,
      appointmentId: null,
      selectedBranchId,
      debug,
    };
  }

  // ----- General conversational answers — run BEFORE the booking state machine so these
  // questions are handled naturally regardless of where the client is in the booking flow.

  if (intent === "ask_schedule") {
    const wh = input.salonInfo?.working_hours as Record<string, string> | null | undefined;
    const dayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    const dayLabels: Record<string, string> = {
      mon: language === "ky" ? "Дүйш" : "Пн",
      tue: language === "ky" ? "Шейш" : "Вт",
      wed: language === "ky" ? "Шарш" : "Ср",
      thu: language === "ky" ? "Бейш" : "Чт",
      fri: language === "ky" ? "Жума" : "Пт",
      sat: language === "ky" ? "Ишем" : "Сб",
      sun: language === "ky" ? "Жек" : "Вс",
    };
    if (wh && dayKeys.some((k) => wh[k])) {
      const hoursStr = dayKeys
        .map((k) => (wh[k] ? `${dayLabels[k]}: ${wh[k]}` : null))
        .filter(Boolean)
        .join(", ");
      factual = `Клиент спрашивает о расписании работы. Расписание: ${hoursStr}. Ответь коротко и по-человечески, выдели нужный день если клиент спрашивал конкретно.`;
    } else {
      factual = `Клиент спрашивает о расписании. Данных о расписании нет. Вежливо предложи уточнить у администратора.`;
    }
    return finish();
  }

  if (intent === "ask_capability") {
    const capSvc = entities.service_id
      ? services.find((s: any) => s.id === entities.service_id)
      : null;
    if (capSvc) {
      const priceStr =
        (capSvc as any).price_type === "range"
          ? `${(capSvc as any).price}–${(capSvc as any).price_max} сом`
          : `${(capSvc as any).price} сом`;
      factual = `Клиент спросил, делаем ли мы «${(capSvc as any).name}». Ответь: да, делаем, стоимость ${priceStr}. Мягко предложи записаться, если интересно.`;
    } else {
      const serviceList = services
        .slice(0, 6)
        .map((s: any) => {
          const p =
            (s as any).price_type === "range"
              ? `${(s as any).price}–${(s as any).price_max}`
              : (s as any).price;
          return `${(s as any).name}: ${p} сом`;
        })
        .join(", ");
      factual = `Клиент спрашивает о возможностях салона: "${combinedLastText}". Ответь честно. Наши услуги: ${serviceList}. Если спрошенная услуга есть — скажи что делаем; если нет — скажи что не делаем и предложи что есть.`;
    }
    return finish();
  }

  // ----- Done state: graceful post-booking handling
  if (state === "done") {
    const newBookingIntents: Intent[] = [
      "choose_service",
      "ask_services",
      "ask_price",
      "choose_day",
      "choose_part_of_day",
      "choose_specific_time",
    ];
    if (newBookingIntents.includes(intent)) {
      // Client clearly wants a new booking — reset and fall through
      sd = { language };
      state = "idle";
    } else {
      // Closing phrase, complaint or acknowledgement — respond in context
      const isComplaint =
        /(неправил|не то|не туда|ошибк|не верн|неверн|не так|не на то|не 12|не на 12)/i.test(
          combinedLastText,
        );
      if (isComplaint) {
        factual = `Клиент говорит о проблеме с записью: "${combinedLastText}". Извинись искренне и предложи написать ещё раз чтобы переписаться, либо позвонить в салон напрямую.`;
      } else {
        factual = `Клиент написал после завершения записи: "${combinedLastText}". Ответь тепло и коротко — ждём вас! Если уместно, напомни про время записи из контекста. Не предлагай новую запись.`;
      }
      return {
        reply: await compose1(factual),
        nextState: "done",
        nextStateData: sd,
        appointmentId: null,
        selectedBranchId,
        debug,
      };
    }
  }

  // ----- Branch selection (only if multi-branch and not yet chosen)
  if (input.branches.length > 1) {
    if (intent === "choose_branch" && entities.branch_id) {
      const b = input.branches.find((x) => x.id === entities.branch_id);
      if (b) {
        selectedBranchId = b.id;
        sd.branch_id = b.id;
        debug.actions.push(`branch_selected:${b.id}`);
      }
    }
    if (!selectedBranchId) {
      const list = input.branches
        .map((b) => `— ${b.name}${b.address ? ", " + b.address : ""}`)
        .join("\n");
      factual = `Поприветствуй коротко и спроси, в какой филиал клиент хочет записаться. Перечисли:\n${list}`;
      state = "awaiting_branch";
      return {
        reply: await compose1(factual),
        nextState: state,
        nextStateData: sd,
        appointmentId: null,
        selectedBranchId,
        debug,
      };
    }
  } else if (input.branches.length === 1) {
    selectedBranchId = input.branches[0].id;
    sd.branch_id = input.branches[0].id;
  }

  // ----- Apply entity updates to state (before deciding next step)
  // Service
  if (entities.service_id) {
    const svc = services.find((s: any) => s.id === entities.service_id);
    if (svc) {
      if (sd.service_id !== svc.id) {
        // changing service resets dependent data
        sd.service_id = svc.id;
        sd.service_name = svc.name;
        sd.service_price_type = svc.price_type as any;
        sd.priced_value = undefined;
        sd.price_skipped = undefined;
        sd.master_id = undefined;
        sd.master_name = undefined;
        sd.slot_start = undefined;
        sd.slot_end = undefined;
        sd.candidate_master_ids = undefined;
        sd.specific_time = undefined;
      }
    }
  } else if (entities.service_query && !sd.service_id) {
    // Try fuzzy match
    const q = entities.service_query.toLowerCase();
    const hit = services.find(
      (s: any) =>
        s.name.toLowerCase() === q ||
        s.name.toLowerCase().includes(q) ||
        q.includes(s.name.toLowerCase()),
    );
    if (hit) {
      sd.service_id = (hit as any).id;
      sd.service_name = (hit as any).name;
      sd.service_price_type = (hit as any).price_type as any;
    }
  }

  // Day
  const { isoLocalDate: today, hour: nowHour, minute: nowMinute } = nowInTz(input.salon.timezone);
  if (entities.day_relative === "today") sd.day = today;
  else if (entities.day_relative === "tomorrow") sd.day = addDaysISO(today, 1);
  else if (entities.day_relative === "day_after_tomorrow") sd.day = addDaysISO(today, 2);
  else if (entities.day_iso && /^\d{4}-\d{2}-\d{2}$/.test(entities.day_iso))
    sd.day = entities.day_iso;

  // Part of day / specific time. Persist the stated time into stateData so it survives across
  // turns (e.g. if we have to ask the name first, "12:45" must not be forgotten).
  if (entities.part_of_day) sd.part_of_day = entities.part_of_day;
  if (entities.specific_time && /^\d{1,2}:\d{2}$/.test(entities.specific_time)) {
    sd.specific_time = entities.specific_time;
  }
  if (sd.specific_time) {
    // Derive part_of_day from the concrete time so the slot fetch is scoped correctly.
    const h = Number(sd.specific_time.split(":")[0]);
    sd.part_of_day = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  }

  // Client name
  if (entities.client_name) sd.client_name = entities.client_name.trim().slice(0, 80);
  else if (!sd.client_name && input.client.name) sd.client_name = input.client.name;

  // ----- "Any time" shortcut: in awaiting_part_of_day, "любое" → afternoon
  if (
    state === "awaiting_part_of_day" &&
    !sd.part_of_day &&
    !entities.specific_time &&
    intent === "any_master"
  ) {
    sd.part_of_day = "afternoon";
  }

  // ----- Slot selection from cache (for awaiting_slot_choice without specific_time entity)
  if (state === "awaiting_slot_choice" && !sd.slot_start && !entities.specific_time) {
    const cachedSlots: MergedSlot[] = (sd as any).slots_cache ?? [];
    if (cachedSlots.length > 0) {
      let picked: MergedSlot | undefined;
      if (entities.slot_number != null) {
        const idx =
          entities.slot_number < 0
            ? cachedSlots.length + entities.slot_number
            : entities.slot_number - 1;
        picked = cachedSlots[Math.max(0, Math.min(idx, cachedSlots.length - 1))];
      } else if (intent === "confirm_yes" || intent === "any_master") {
        picked = cachedSlots[0]; // first available
      }
      if (picked) {
        sd.slot_start = picked.start;
        sd.slot_end = picked.end;
        sd.candidate_master_ids = picked.master_ids;
        debug.actions.push(`slot_from_cache:${picked.start}`);
      }
    }
  }

  // ----- If the client changes time/day/service while we're on the confirmation step,
  // drop the resolved slot and step out of confirm so the flow re-resolves and re-confirms
  // with the NEW details (instead of booking the stale slot).
  // IMPORTANT: skip this guard for confirm_yes / deny_no — a confirmation is never a topic change.
  // Gemini sometimes returns a stray service_id entity even for "да", which previously caused the
  // guard to fire and loop the confirmation message instead of creating the appointment.
  if (
    state === "awaiting_final_confirm" &&
    intent !== "confirm_yes" &&
    intent !== "deny_no" &&
    (entities.specific_time ||
      entities.day_relative ||
      entities.day_iso ||
      entities.service_id ||
      entities.part_of_day)
  ) {
    sd.slot_start = undefined;
    sd.slot_end = undefined;
    sd.master_id = undefined;
    sd.master_name = undefined;
    sd.candidate_master_ids = undefined;
    state = "collecting";
    debug.actions.push("confirm_changed_reresolve");
  }

  // ----- Auto-select the only service: a salon with one service should never ask "which one?".
  if (!sd.service_id && services.length === 1) {
    const only: any = services[0];
    sd.service_id = only.id;
    sd.service_name = only.name;
    sd.service_price_type = only.price_type;
    debug.actions.push(`auto_service:${only.id}`);
  }

  // ===== State machine =====

  // 1) Need service?
  if (!sd.service_id) {
    if (services.length === 0) {
      factual = `Извинись: услуги ещё не настроены в системе. Попроси связаться с салоном напрямую.`;
      return finish();
    }
    const top = services
      .slice(0, 8)
      .map((s: any) => {
        const price = s.price_type === "range" ? `${s.price}–${s.price_max} сом` : `${s.price} сом`;
        return `— ${s.name}: ${price}`;
      })
      .join("\n");
    if (intent === "greet") {
      factual = `Поприветствуй клиента от имени салона «${input.salon.salonName}» и предложи помочь с записью. Перечисли услуги:\n${top}`;
    } else if (intent === "ask_price" || intent === "ask_services") {
      factual = `Клиент спросил об услугах/ценах. Перечисли услуги с ценами:\n${services
        .slice(0, 10)
        .map(
          (s: any) =>
            `— ${s.name}: ${s.price_type === "range" ? `${s.price}–${s.price_max}` : s.price} сом`,
        )
        .join("\n")}\nСпроси, на какую услугу записать.`;
    } else if (intent === "smalltalk" || intent === "other") {
      // If the message has no booking signals (no service/day/time) — pure smalltalk.
      // Answer naturally WITHOUT immediately pushing to booking.
      const hasBookingSignal =
        entities.service_id || entities.day_relative || entities.day_iso || entities.specific_time;
      if (!hasBookingSignal) {
        factual = `Клиент написал: "${combinedLastText}". Ответь по-человечески и тепло, без навязывания записи. Если это просто светская беседа — поддержи её кратко.`;
        sd.last_prompt = "service";
        state = "collecting";
        return finish();
      }
      factual = `Клиент написал: "${combinedLastText}". Ответь дружелюбно и мягко предложи помочь с записью в салон «${input.salon.salonName}».`;
    } else if (sd.last_prompt === "service") {
      // We already asked once and the client still didn't name a service — escalate gently
      // instead of repeating the exact same question verbatim.
      factual = `Клиент пока не выбрал услугу из списка. Мягко попроси написать название услуги именно из перечня или связаться с салоном напрямую. Перечисли:\n${top}`;
    } else {
      factual = `Спроси, на какую услугу записать. Перечисли доступные варианты:\n${top}`;
    }
    sd.last_prompt = "service";
    state = "collecting";
    return finish();
  }

  const svcRow: any = services.find((s: any) => s.id === sd.service_id);

  // 2) Range-priced service → photo flow before slots.
  // `price_skipped` means Vision failed earlier and we agreed the master prices on site — without
  // it the null `priced_value` made the bot ask for a photo again on every later turn.
  if (svcRow && svcRow.price_type === "range" && sd.priced_value == null && !sd.price_skipped) {
    // If client sent a photo this turn — call Vision
    if (lastImage && lastImage.media_signed_url) {
      const dl = await downloadImageAsBase64(lastImage.media_signed_url);
      if ("error" in dl) {
        debug.errors.push(`photo download: ${dl.error}`);
        factual = `Скажи: фото не удалось открыть, ориентировочная стоимость «${svcRow.name}» — ${svcRow.price}–${svcRow.price_max} сом (точную мастер уточнит на месте). Спроси на какой день записать.`;
        state = "collecting";
        sd.price_skipped = true;
        return finish();
      }
      const priced = await priceFromPhoto({
        apiKey,
        imageBase64: dl.base64,
        mime: dl.mime,
        serviceName: svcRow.name,
        priceMin: Number(svcRow.price),
        priceMax: Number(svcRow.price_max ?? svcRow.price),
        pricingRules: input.config.pricing_rules,
        language,
      });
      if ("error" in priced) {
        debug.errors.push(`vision: ${priced.error}`);
        // Change state to "collecting" so finish() sees state change → sameQuestion=false
        // → factual is shown instead of being swallowed by stuckClarifyReply.
        state = "collecting";
        sd.price_skipped = true;
        factual = `Скажи: по фото точную сумму определить не вышло, ориентировочная стоимость «${svcRow.name}» — ${svcRow.price}–${svcRow.price_max} сом (точную мастер озвучит на месте). Затем сразу спроси на какой день записать.`;
        return finish();
      } else {
        sd.priced_value = priced.price;
        state = "collecting"; // move past awaiting_photo so next turn goes to day selection
        const range =
          priced.price_low === priced.price_high
            ? `${priced.price_low} сом`
            : `${priced.price_low}–${priced.price_high} сом`;
        factual = `Скажи: по фото ориентировочная стоимость «${svcRow.name}» — ${range} (${priced.explanation}). Цена примерная, точную мастер уточнит на месте. Затем сразу спроси на какой день записать.`;
        return finish();
      }
    } else if (state === "awaiting_photo") {
      // Photo expected but didn't arrive — use a DIFFERENT last_prompt so finish() doesn't
      // trigger sameQuestion and swallow this message with stuckClarifyReply.
      factual = `Фото не получилось получить. Попроси прислать его ещё раз через иконку 📷.`;
      sd.last_prompt = "photo_retry";
      return finish();
    } else if (intent !== "confirm_yes") {
      factual = `Скажи, что услуга «${svcRow.name}» — с диапазоном цены ${svcRow.price}–${svcRow.price_max} сом, и попроси прислать фото, чтобы оценить стоимость точнее.`;
      state = "awaiting_photo";
      sd.last_prompt = "photo";
      return finish();
    }
  }
  if (state === "awaiting_price_confirm" && intent === "deny_no") {
    sd.priced_value = undefined;
    sd.service_id = undefined;
    sd.service_name = undefined;
    sd.service_price_type = undefined;
    factual = `Хорошо. Спроси, какую другую услугу подобрать.`;
    state = "collecting";
    return finish();
  }
  if (state === "awaiting_price_confirm" && intent === "confirm_yes") {
    // continue to slot flow
  }

  // 3) Need day?
  if (!sd.day) {
    const sample = dateMap
      .slice(0, 3)
      .map((d) => `${d.relative} (${d.label})`)
      .join(", ");
    factual = `Спроси, на какой день записать. Подскажи примеры: ${sample}.`;
    state = "collecting";
    return finish();
  }

  // Drop a part-of-day that has already passed for today (e.g. "утром" chosen at 17:00).
  if (
    sd.day === today &&
    sd.part_of_day &&
    !sd.specific_time &&
    !availablePartsToday(nowHour).includes(sd.part_of_day)
  ) {
    sd.part_of_day = undefined;
  }

  // 4) Need part of day or specific time?
  if (!sd.part_of_day && !sd.specific_time) {
    const parts =
      sd.day === today
        ? availablePartsToday(nowHour)
        : (["morning", "afternoon", "evening"] as const);
    if (parts.length === 0) {
      // The whole working day is already over for "today".
      sd.day = undefined;
      factual = `Скажи: на сегодня запись уже закрыта — рабочий день заканчивается. Спроси, на какой другой день записать (например, завтра).`;
      sd.last_prompt = "day";
      state = "collecting";
      return finish();
    }
    const list = parts.map((p) => PART_LABEL_RU[p]).join(", ");
    factual = `Спроси, когда клиенту удобнее. Доступные варианты: ${list}.`;
    sd.last_prompt = "part";
    state = "awaiting_part_of_day";
    return finish();
  }

  // 5) Load masters and fetch slots
  const masters = await loadMastersForService(
    db,
    input.salon.salonId,
    sd.service_id,
    selectedBranchId,
  );
  if (masters.length === 0) {
    factual = `Скажи: на услугу «${sd.service_name}» сейчас нет доступных мастеров. Предложи выбрать другую услугу.`;
    sd.service_id = undefined;
    sd.service_name = undefined;
    state = "collecting";
    return finish();
  }

  // Compute minStartTime: for today, must be > now + 15 min
  let minStart: Date | undefined;
  if (sd.day === today) {
    minStart = new Date(Date.now() + 15 * 60 * 1000);
  }

  // 5a) Specific time requested (this turn or remembered from a previous turn) — find exact slot
  const wantTimeRaw = entities.specific_time ?? sd.specific_time;
  if (wantTimeRaw && /^\d{1,2}:\d{2}$/.test(wantTimeRaw)) {
    const allSlots = await fetchMergedSlots({
      db,
      masters,
      serviceId: sd.service_id,
      day: sd.day,
      tz: input.salon.timezone,
      minStartTime: minStart,
      limit: 50,
    });
    const want = wantTimeRaw.padStart(5, "0");
    const exact = allSlots.find((s) => formatTimeInTz(s.start, input.salon.timezone) === want);
    if (exact) {
      sd.slot_start = exact.start;
      sd.slot_end = exact.end;
      sd.candidate_master_ids = exact.master_ids;
    } else {
      // Requested time unavailable — offer nearest, cache them for a quick pick ("первый"/время),
      // and clear the stored time so we don't keep re-resolving the same unavailable slot.
      const nearestSlots = allSlots.slice(0, 3);
      const nearest = nearestSlots.map((s) => formatTimeInTz(s.start, input.salon.timezone));
      const dateHuman = formatDateInTz(sd.day + "T12:00:00Z", input.salon.timezone);
      factual = nearest.length
        ? `Скажи: в ${want} ${dateHuman} свободного окна нет. Предложи ближайшие: ${nearest.join(", ")}.`
        : `Скажи: на ${dateHuman} (${sd.part_of_day ?? "выбранное время"}) свободных окон нет. Предложи другой день или часть дня.`;
      (sd as any).slots_cache = nearestSlots;
      sd.specific_time = undefined;
      sd.last_prompt = "slot";
      state = "awaiting_slot_choice";
      return finish();
    }
  }

  // 5b) No specific time — fetch by part of day
  if (!sd.slot_start) {
    const slots = await fetchMergedSlots({
      db,
      masters,
      serviceId: sd.service_id,
      day: sd.day,
      tz: input.salon.timezone,
      part: sd.part_of_day,
      minStartTime: minStart,
      limit: 4,
    });
    if (slots.length === 0) {
      const dateHuman = formatDateInTz(sd.day + "T12:00:00Z", input.salon.timezone);
      const partLabel =
        sd.part_of_day === "morning"
          ? "утром"
          : sd.part_of_day === "afternoon"
            ? "днём"
            : "вечером";
      factual = `Скажи: ${dateHuman} ${partLabel} свободных окон нет. Предложи другую часть дня или другой день.`;
      sd.part_of_day = undefined;
      state = "awaiting_part_of_day";
      return finish();
    }

    // If user already picked a specific time via intent choose_specific_time path, we wouldn't reach here.
    const timeList = slots.map((s) => formatTimeInTz(s.start, input.salon.timezone)).join(", ");
    const dateHuman = formatDateInTz(sd.day + "T12:00:00Z", input.salon.timezone);
    factual = `Скажи: на ${dateHuman} свободно: ${timeList}. Спроси, какое время выбрать.`;
    // Save slots in stateData (compact) so next turn can match user pick
    (sd as any).slots_cache = slots;
    state = "awaiting_slot_choice";
    return finish();
  }

  // 6) Resolve master (if slot has multiple)
  if (!sd.master_id && sd.candidate_master_ids && sd.candidate_master_ids.length > 0) {
    const candidates = masters.filter((x) => sd.candidate_master_ids!.includes(x.id));
    let chosen: DbMaster | null = null;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else if (entities.master_name) {
      chosen = matchMasterByName(candidates, entities.master_name);
    } else if (intent === "any_master") {
      chosen = pickMasterFromCandidates(masters, sd.candidate_master_ids);
    } else if (state === "awaiting_master_choice" && combinedLastText.trim()) {
      // Gemini didn't extract master_name — try matching the raw message directly.
      // Handles "УЛурга" (Kyrgyz case suffix -га) → "Улур", typos, mixed case, etc.
      chosen = matchMasterByName(candidates, combinedLastText.trim());
      if (chosen) debug.actions.push(`master_from_raw:${chosen.name}`);
    }
    if (chosen) {
      sd.master_id = chosen.id;
      sd.master_name = chosen.name;
    } else {
      // Either we haven't asked yet, or the client named a master we don't have for this slot.
      // Re-ask the master question with the valid names (don't fall through to a wrong prompt).
      const names = candidates.map((m) => m.name);
      const timeHuman = formatTimeInTz(sd.slot_start, input.salon.timezone);
      const andWord = language === "ky" ? " жана " : " и ";
      const anyPhrase = language === "ky" ? "баары бир" : "не принципиально";
      const prefix =
        entities.master_name && sd.last_prompt === "master"
          ? `Скажи: такого мастера на это время нет. На ${timeHuman} свободны: ${names.join(andWord)}.`
          : `Скажи: на ${timeHuman} свободны мастера ${names.join(andWord)}.`;
      factual = `${prefix} Спроси, к кому записать или «${anyPhrase}»`;
      sd.last_prompt = "master";
      state = "awaiting_master_choice";
      return finish();
    }
  }

  if (!sd.master_id) {
    // Shouldn't happen, but be defensive
    factual = `Уточни, пожалуйста, на какое время записать.`;
    state = "awaiting_slot_choice";
    return finish();
  }

  // 7) Need client name?
  if (!sd.client_name) {
    factual = `Спроси, как обращаться к клиенту (имя).`;
    sd.last_prompt = "name";
    state = "awaiting_name";
    return finish();
  }

  // 7.5) Confirmation gate — show a summary and require an explicit "yes" before booking.
  // This is the safety net against wrong-time bookings (e.g. 12:00 instead of 12:45).
  const confirmDate = formatDateInTz(sd.slot_start!, input.salon.timezone);
  const confirmTime = formatTimeInTz(sd.slot_start!, input.salon.timezone);
  if (state !== "awaiting_final_confirm") {
    const priceStr =
      sd.priced_value != null ? ` Стоимость по фото — около ${sd.priced_value} сом.` : "";
    factual = `Покажи краткую сводку и попроси подтвердить запись: услуга «${sd.service_name}», ${confirmDate} в ${confirmTime}, мастер ${sd.master_name}.${priceStr} Спроси: всё верно, записываю?`;
    sd.last_prompt = "confirm";
    state = "awaiting_final_confirm";
    return finish();
  }
  // Already awaiting confirmation. A changing entity (other time/day/service) would have been
  // handled by the re-resolve guard above and we wouldn't be here, so only yes/no/unclear remain.
  if (intent === "deny_no") {
    sd.slot_start = undefined;
    sd.slot_end = undefined;
    sd.master_id = undefined;
    sd.master_name = undefined;
    sd.candidate_master_ids = undefined;
    sd.specific_time = undefined;
    sd.part_of_day = undefined;
    factual = `Клиент не подтвердил. Спроси, на какое другое время или день записать.`;
    sd.last_prompt = "part";
    state = "awaiting_part_of_day";
    return finish();
  }
  if (intent !== "confirm_yes") {
    // Ambiguous reply while confirming — ask again clearly, do NOT book yet.
    factual = `Переспроси кратко и дружелюбно: подтверждаете запись на ${confirmDate} в ${confirmTime}? Ответьте «да», либо назовите другое время.`;
    return finish();
  }
  // intent === confirm_yes → fall through and create the appointment.

  // 8) Create appointment
  const rpcArgs: any = {
    _salon_id: input.salon.salonId,
    _master_id: sd.master_id,
    _service_id: sd.service_id,
    _starts_at: sd.slot_start,
    _client_name: sd.client_name,
    _client_phone: input.client.phone,
    _client_notes: null,
    _branch_id: selectedBranchId,
    _addon_ids: [],
    _source: "ai_assistant",
  };
  if (sd.priced_value != null && svcRow?.price_type === "range") {
    rpcArgs._price_override = sd.priced_value;
  }
  const { data: newId, error: bookErr } = await db.rpc("create_appointment", rpcArgs);
  if (bookErr) {
    debug.errors.push(`create_appointment: ${bookErr.message}`);
    // Recovery: slot might be taken (race). Reset slot/master and re-ask part of day.
    sd.slot_start = undefined;
    sd.slot_end = undefined;
    sd.master_id = undefined;
    sd.master_name = undefined;
    sd.candidate_master_ids = undefined;
    factual = `Скажи: к сожалению, это время только что заняли. Предложи выбрать другое окно.`;
    state = "awaiting_slot_choice";
    return finish();
  }

  appointmentId = newId as string;
  bookingManageUrl = await fetchManageUrl(db, appointmentId);
  const dateHuman = formatDateInTz(sd.slot_start!, input.salon.timezone);
  const timeHuman = formatTimeInTz(sd.slot_start!, input.salon.timezone);
  factual = `Скажи тепло и радостно: клиент успешно записан. Салон «${input.salon.salonName}», ${dateHuman} в ${timeHuman}, мастер ${sd.master_name}, услуга «${sd.service_name}». Поблагодари, скажи что ждём в гости, добавь один-два дружелюбных эмодзи.`;
  state = "done";
  // reset state_data so next conversation starts fresh
  sd = { language };
  return finish();

  // ----- closure helper to render and return
  async function finish(): Promise<WaAgentResult> {
    // Anti-loop: if the client's message was unrecognized AND we're about to re-ask the exact
    // same question as the previous turn, vary the wording and eventually hand off to a human,
    // instead of repeating the identical prompt forever (the live "тупит" symptom).
    const recognized = intent !== "other";
    const sameQuestion =
      state === input.state &&
      sd.last_prompt != null &&
      sd.last_prompt === input.stateData.last_prompt;
    // Count a "stuck" turn only when we did NOT make progress (intent unrecognized) AND either
    // the client said they didn't understand, or we're about to re-ask the very same question.
    // "не понял, давайте днём" is recognized progress → it must NOT count as stuck.
    const clientConfused = CONFUSED_RE.test(combinedLastText);
    if (!appointmentId && !recognized && (clientConfused || sameQuestion)) {
      sd.reask_count = Number(input.stateData.reask_count ?? 0) + 1;
    } else {
      sd.reask_count = 0;
    }

    if ((sd.reask_count ?? 0) >= 2) {
      // Tried twice and still stuck — give up gracefully and flag for a live admin.
      sd.needs_human = true;
      debug.actions.push("handoff_to_human");
      return {
        reply: humanHandoffReply(language, input.salon.salonName),
        nextState: state,
        nextStateData: sd,
        appointmentId,
        selectedBranchId,
        debug,
      };
    }
    if ((sd.reask_count ?? 0) === 1) {
      // Second time on the same question — rephrase deterministically with a concrete example.
      debug.actions.push("reask_clarify");
      return {
        reply: stuckClarifyReply(sd.last_prompt, language),
        nextState: state,
        nextStateData: sd,
        appointmentId,
        selectedBranchId,
        debug,
      };
    }

    let reply: string;
    try {
      reply = await compose1(factual);
      // Defense-in-depth: if the composer slipped in "сейчас проверю…"-style filler, drop it and
      // render the already-computed answer deterministically — the client always gets the result.
      if (V3_STALL_RE.test(reply)) {
        debug.errors.push("v3_stall_filtered");
        reply = instructionFallbackReply(factual, language, input.salon.salonName);
      }
    } catch (e: any) {
      const raw = instructionFallbackReply(factual, language, input.salon.salonName);
      if (isFirstContact && !/^\s*(здрав|привет|саламат|салам|hello|hi|hey|добр)/iu.test(raw)) {
        const g =
          input.config.greeting?.trim() ||
          (language === "ky" ? "Саламатсызбы!" : language === "en" ? "Hello!" : "Здравствуйте!");
        reply = `${g} ${raw}`.trim();
      } else {
        reply = raw;
      }
      debug.errors.push(`compose: ${e?.message ?? String(e)}`);
    }
    // Append the self-service link to the booking confirmation (deterministic — never let the
    // model paraphrase or drop the URL).
    if (bookingManageUrl && !reply.includes(bookingManageUrl)) {
      reply = `${reply}\n\n🔗 Перенести или отменить запись: ${bookingManageUrl}`;
    }
    return {
      reply,
      nextState: state,
      nextStateData: sd,
      appointmentId,
      selectedBranchId,
      debug,
    };
  }
}

// ============================================================
// Gemini tool-calling helper (used by V4 engine)
// ============================================================

export type GeminiV2Content = { role: "user" | "model"; parts: any[] };

// Create a Gemini cachedContents resource holding the stable per-conversation prefix
// (systemInstruction + tool declarations). Reused across every tool-loop iteration and
// every turn in the same session — cache reads process the prefix ~4x faster and cost
// ~25% of a fresh input token, so a 5-iteration turn saves ~15-20 s of wall time.
// Returns { name, expireTime } or null on failure — caller falls back to inline prompt.
// Minimum cacheable size is model-specific (~1024–4096 tokens for gemini-2.5-flash) — small
// prompts return 400; we silently return null and the caller keeps working non-cached.
export async function createGeminiCache(opts: {
  apiKey: string;
  systemInstruction: string;
  tools: any[];
  ttlSeconds?: number; // default 3600
}): Promise<{ name: string; expireTime: string } | null> {
  const ttl = opts.ttlSeconds ?? 3600;
  const body = {
    model: `models/${MODEL_TEXT}`,
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    tools: opts.tools?.length ? [{ functionDeclarations: opts.tools }] : undefined,
    ttl: `${ttl}s`,
  };
  // cachedContents lives at /v1beta/cachedContents — NOT under /models/. GEMINI_BASE ends in
  // "/models", so we strip that segment. (The earlier `${GEMINI_BASE}/cachedContents` built a
  // 404 path, so caching silently failed and always fell back to inline.)
  const cacheBase = GEMINI_BASE.replace(/\/models$/, "");
  const url = `${cacheBase}/cachedContents?key=${encodeURIComponent(opts.apiKey)}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      // 400 → prompt too small to cache; 4xx → skip caching this session
      console.warn(`[gemini-cache] create failed ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const json = (await r.json()) as any;
    if (!json?.name || !json?.expireTime) return null;
    return { name: json.name, expireTime: json.expireTime };
  } catch (e: any) {
    console.warn(`[gemini-cache] create threw: ${e?.message ?? e}`);
    return null;
  }
}

export async function callGeminiTools(opts: {
  apiKey: string;
  // Provide EITHER systemInstruction+tools inline (legacy path) OR cachedContent
  // (name from createGeminiCache) — cached path skips resending the prefix, saving
  // ~75% of input tokens processed per call and materially cutting latency.
  systemInstruction?: string;
  cachedContent?: string; // "cachedContents/xxx"
  contents: GeminiV2Content[];
  tools?: any[];
  allowedFunctionNames?: string[];
}): Promise<{ ok: boolean; parts?: any[]; error?: string; cacheMiss?: boolean }> {
  const noTools =
    Array.isArray(opts.allowedFunctionNames) && opts.allowedFunctionNames.length === 0;
  const fcConfig: any = noTools
    ? { mode: "NONE" }
    : opts.allowedFunctionNames
      ? { mode: "AUTO", allowedFunctionNames: opts.allowedFunctionNames }
      : { mode: "AUTO" };
  const usingCache = Boolean(opts.cachedContent);
  const body: any = {
    // When using cache: system + tools come from the cached resource — do NOT resend them
    // (Gemini rejects the request with 400 if both cache and systemInstruction are set).
    ...(usingCache
      ? { cachedContent: opts.cachedContent }
      : {
          ...(opts.systemInstruction
            ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } }
            : {}),
          ...(!noTools && opts.tools?.length
            ? { tools: [{ functionDeclarations: opts.tools }] }
            : {}),
        }),
    contents: opts.contents,
    toolConfig: { functionCallingConfig: fcConfig },
    generationConfig: {
      // 0.3 (down from 0.4) — tighter sampling for the V4 dialog. Still natural-sounding but
      // materially reduces run-to-run drift on quantitative outputs the model authors as text
      // (price_band strings, times, durations). Combined with the "price step" prompt rule in
      // buildSystemPromptV4, two identical inputs converge on the same price bucket.
      temperature: 0.3,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const url = `${GEMINI_BASE}/${MODEL_TEXT}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const MAX_ATTEMPTS = 4;
  const BACKOFF_CAP_MS = 4000;
  const lastAttempt = MAX_ATTEMPTS - 1;
  const waitFor = (retryAfterHdr: string | null, bodyTxt: string, attempt: number) => {
    let ms = 0;
    const hdr = Number(retryAfterHdr);
    if (Number.isFinite(hdr) && hdr > 0) ms = hdr * 1000;
    if (!ms) {
      const m = bodyTxt.match(/retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
      if (m) ms = Math.round(Number(m[1]) * 1000);
    }
    if (!ms) ms = 600 * 2 ** attempt;
    return Math.min(ms, BACKOFF_CAP_MS) + Math.floor(Math.random() * 250);
  };

  // Диагностика: запрос, на который Gemini не ответил ни на одну попытку, сохраняется целиком,
  // чтобы его можно было повторить задачей gemini-ping?replay=1 и увидеть, отвечает ли модель
  // медленно или не отвечает вовсе. Ключ в тело не входит — он в адресе.
  const failTotal = async (err: string) => {
    try {
      const { logError } = await import("@/lib/error-log.server");
      const raw = JSON.stringify(body);
      await logError({
        source: "wa-agent-v4",
        level: "warn",
        message: `gemini_tools total failure: ${err.slice(0, 200)}`,
        context: {
          kind: "gemini_tools_failure",
          bodyChars: raw.length,
          contentsCount: opts.contents.length,
          usingCache,
          body: raw.length <= 400_000 ? raw : null,
        },
      });
    } catch {
      /* диагностика не должна ронять ответ */
    }
    return { ok: false, error: err };
  };

  let lastErr = "gemini unknown";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const txt = await r.text();
      if (r.status === 429 || r.status >= 500) {
        lastErr = `gemini ${r.status}: ${txt.slice(0, 300)}`;
        if (attempt < lastAttempt) {
          await new Promise((res) =>
            setTimeout(res, waitFor(r.headers.get("retry-after"), txt, attempt)),
          );
          continue;
        }
        return await failTotal(lastErr);
      }
      if (!r.ok) {
        // Cache-miss detection: when the caller supplied cachedContent and Gemini rejects
        // with 400/404 mentioning the cache (expired TTL, wrong region, revoked), signal
        // it so runWaAgentV4 drops the stale cache name and retries inline this turn.
        const looksLikeCacheMiss =
          usingCache &&
          (r.status === 404 || (r.status === 400 && /cached ?content|cachedcontents/i.test(txt)));
        return {
          ok: false,
          error: `gemini ${r.status}: ${txt.slice(0, 300)}`,
          ...(looksLikeCacheMiss ? { cacheMiss: true } : {}),
        };
      }
      let json: any;
      try {
        json = JSON.parse(txt);
      } catch {
        return { ok: false, error: `gemini bad json: ${txt.slice(0, 200)}` };
      }
      const parts: any[] = (json?.candidates?.[0]?.content?.parts ?? []).filter(
        (p: any) => !p?.thought,
      );
      return { ok: true, parts };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (attempt < lastAttempt) {
        await new Promise((res) => setTimeout(res, waitFor(null, "", attempt)));
        continue;
      }
      return await failTotal(lastErr);
    }
  }
  return await failTotal(lastErr);
}

// ============================================================
// Green-API interactive message helpers (V3)
// ============================================================

export async function greenApiSendButtons(
  creds: GreenApiCreds,
  chatId: string,
  message: string,
  buttons: Array<{ id: string; text: string }>,
): Promise<{ ok: boolean; idMessage?: string; error?: string }> {
  try {
    const url = `https://api.green-api.com/waInstance${creds.instance}/sendButtons/${creds.token}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        message,
        buttons: buttons.map((b) => ({ buttonId: b.id, buttonText: b.text })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(txt);
    } catch {}
    if (!r.ok) return { ok: false, error: `green-api ${r.status}: ${txt.slice(0, 200)}` };
    return { ok: true, idMessage: json?.idMessage };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// Clickable reply buttons that DO work on regular (non-WABA) accounts — unlike the old
// sendButtons/sendListMessage. Beta, max 3 buttons, button text ≤ 25 chars. The tap comes
// back as typeMessage "interactiveButtonsReply" with templateButtonReplyMessage.selectedId.
export async function greenApiSendInteractiveButtons(
  creds: GreenApiCreds,
  chatId: string,
  body: string,
  buttons: Array<{ id: string; text: string }>,
): Promise<{ ok: boolean; idMessage?: string; error?: string }> {
  try {
    const url = `https://api.green-api.com/waInstance${creds.instance}/sendInteractiveButtons/${creds.token}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        body,
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          buttonId: b.id,
          buttonText: b.text.slice(0, 25),
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(txt);
    } catch {}
    if (!r.ok) return { ok: false, error: `green-api ${r.status}: ${txt.slice(0, 200)}` };
    return { ok: true, idMessage: json?.idMessage };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function greenApiSendListMessage(
  creds: GreenApiCreds,
  chatId: string,
  message: string,
  buttonText: string,
  sections: Array<{
    title?: string;
    rows: Array<{ rowId: string; title: string; description?: string }>;
  }>,
): Promise<{ ok: boolean; idMessage?: string; error?: string }> {
  try {
    const url = `https://api.green-api.com/waInstance${creds.instance}/sendListMessage/${creds.token}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message, buttonText, sections }),
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(txt);
    } catch {}
    if (!r.ok) return { ok: false, error: `green-api ${r.status}: ${txt.slice(0, 200)}` };
    return { ok: true, idMessage: json?.idMessage };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function menuRowIds(im: WaInteractiveMessage): string[] {
  return im.kind === "buttons"
    ? im.buttons.map((b) => b.id)
    : im.sections.flatMap((s) => s.rows.map((r) => r.rowId));
}

export function renderInteractiveAsText(
  reply: string,
  im: WaInteractiveMessage,
  language: "ru" | "ky" | "en",
): string {
  const lines: string[] = [];
  if (reply.trim()) lines.push(reply.trim());
  let n = 1;
  if (im.kind === "buttons") {
    lines.push("");
    for (const b of im.buttons) lines.push(`${n++}. ${b.text}`);
  } else {
    for (const sec of im.sections) {
      lines.push("");
      if (sec.title) lines.push(`*${sec.title}*`);
      for (const row of sec.rows) {
        const name = row.fullName ?? row.title;
        lines.push(`${n++}. ${name}${row.description ? ` — ${row.description}` : ""}`);
      }
    }
  }
  lines.push("");
  lines.push(
    language === "ky"
      ? "Номерин жазып жибериңиз (мисалы: 1)."
      : language === "en"
        ? "Reply with a number (e.g. 1)."
        : "Ответьте цифрой (например: 1).",
  );
  return lines.join("\n");
}

// ============================================================
// V3: Button/list-based booking flow
// ============================================================

type V3BookingState = {
  branch_id?: string;
  service_id?: string;
  service_name?: string;
  price_type?: "fixed" | "range";
  price_min?: number;
  price_max?: number;
  price_override?: number;
  price_skipped?: boolean;
  duration_min?: number; // service duration in minutes, shown in the confirmation summary
  photo_attempts?: number; // low-confidence photo pricing retries, before escalating to admin
  date?: string;
  slot_start?: string;
  slot_end?: string;
  master_id?: string;
  master_name?: string;
  client_name?: string;
  slots_cache?: Array<{ start: string; end: string; masterIds: string[] }>;
  // Cancel/reschedule of an EXISTING confirmed appointment — a side-quest that doesn't try
  // to preserve whatever new-booking flow was interrupted; it resolves back to "done" so a
  // client can just start a fresh booking afterwards if they were also mid-flow on one.
  managing_candidates?: Array<{ id: string; label: string }>;
  managing_appointment_id?: string;
  managing_appointment_label?: string;
  managing_service_id?: string;
  managing_master_id?: string;
  // Set only right after THIS turn created the appointment, so the "Перенести/Отменить" buttons
  // attached to the success message can jump straight into the manage flow without a DB lookup.
  managing_appointment_starts_at?: string;
  // "cancel_and_rebook" is the post-booking "Изменить" option: cancels the just-created
  // appointment, same as "cancel", but then routes straight into the service menu instead of
  // ending at "done" — for a client who realizes they picked the wrong service/master entirely.
  managing_action?: "cancel" | "reschedule" | "cancel_and_rebook";
  managing_request_text?: string; // original free-text ("перенесите на 19:00") carried past the choice step
  managing_new_slot_start?: string;
  managing_new_slot_end?: string;
  managing_new_master_id?: string; // set when the client agreed to move to ANOTHER master's slot
  managing_new_master_name?: string;
  managing_slots_cache?: Array<{
    start: string;
    end: string;
    master_id?: string;
    master_name?: string;
  }>;
};

function buildBranchListMsg(branches: WaBranchInfo[]): WaInteractiveMessage {
  return {
    kind: "list",
    text: "Выберите филиал:",
    buttonText: "Открыть список",
    sections: [
      {
        rows: branches.map((b) => ({
          rowId: `branch_${b.id}`,
          title: b.name.slice(0, 24),
          description: b.address?.slice(0, 72) ?? undefined,
        })),
      },
    ],
  };
}

// Green API / WhatsApp hard-caps list row titles at 24 chars. Truncate at a
// word boundary (not mid-word) and, when truncated, move the full name into
// the description so no information is lost.
function truncateRowTitle(name: string, max = 24): string {
  if (name.length <= max) return name;
  const slice = name.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 10 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + "…";
}

function formatDurationV3(
  minutes: number | null | undefined,
  language: "ru" | "ky" | "en",
): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (language === "ky") {
    const parts = [h > 0 ? `${h} саат` : null, m > 0 ? `${m} мүн` : null].filter(Boolean);
    return parts.join(" ");
  }
  if (language === "en") {
    const parts = [h > 0 ? `${h}h` : null, m > 0 ? `${m}m` : null].filter(Boolean);
    return parts.join(" ");
  }
  const parts = [h > 0 ? `${h} ч` : null, m > 0 ? `${m} мин` : null].filter(Boolean);
  return parts.join(" ");
}

function buildServiceListMsg(services: any[], language: "ru" | "ky" | "en"): WaInteractiveMessage {
  const question = language === "ky" ? "Кайсы кызматты тандайсыз?" : "Какую услугу выбираете?";
  const btnText = language === "ky" ? "Кызматты тандоо" : "Выбрать услугу";
  // Group by category
  const grouped = new Map<string, any[]>();
  for (const s of services) {
    const cat = s.category ?? (language === "ky" ? "Кызматтар" : "Услуги");
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(s);
  }
  const sections = Array.from(grouped.entries()).map(([title, rows]) => ({
    title,
    rows: rows.map((s: any) => {
      const priceStr =
        s.price_type === "range" ? `от ${s.price}–${s.price_max} сом` : `${s.price} сом`;
      const durationStr = formatDurationV3(s.duration_min, language);
      const description = durationStr ? `${priceStr} · ${durationStr}` : priceStr;
      return {
        rowId: `svc_${s.id}`,
        title: truncateRowTitle(s.name),
        description: description.slice(0, 72),
        // Full untruncated name — WhatsApp itself caps row titles at 24 chars,
        // but the admin simulator uses this to show the real name in full.
        fullName: s.name,
      };
    }),
  }));
  return { kind: "list", text: question, buttonText: btnText, sections };
}

// WhatsApp interactive lists allow at most 10 rows total. When a salon has more visible
// services than this, we can't show them all in one list, so the assistant first asks the
// client to pick a category, then shows only that category's services.
const SERVICE_LIST_ROW_LIMIT = 10;

function serviceCategory(s: any, language: "ru" | "ky" | "en"): string {
  return (s.category ?? (language === "ky" ? "Кызматтар" : "Услуги")) as string;
}

// Distinct categories in first-seen order (loadAiVisibleServicesForSalon already applies the
// salon's ai_category_order, so iteration order here is the admin-configured order).
function categoriesOf(services: any[], language: "ru" | "ky" | "en"): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const s of services) {
    const cat = serviceCategory(s, language);
    if (!seen.has(cat)) {
      seen.add(cat);
      order.push(cat);
    }
  }
  return order;
}

function buildCategoryListMsg(services: any[], language: "ru" | "ky" | "en"): WaInteractiveMessage {
  const question = language === "ky" ? "Кайсы багытты тандайсыз?" : "Выберите категорию услуг:";
  const btnText = language === "ky" ? "Багытты тандоо" : "Выбрать категорию";
  const counts = new Map<string, number>();
  for (const s of services) {
    const cat = serviceCategory(s, language);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const rows = categoriesOf(services, language)
    .slice(0, SERVICE_LIST_ROW_LIMIT)
    .map((cat) => ({
      rowId: `cat_${cat}`,
      title: truncateRowTitle(cat),
      description: (language === "ky"
        ? `${counts.get(cat)} кызмат`
        : `${counts.get(cat)} услуг`
      ).slice(0, 72),
      fullName: cat,
    }));
  return { kind: "list", text: question, buttonText: btnText, sections: [{ rows }] };
}

// Choose the first booking menu. We ALWAYS show the full service list (grouped under category
// headers) rather than a category-only picker: salon owners want every service visible up front
// so a client who doesn't recognise a category name still finds what they need. The old category
// gating existed only for WhatsApp's native 10-row list cap, but we render menus as numbered text
// (no cap) — and even on Cloud API a >10-row list simply falls back to that same numbered text.
function initialServiceMenu(
  services: any[],
  language: "ru" | "ky" | "en",
): { state: WaAgentState; msg: WaInteractiveMessage } {
  return { state: "awaiting_service", msg: buildServiceListMsg(services, language) };
}

// Appended as a trailing section on a list-type booking-flow message, so the client can return
// to the previous step instead of only ever being able to move forward. rowId is always "back" —
// handled by a dedicated check (right after selectedId is resolved) that routes to the previous
// step based on the CURRENT state. Only used in the NEW-BOOKING flow, not reschedule/manage
// (those don't have a comparable "previous step" to walk back through).
function backRow(language: "ru" | "ky" | "en") {
  return { rowId: "back", title: language === "ky" ? "◀️ Артка" : "◀️ Назад" };
}

function buildDateListMsg(
  dateMap: Array<{ iso: string; label: string; relative: string }>,
  language: "ru" | "ky" | "en",
  opts?: { back?: boolean },
): WaInteractiveMessage {
  const question = language === "ky" ? "Кайсы күнгө жазыласыз?" : "На какую дату запишем?";
  const rows = dateMap.slice(0, 7).map((d) => ({
    rowId: `date_${d.iso}`,
    title: (d.relative.startsWith("+") ? d.label : d.relative).slice(0, 24),
    description: d.label.slice(0, 72),
  }));
  const sections = [{ rows }, ...(opts?.back ? [{ rows: [backRow(language)] }] : [])];
  return { kind: "list", text: question, buttonText: "Выбрать дату", sections };
}

function buildSlotListMsg(
  slots: MergedSlot[],
  tz: string,
  language: "ru" | "ky" | "en",
  masterNames?: Map<string, string>, // when slots belong to different masters, show whose slot it is
  opts?: { back?: boolean },
): WaInteractiveMessage {
  const question = language === "ky" ? "Убакытты тандаңыз:" : "Выберите время:";
  const L = (ru: string, ky: string) => (language === "ky" ? ky : ru);
  const partTitles = {
    morning: L("Утром", "Эртең менен"),
    afternoon: L("Днём", "Түштө"),
    evening: L("Вечером", "Кечинде"),
  };
  // slots arrive already time-sorted; keep the ORIGINAL index in rowId (`slot_i`) so it maps
  // straight back to slots_cache[i] regardless of how we bucket them for display.
  const buckets: Record<"morning" | "afternoon" | "evening", any[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  slots.forEach((s, i) => {
    const h = parseInt(formatTimeInTz(s.start, tz).split(":")[0], 10);
    const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    buckets[part].push({
      rowId: `slot_${i}`,
      title: formatTimeInTz(s.start, tz),
      description: masterNames ? masterNames.get(s.master_ids[0] ?? "")?.slice(0, 72) : undefined,
    });
  });
  const sections: { title?: string; rows: any[] }[] = (["morning", "afternoon", "evening"] as const)
    .filter((p) => buckets[p].length > 0)
    .map((p) => ({ title: partTitles[p], rows: buckets[p] }));
  if (opts?.back) sections.push({ title: undefined, rows: [backRow(language)] });
  return {
    kind: "list",
    text: question,
    buttonText: L("Выбрать время", "Убакыт"),
    sections,
  };
}

function buildMasterListMsg(
  masters: DbMaster[],
  language: "ru" | "ky" | "en",
  opts?: { back?: boolean },
): WaInteractiveMessage {
  const question = language === "ky" ? "Мастерди тандаңыз:" : "Выберите мастера:";
  const rows = masters.map((m) => ({ rowId: `master_${m.id}`, title: m.name.slice(0, 24) }));
  const sections = [{ rows }, ...(opts?.back ? [{ rows: [backRow(language)] }] : [])];
  return { kind: "list", text: question, buttonText: "Выбрать мастера", sections };
}

// A tapped button may reach the state machine as the button TITLE ("✅ Да, записать") when
// the id is lost in transport — strip leading emoji/punctuation so ^-anchored regexes match.
function stripLeadingNonWord(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "");
}

function buildConfirmMsg(
  details: string,
  language: "ru" | "ky" | "en",
  opts?: { withReschedule?: boolean },
): WaInteractiveMessage {
  return {
    kind: "buttons",
    text: details,
    buttons: [
      { id: "confirm_yes", text: language === "ky" ? "✅ Ооба, жазылам" : "✅ Да, записать" },
      // Cloud API caps reply-button titles at 20 UTF-16 units, Green-API at 25 — both fit.
      ...(opts?.withReschedule
        ? [
            {
              id: "confirm_reschedule",
              text: language === "ky" ? "🔄 Башка убакыт" : "🔄 Нет, перенести",
            },
          ]
        : []),
      { id: "confirm_no", text: language === "ky" ? "❌ Жок, өзгөртөм" : "❌ Нет, изменить" },
    ],
  };
}

// Attached to the booking-success message so the client can reschedule/cancel/change the record
// they JUST created without having to guess free-text wording. Handled by the "postbook_"
// selectedId branch right before the idle/done greet block. Green-API caps reply buttons at 3.
function buildPostBookingMsg(language: "ru" | "ky" | "en"): WaInteractiveMessage {
  const text =
    language === "ky" ? "Дагы бир нерсе керекпи?" : "Нужно перенести или отменить запись?";
  return {
    kind: "buttons",
    text,
    buttons: [
      {
        id: "postbook_reschedule",
        text: language === "ky" ? "🔄 Убакытты которуу" : "🔄 Перенести запись",
      },
      {
        id: "postbook_cancel",
        text: language === "ky" ? "❌ Жокко чыгаруу" : "❌ Отменить запись",
      },
      {
        id: "postbook_change",
        text: language === "ky" ? "✏️ Кызматты которуу" : "✏️ Изменить запись",
      },
    ],
  };
}

function buildManageChoiceMsg(
  candidates: Array<{ id: string; label: string }>,
  language: "ru" | "ky" | "en",
): WaInteractiveMessage {
  const question = language === "ky" ? "Кайсы жазылууну тандайсыз?" : "Какую запись выбираем?";
  const rows = candidates.map((c) => ({
    rowId: `mgappt_${c.id}`,
    title: c.label.slice(0, 24),
    description: c.label.slice(0, 72),
  }));
  return {
    kind: "list",
    text: question,
    buttonText: language === "ky" ? "Тандоо" : "Выбрать",
    sections: [{ rows }],
  };
}

function buildManageActionMsg(language: "ru" | "ky" | "en"): WaInteractiveMessage {
  return {
    kind: "buttons",
    text: language === "ky" ? "Эмне кылабыз?" : "Что делаем с записью?",
    buttons: [
      { id: "manage_cancel", text: language === "ky" ? "❌ Жокко чыгаруу" : "❌ Отменить" },
      { id: "manage_reschedule", text: language === "ky" ? "📅 Которуу" : "📅 Перенести" },
      { id: "manage_leave", text: language === "ky" ? "Тийбе" : "Не трогать" },
    ],
  };
}

function parseDateFromTextV3(text: string, tz: string): string | null {
  const { isoLocalDate } = nowInTz(tz);
  const lower = text.toLowerCase();
  if (/сегодня|бүгүн|today/.test(lower)) return isoLocalDate;
  if (/послезавтра|бүрсүгүнү/.test(lower)) return addDaysISO(isoLocalDate, 2);
  if (/завтра|эртең|tomorrow/.test(lower)) return addDaysISO(isoLocalDate, 1);
  const m = text.match(/(\d{1,2})[./](\d{1,2})/);
  if (m) {
    const [y] = isoLocalDate.split("-").map(Number);
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

async function callGeminiV3Faq(
  apiKey: string,
  salonName: string,
  salonInfo: WaSalonInfo | null | undefined,
  config: WaAssistantConfig,
  userText: string,
  language: "ru" | "ky" | "en",
): Promise<string> {
  const langLabel = language === "ky" ? "кыргызском" : language === "en" ? "английском" : "русском";
  const sysLines = [
    `Ты — администратор салона «${salonName}». Отвечай кратко и дружелюбно на ${langLabel} языке.`,
    `Отвечай ТОЛЬКО на вопросы о салоне (расписание, адрес, услуги, мастера). Если вопрос не о салоне — вежливо откажись.`,
  ];
  if (salonInfo?.working_hours) {
    const wh = Object.entries(salonInfo.working_hours)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    sysLines.push(`Режим работы: ${wh}`);
  }
  if (salonInfo?.address) sysLines.push(`Адрес: ${salonInfo.address}`);
  if (config.tone_instructions) sysLines.push(config.tone_instructions);

  const url = `${GEMINI_BASE}/${MODEL_TEXT}:generateContent?key=${apiKey}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sysLines.join("\n") }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 400,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json: any = await r.json();
    return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  } catch {
    return "";
  }
}

// Regex-based manage detection missed, but the client has an upcoming appointment — ask
// Gemini whether the message is about cancelling/rescheduling it (tolerates typos like
// "пенеренести" and free phrasing like "можно в другой день?").
async function classifyManageIntentV3(
  apiKey: string,
  text: string,
): Promise<"cancel" | "reschedule" | null> {
  if (!apiKey || !text.trim()) return null;
  const res = await callGemini({
    model: MODEL_TEXT,
    apiKey,
    systemInstruction:
      "У клиента уже есть предстоящая запись. Определи по его сообщению (учитывай опечатки и разговорные формулировки, русский и кыргызский), что клиент хочет сделать с ЭТОЙ записью:\n" +
      '"cancel" — отменить запись;\n' +
      '"reschedule" — перенести её на другое время или день;\n' +
      '"none" — сообщение не об изменении существующей записи (приветствие, вопрос, желание записаться ещё раз).\n' +
      "Верни строго JSON.",
    parts: [{ text }],
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["cancel", "reschedule", "none"] } },
      required: ["action"],
    },
    temperature: 0,
    maxOutputTokens: 60,
    thinkingBudget: 0,
  });
  if (!res.ok || !res.text) return null;
  try {
    const parsed = JSON.parse(res.text);
    return parsed?.action === "cancel" || parsed?.action === "reschedule" ? parsed.action : null;
  } catch {
    return null;
  }
}

// Pulls an explicit clock time out of a manage message ("перенесите на 19:00", "в 7 вечера",
// "на 19.30"). Dot/dash separators are accepted only with a "в/на/к" prefix and 5-minute
// minutes, so numeric dates ("на 5.07") keep parsing as dates. Returns the time plus the
// text with the match removed (so date parsing doesn't misread "19.00" as день.месяц).
function extractManageTime(text: string): { time: string; rest: string } | null {
  const colon = text.match(/(?:^|[\s,])(?:в|на|к)?\s*(\d{1,2}):(\d{2})(?!\d)/i);
  const dotted = colon ? null : text.match(/(?:^|[\s,])(?:в|на|к)\s*(\d{1,2})[.\-](\d{2})(?!\d)/i);
  const m = colon ?? dotted;
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h <= 23 && min <= 59 && (colon != null || min % 5 === 0)) {
      return {
        time: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
        rest: text.replace(m[0], " "),
      };
    }
  }
  const worded = text.match(/(?:^|[\s,])(?:в|на|к)\s*(\d{1,2})\s*(час(?:а|ов)?|утра|дня|вечера)/i);
  if (worded) {
    let h = Number(worded[1]);
    const suf = worded[2].toLowerCase();
    if (suf === "вечера" && h < 12) h += 12;
    if (suf === "дня" && h <= 6) h += 12;
    if (h <= 23)
      return { time: `${String(h).padStart(2, "0")}:00`, rest: text.replace(worded[0], " ") };
  }
  return null;
}

function isoDateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function slotMinutesInTz(iso: string, tz: string): number {
  const [h, m] = formatTimeInTz(iso, tz).split(":").map(Number);
  return h * 60 + m;
}

// The requested time is taken — offer the n slots closest to it, in chronological order.
function nearestSlots(slots: MergedSlot[], reqTime: string, n: number, tz: string): MergedSlot[] {
  const [rh, rm] = reqTime.split(":").map(Number);
  const req = rh * 60 + rm;
  return [...slots]
    .sort(
      (a, b) =>
        Math.abs(slotMinutesInTz(a.start, tz) - req) - Math.abs(slotMinutesInTz(b.start, tz) - req),
    )
    .slice(0, n)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

const NATIVE_FALLBACK_GREETING: Record<"ky" | "en", string> = {
  ky: "Саламатсызбы! Жардам бере аламбы?",
  en: "Hello! How can I help you?",
};

async function translateGreetingV3(
  apiKey: string,
  text: string,
  targetLang: "ky" | "en",
): Promise<string> {
  if (!apiKey || !text.trim()) return "";
  const langName = targetLang === "ky" ? "кыргызский" : "английский";
  const sys = `Переведи текст приветствия администратора бизнеса на ${langName} язык. Сохрани тон, эмодзи и форматирование (переносы строк). Верни только перевод, без кавычек и пояснений.`;
  // Route through callGemini so we get its retry-on-5xx/network + MAX_TOKENS handling. The old
  // single-shot fetch with a 400-token cap intermittently returned empty (or truncated on the
  // salon's long promo greeting), which dropped the client to a generic "Чем помочь?" instead of
  // the admin-configured greeting. thinkingBudget:0 sends the whole budget to the actual output.
  const res = await callGemini({
    model: MODEL_TEXT,
    apiKey,
    systemInstruction: sys,
    parts: [{ text }],
    temperature: 0.3,
    maxOutputTokens: 1024,
    thinkingBudget: 0,
  });
  if (!res.ok || !res.text) {
    console.error("[wa-agent] greeting translate failed:", res.error);
    return "";
  }
  return res.text.replace(/^```[a-z]*|```$/gi, "").trim();
}

export async function runWaAgentV3(input: WaAgentInput): Promise<WaAgentResult> {
  const db = await getAdmin();
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const tz = input.salon.timezone;
  const debug: WaAgentResult["debug"] = { actions: [], errors: [] };

  // Detect language
  const rawTexts = input.lastMessages.map((m) => m.text_body ?? "").join(" ");
  const detectedLang = confidentLanguage(rawTexts) ? detectLanguage(rawTexts) : null;
  const persistedLang = (input.stateData as any).language as "ru" | "ky" | "en" | undefined;
  const language = clampLanguage(detectedLang ?? persistedLang ?? "ru", input.config.languages);

  // Extract selected_id (button/list tap) and combined text
  const lastImage = input.lastMessages.find((m) => m.kind === "image");
  const combinedText = input.lastMessages
    .filter((m) => m.kind !== "image")
    .map((m) => m.text_body ?? "")
    .join(" ")
    .trim();
  let selectedId: string | null =
    [...input.lastMessages].reverse().find((m) => m.selected_id)?.selected_id ?? null;
  // Real WhatsApp (Green-API) cannot render interactive lists/buttons, so the webhook
  // delivers them as a numbered text menu. A bare-number reply ("2") therefore means
  // "row #2 of the menu we showed last turn" — translate it into the same selected_id
  // a real list tap would produce. Row order is persisted in state_data.menu by finish().
  if (!selectedId) {
    const menu = (input.stateData as any).menu as string[] | undefined;
    const num = combinedText.match(/^\s*(\d{1,2})\s*[).]?$/);
    if (menu?.length && num) {
      const idx = parseInt(num[1], 10) - 1;
      if (idx >= 0 && idx < menu.length) {
        selectedId = menu[idx];
        debug.actions.push(`menu_pick:${idx + 1}`);
      }
    }
  }

  // V3 booking sub-state (persisted between turns in state_data.v3)
  const v3: V3BookingState = { ...((input.stateData as any).v3 ?? {}) };

  // Single-branch auto-fill
  const singleBranch = input.branches.length <= 1;
  if (!v3.branch_id && singleBranch && input.branches.length === 1) {
    v3.branch_id = input.branches[0].id;
  }

  // A bare greeting ("Здравствуйте", "Салам", "Ассалам алейкум") sent mid-dialog restarts the
  // conversation: drop the in-progress draft and fall through to the idle greet + menu block
  // below. Only when the message is PURELY a greeting (no button tap, no service/date mixed in),
  // so a client who types "привет, хочу стрижку" keeps their content instead of losing it.
  if (
    !selectedId &&
    input.state !== "idle" &&
    input.state !== "done" &&
    shouldGreetRestart(combinedText)
  ) {
    debug.actions.push("greeting_restart");
    for (const k of Object.keys(v3)) delete (v3 as any)[k];
    if (singleBranch && input.branches.length === 1) v3.branch_id = input.branches[0].id;
    input.state = "idle";
  }

  function finish(
    reply: string,
    nextState: WaAgentState,
    nextV3: V3BookingState = v3,
    interactiveMessage?: WaInteractiveMessage,
    appointmentId: string | null = null,
    notifyAdmin?: { mediaUrl: string; caption: string },
  ): WaAgentResult {
    return {
      reply,
      nextState,
      nextStateData: {
        language,
        v3: nextV3,
        // Remember the rows of the menu we are showing so a numeric reply next turn
        // can be mapped back to a rowId (see selectedId extraction above).
        ...(interactiveMessage ? { menu: menuRowIds(interactiveMessage) } : {}),
      } as any,
      appointmentId,
      selectedBranchId: nextV3.branch_id ?? input.selectedBranchId,
      debug,
      interactiveMessage,
      notifyAdmin,
    };
  }

  // A service row was chosen (via list tap, number, or text match) — advance to pricing
  // (range → ask for a photo) or straight to date selection. Shared by awaiting_service and
  // the awaiting_category text shortcut so the logic lives in one place.
  function advanceAfterService(svcRow: any, baseV3: V3BookingState): WaAgentResult {
    const newV3: V3BookingState = {
      ...baseV3,
      service_id: svcRow.id,
      service_name: svcRow.name,
      price_type: svcRow.price_type,
      price_min: svcRow.price,
      price_max: svcRow.price_max,
      duration_min: svcRow.duration_min ?? undefined,
    };
    if (svcRow.price_type === "range" && !newV3.price_override && !newV3.price_skipped) {
      const ask =
        language === "ky"
          ? `«${svcRow.name}» — баасы ${svcRow.price}–${svcRow.price_max} сом. Так баасын аныктоо үчүн фото жиберсеңиз болот же "жоксуз фото" деп жазыңыз.`
          : `Услуга «${svcRow.name}» — цена от ${svcRow.price} до ${svcRow.price_max} сом. Пришлите фото для точной оценки стоимости или напишите "без фото".`;
      return finish(ask, "awaiting_photo", newV3);
    }
    const dateMap = buildDateMap(tz, 7);
    const q =
      language === "ky"
        ? `*${svcRow.name}* — кайсы күнгө жазыласыз?`
        : `*${svcRow.name}* — выберите дату:`;
    return finish(
      q,
      "awaiting_date_choice",
      newV3,
      buildDateListMsg(dateMap, language, { back: true }),
    );
  }

  // Re-show the service menu after an unrecognized reply, honoring the category-first gating
  // (a >10-service salon must not be sent an invalid flat list — it goes back to categories).
  function reaskServiceMenu(reply: string, baseV3: V3BookingState, services: any[]): WaAgentResult {
    const menu = initialServiceMenu(services, language);
    return finish(reply, menu.state, baseV3, menu.msg);
  }

  // Booking summary + confirm buttons. Shared by awaiting_name and the paths where the name
  // is already known (re-selection after "Нет, перенести", unrecognized reply at confirm).
  function confirmBooking(nextV3: V3BookingState): WaAgentResult {
    const dateLabel = nextV3.date ? formatDateInTz(`${nextV3.date}T12:00:00Z`, tz) : "—";
    const timeLabel = nextV3.slot_start ? formatTimeInTz(nextV3.slot_start, tz) : "—";
    const masterLabel =
      nextV3.master_name ?? (language === "ky" ? "кез келген мастер" : "любой мастер");
    // Price line — ALWAYS shown when the salon knows a price for this service (owner requirement).
    // Priority: a photo-agreed sum (price_override) → a range → a fixed price. Only truly
    // unknown prices (no data at all) omit the line.
    const priceStr = (() => {
      const rangeLabel =
        language === "ky"
          ? "Болжолдуу баа"
          : language === "en"
            ? "Estimated price"
            : "Ориентировочная стоимость";
      const fixedLabel = language === "ky" ? "Баасы" : language === "en" ? "Price" : "Стоимость";
      if (nextV3.price_override != null) {
        return `\n💰 ${rangeLabel}: ${nextV3.price_override} сом`;
      }
      if (nextV3.price_type === "range" && nextV3.price_min != null && nextV3.price_max != null) {
        return `\n💰 ${rangeLabel}: ${nextV3.price_min}–${nextV3.price_max} сом`;
      }
      if (nextV3.price_min != null) {
        return `\n💰 ${fixedLabel}: ${nextV3.price_min} сом`;
      }
      return "";
    })();
    const durationStrRaw = formatDurationV3(nextV3.duration_min, language);
    const durationStr = durationStrRaw
      ? language === "ky"
        ? `\n⏳ Узактыгы: ${durationStrRaw}`
        : language === "en"
          ? `\n⏳ Duration: ${durationStrRaw}`
          : `\n⏳ Продолжительность: ${durationStrRaw}`
      : "";
    // Prefer the specific branch's address (multi-branch salon) over the salon-wide one.
    const branchAddress = nextV3.branch_id
      ? input.branches.find((b) => b.id === nextV3.branch_id)?.address
      : null;
    const address = branchAddress ?? input.salonInfo?.address ?? null;
    const addressLine = address ? `\n📍 ${address}` : "";
    const details =
      language === "ky"
        ? `✅ Жазылуу маалыматы:\n\n💇 ${nextV3.service_name}\n📅 ${dateLabel}\n⏰ ${timeLabel}${durationStr}\n👤 Мастер: ${masterLabel}\n🙍 Ат: ${nextV3.client_name}${priceStr}${addressLine}\n\nРастайсызбы?`
        : `✅ Данные записи:\n\n💇 ${nextV3.service_name}\n📅 ${dateLabel}\n⏰ ${timeLabel}${durationStr}\n👤 Мастер: ${masterLabel}\n🙍 Имя: ${nextV3.client_name}${priceStr}${addressLine}\n\nПодтверждаете?`;
    return finish(
      details,
      "awaiting_final_confirm",
      nextV3,
      buildConfirmMsg(details, language, { withReschedule: true }),
    );
  }

  const state = input.state;

  // ----- Cancel/reschedule cutoff (salon setting): visits starting sooner than this many
  // hours can only be changed by calling the salon directly.
  const manageCutoffHours = Math.max(0, Number(input.config.manage_cutoff_hours ?? 0) || 0);
  function isWithinManageCutoff(startsAt: string): boolean {
    if (!manageCutoffHours) return false;
    return new Date(startsAt).getTime() - Date.now() < manageCutoffHours * 3_600_000;
  }
  function manageCutoffMsg(): string {
    return language === "ky"
      ? `Жолугушууга ${manageCutoffHours} сааттан аз калды — жазылууну өзгөртүү үчүн салонго түз кайрылыңыз, сураныч. 🙏`
      : `До визита осталось меньше ${manageCutoffHours} ч. — чтобы отменить или перенести запись, пожалуйста, свяжитесь с салоном напрямую. 🙏`;
  }

  // Reschedule flow entry: try to honour a date/time the client already named
  // ("перенесите на завтра на 19:00") instead of walking them through date+slot lists.
  async function startRescheduleV3(
    baseV3: V3BookingState,
    requestText: string,
    apptStartsAt: string,
  ): Promise<WaAgentResult> {
    const v3r: V3BookingState = { ...baseV3, managing_action: "reschedule" };
    const timeHit = requestText ? extractManageTime(requestText) : null;
    const reqDate =
      parseDateFromTextV3(timeHit ? timeHit.rest : requestText, tz) ??
      // A bare time ("на 19:00") means the same day the appointment is currently on.
      (timeHit ? isoDateInTz(apptStartsAt, tz) : null);
    if (!reqDate) {
      const q = language === "ky" ? "Кайсы күнгө которобуз?" : "На какую дату переносим?";
      return finish(
        q,
        "awaiting_reschedule_date",
        v3r,
        buildDateListMsg(buildDateMap(tz, 7), language),
      );
    }
    return offerRescheduleSlots(v3r, reqDate, timeHit?.time ?? null);
  }

  // Shows reschedule options for a chosen date: exact requested time → straight to confirm;
  // busy → nearest slots of the same master; master fully booked → other masters who do the
  // service that day; nobody free → pick another date.
  async function offerRescheduleSlots(
    v3r: V3BookingState,
    dateIso: string,
    reqTime: string | null,
  ): Promise<WaAgentResult> {
    const masters = await loadMastersForService(
      db,
      input.salon.salonId,
      v3r.managing_service_id ?? "",
      null,
    );
    const own = masters.find((m) => m.id === v3r.managing_master_id);
    if (!own) {
      const msg =
        language === "ky"
          ? "Мастер табылган жок. Салонго кайрылыңыз."
          : "Не удалось найти мастера. Свяжитесь с салоном напрямую.";
      return finish(msg, "done", {});
    }
    const { isoLocalDate } = nowInTz(tz);
    const minStart = dateIso === isoLocalDate ? new Date() : undefined;
    const ownSlots = await fetchMergedSlots({
      db,
      masters: [own],
      serviceId: v3r.managing_service_id!,
      day: dateIso,
      tz,
      minStartTime: minStart,
      limit: MAX_SLOTS_SHOWN,
    });
    const dateLabel = formatDateInTz(`${dateIso}T12:00:00Z`, tz);

    if (reqTime) {
      const exact = ownSlots.find((s) => formatTimeInTz(s.start, tz) === reqTime);
      if (exact) {
        debug.actions.push(`reschedule_fast_path:${dateIso}T${reqTime}`);
        const details =
          language === "ky"
            ? `Жаңы убакыт: ${dateLabel}, ${reqTime}. Ырастайсызбы?`
            : `Новое время: ${dateLabel}, ${reqTime}. Подтверждаете?`;
        const newV3 = {
          ...v3r,
          managing_new_slot_start: exact.start,
          managing_new_slot_end: exact.end,
        };
        return finish(
          details,
          "awaiting_manage_confirm",
          newV3,
          buildConfirmMsg(details, language),
        );
      }
    }

    if (ownSlots.length > 0) {
      const chosen = reqTime ? nearestSlots(ownSlots, reqTime, 3, tz) : ownSlots;
      debug.actions.push(reqTime ? "reschedule_nearest_own" : "reschedule_slot_list");
      const cache = chosen.map((s) => ({ start: s.start, end: s.end }));
      const head = reqTime
        ? language === "ky"
          ? `Тилекке каршы, ${reqTime} бош эмес. Ошол күнү мастерде жакынкы бош убакыт:`
          : `К сожалению, на ${reqTime} занято. Ближайшее свободное время у мастера в этот день:`
        : language === "ky"
          ? `${dateLabel} — убакытты тандаңыз:`
          : `${dateLabel} — выберите время:`;
      return finish(
        head,
        "awaiting_reschedule_slot",
        { ...v3r, managing_slots_cache: cache },
        buildSlotListMsg(chosen, tz, language),
      );
    }

    // Own master fully booked that day → other masters offering the same service.
    const others = masters.filter((m) => m.id !== v3r.managing_master_id);
    const otherSlots =
      others.length > 0
        ? await fetchMergedSlots({
            db,
            masters: others,
            serviceId: v3r.managing_service_id!,
            day: dateIso,
            tz,
            minStartTime: minStart,
            limit: MAX_SLOTS_SHOWN,
          })
        : [];
    if (otherSlots.length > 0) {
      debug.actions.push("reschedule_other_masters");
      const byId = new Map(masters.map((m) => [m.id, m.name]));
      const chosen = reqTime ? nearestSlots(otherSlots, reqTime, 3, tz) : otherSlots;
      const cache = chosen.map((s) => ({
        start: s.start,
        end: s.end,
        master_id: s.master_ids[0],
        master_name: byId.get(s.master_ids[0] ?? "") ?? "",
      }));
      const head =
        language === "ky"
          ? `${own.name} ошол күнү бош эмес, бирок башка мастерлерде убакыт бар:`
          : `У мастера ${own.name} на этот день всё занято, но есть время у других мастеров:`;
      return finish(
        head,
        "awaiting_reschedule_slot",
        { ...v3r, managing_slots_cache: cache },
        buildSlotListMsg(chosen, tz, language, byId),
      );
    }

    debug.actions.push("reschedule_no_slots_that_day");
    const msg =
      language === "ky"
        ? "Бул күнгө бош убакыт жок. Башка күн тандаңыз:"
        : "На эту дату нет свободного времени ни у одного мастера. Выберите другую дату:";
    return finish(
      msg,
      "awaiting_reschedule_date",
      { ...v3r, managing_slots_cache: undefined },
      buildDateListMsg(buildDateMap(tz, 7), language),
    );
  }

  // ===== Manage an existing appointment (cancel/reschedule) — checked in ANY state except
  // while already inside this sub-flow, since a client might interrupt a new booking to deal
  // with an old appointment first ("на самом деле, отмените мою запись на завтра"). Resolves
  // back to "done" instead of trying to resume whatever new-booking flow was interrupted —
  // the client just re-starts a booking afterwards (which always shows the full menu again).
  const manageFlowStates: WaAgentState[] = [
    "awaiting_manage_choice",
    "awaiting_manage_action",
    "awaiting_reschedule_date",
    "awaiting_reschedule_slot",
    "awaiting_manage_confirm",
  ];
  // At the final-confirm step a text that is just a confirm-button title (id lost in
  // transport) must reach the confirm handler, not the manage-intent interception below —
  // "Нет, перенести" is about THIS draft, not an existing appointment.
  const looksLikeConfirmButtonTitle =
    state === "awaiting_final_confirm" &&
    /^(да, запис|нет, перенес|нет, измен|ооба, жазыл|башка убакыт|жок, өзгөрт)/.test(
      stripLeadingNonWord(combinedText.trim().toLowerCase()),
    );
  const manageEligible =
    !manageFlowStates.includes(state) &&
    !selectedId &&
    !!combinedText &&
    !looksLikeConfirmButtonTitle &&
    !shouldGreetRestart(combinedText);
  // "cancel"/"reschedule" when the wording is explicit (incl. fuzzy match for typos like
  // "пенеренести"), "ambiguous" for phrases like "не смогу прийти" that could mean either —
  // those still get the Отменить/Перенести buttons.
  let manageAction: "cancel" | "reschedule" | "ambiguous" | null = null;
  if (manageEligible) {
    const toks = normalizeForMatch(combinedText).split(/\s+/).filter(Boolean);
    const wantsCancel =
      /отмен/i.test(combinedText) ||
      /жокко чыгар/i.test(combinedText) ||
      fuzzyHit(toks, ["отмените", "отменить", "отмена", "отменяю", "отменим"], 2);
    const wantsReschedule =
      /перенес|перенос|перезапис/i.test(combinedText) ||
      /другое время|другой день|поменять время|поменять день|поменять запись/i.test(combinedText) ||
      /которуп ко|кийинкиге калтыр|башка убак/i.test(combinedText) ||
      fuzzyHit(toks, ["перенести", "перенесите", "перенос", "переносим", "перенесем"], 2);
    const ambiguous =
      /не смогу прийти|не могу прийти|не приду|не получится прийти|не успеваю/i.test(
        combinedText,
      ) || /келе албайм|жетишпейм/i.test(combinedText);
    if (wantsCancel) manageAction = "cancel";
    else if (wantsReschedule) manageAction = "reschedule";
    else if (ambiguous) manageAction = "ambiguous";
  }

  const loadUpcomingAppointments = async (): Promise<any[]> => {
    const { data: apptRows } = await db
      .from("appointments")
      .select("id, starts_at, service_id, master_id, services(name)")
      .eq("salon_id", input.salon.salonId)
      .eq("client_phone", input.client.phone)
      .eq("status", "confirmed")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at");
    return (apptRows ?? []) as any[];
  };

  let upcoming: any[] | null = null;
  // Wording didn't match, but the client may still be talking about an existing appointment
  // (typos, free phrasing). Ask Gemini — only from idle/done and only when there actually IS
  // an upcoming appointment, so we don't pay for a classification on every message.
  if (manageEligible && !manageAction && (state === "idle" || state === "done") && apiKey) {
    upcoming = await loadUpcomingAppointments();
    if (upcoming.length > 0) {
      const g = await classifyManageIntentV3(apiKey, combinedText);
      if (g) {
        manageAction = g;
        debug.actions.push(`manage_intent_gemini:${g}`);
      }
    }
  }

  if (manageAction) {
    upcoming ??= await loadUpcomingAppointments();

    if (upcoming.length > 0) {
      const candidates = upcoming.map((a) => ({
        id: a.id as string,
        label: `${a.services?.name ?? "?"} — ${formatDateInTz(a.starts_at, tz)}, ${formatTimeInTz(a.starts_at, tz)}`,
      }));
      if (upcoming.length === 1) {
        const a = upcoming[0];
        debug.actions.push(`manage_intent:1_found:${manageAction}`);
        if (isWithinManageCutoff(a.starts_at)) return finish(manageCutoffMsg(), "done", {});
        const newV3: V3BookingState = {
          managing_appointment_id: a.id,
          managing_appointment_label: candidates[0].label,
          managing_service_id: a.service_id,
          managing_master_id: a.master_id,
        };
        if (manageAction === "cancel") {
          // The client already said "отменить" — skip the action menu, go straight to confirm.
          const details =
            language === "ky"
              ? `Чын эле бул жазылууну жокко чыгарабызбы?\n${candidates[0].label}`
              : `Точно отменяем эту запись?\n${candidates[0].label}`;
          return finish(
            details,
            "awaiting_manage_confirm",
            { ...newV3, managing_action: "cancel" },
            buildConfirmMsg(details, language),
          );
        }
        if (manageAction === "reschedule") {
          return startRescheduleV3(newV3, combinedText, a.starts_at);
        }
        // Ambiguous ("не смогу прийти") → let the client pick cancel/reschedule/leave.
        const q =
          language === "ky"
            ? `Сиздин жазылууңуз: ${candidates[0].label}. Эмне кылабыз?`
            : `Ваша запись: ${candidates[0].label}. Что делаем?`;
        return finish(q, "awaiting_manage_action", newV3, buildManageActionMsg(language));
      }
      debug.actions.push(`manage_intent:${upcoming.length}_found:${manageAction}`);
      const q = language === "ky" ? "Кайсы жазылууну тандайсыз?" : "Какую запись выбираем?";
      // Remember the action (and the original text with its date/time) so after the client
      // picks WHICH appointment we don't re-ask what to do with it.
      return finish(
        q,
        "awaiting_manage_choice",
        {
          managing_candidates: candidates,
          managing_action: manageAction === "ambiguous" ? undefined : manageAction,
          managing_request_text: manageAction === "reschedule" ? combinedText : undefined,
        },
        buildManageChoiceMsg(candidates, language),
      );
    }
    debug.actions.push("manage_intent:none_found");
  }

  // ===== post-booking quick actions ("Перенести/Отменить/Изменить" attached to the success
  // message) — only for the exact rowIds from buildPostBookingMsg, tapped/numbered right after
  // THIS turn's booking; typed free text ("хочу перенести") is already handled by manageAction
  // above. =====
  const postBookingIds = ["postbook_reschedule", "postbook_cancel", "postbook_change"];
  if (
    (state === "idle" || state === "done") &&
    selectedId &&
    postBookingIds.includes(selectedId) &&
    v3.managing_appointment_id &&
    v3.managing_appointment_starts_at
  ) {
    debug.actions.push(`postbook_action:${selectedId}`);
    if (isWithinManageCutoff(v3.managing_appointment_starts_at)) {
      return finish(manageCutoffMsg(), "done", {});
    }
    if (selectedId === "postbook_cancel" || selectedId === "postbook_change") {
      const action = selectedId === "postbook_change" ? "cancel_and_rebook" : "cancel";
      const details =
        language === "ky"
          ? `Чын эле бул жазылууну жокко чыгарабызбы?\n${v3.managing_appointment_label}`
          : `Точно отменяем эту запись?\n${v3.managing_appointment_label}`;
      return finish(
        details,
        "awaiting_manage_confirm",
        { ...v3, managing_action: action },
        buildConfirmMsg(details, language),
      );
    }
    return startRescheduleV3(v3, "", v3.managing_appointment_starts_at);
  }

  // ===== "Назад" — step back through the NEW-BOOKING flow (service → date → slot → master/name).
  // Not offered in reschedule/manage states (manageFlowStates), which don't have a comparable
  // step-by-step draft to walk back through. Checked BEFORE any state-specific handler below, so
  // it always intercepts regardless of which step the client is currently on.
  if (selectedId === "back" && !manageFlowStates.includes(state)) {
    if (state === "awaiting_photo" || state === "awaiting_date_choice") {
      debug.actions.push("back:service");
      const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
      const msg = language === "ky" ? "Кызматты кайра тандаңыз:" : "Выберите услугу заново:";
      return reaskServiceMenu(
        msg,
        { branch_id: v3.branch_id, client_name: v3.client_name },
        services,
      );
    }
    if (state === "awaiting_slot_choice") {
      debug.actions.push("back:date");
      const msg = language === "ky" ? "Кайсы күнгө жазыласыз?" : "Выберите дату:";
      return finish(
        msg,
        "awaiting_date_choice",
        { ...v3, date: undefined, slots_cache: undefined },
        buildDateListMsg(buildDateMap(tz, 7), language, { back: true }),
      );
    }
    if (state === "awaiting_master_choice" || state === "awaiting_name") {
      debug.actions.push("back:slot");
      const cache = v3.slots_cache ?? [];
      const mockSlots: MergedSlot[] = cache.map((s) => ({
        start: s.start,
        end: s.end,
        master_ids: s.masterIds,
      }));
      const msg = language === "ky" ? "Убакытты тандаңыз:" : "Выберите время:";
      return finish(
        msg,
        "awaiting_slot_choice",
        {
          ...v3,
          slot_start: undefined,
          slot_end: undefined,
          master_id: undefined,
          master_name: undefined,
        },
        buildSlotListMsg(mockSlots, tz, language, undefined, { back: true }),
      );
    }
    // Unhandled state (e.g. idle/done, or a stale "back" from an expired menu) — fall through
    // to normal handling below; "back" just won't match anything and is treated as plain text.
  }

  // ===== idle / done → greet + first menu =====
  if (state === "idle" || state === "done") {
    const islamicGreeting = /ассаламу?\s*а?лейку?м|ассалму|салам\s+а?ллейку?м/i.test(combinedText);
    let greet = islamicGreeting
      ? language === "ky"
        ? "Ваалейкум ассалам! "
        : "Ваалейкум ас-салям! "
      : "";
    // The admin writes one greeting in Russian; for other client languages we
    // translate it on the fly (constrained to the salon's enabled languages),
    // instead of hardcoding per-language strings.
    const baseGreeting =
      input.config.greeting?.trim() ||
      `Здравствуйте! Я помощник салона «${input.salon.salonName}».`;
    if (language === "ru") {
      greet += baseGreeting;
    } else {
      const translated = await translateGreetingV3(apiKey, baseGreeting, language);
      // If translation still fails, show the admin's actual greeting (in Russian) rather than a
      // bare "Чем помочь?" — the client at least sees the salon's promo/instructions. Only fall
      // back to the tiny native line when the salon never set a custom greeting.
      greet +=
        translated || (input.config.greeting?.trim() ?? "") || NATIVE_FALLBACK_GREETING[language];
    }

    if (!singleBranch) {
      debug.actions.push("greet+branch_list");
      return finish(greet, "awaiting_branch", { ...v3 }, buildBranchListMsg(input.branches));
    }

    const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
    if (services.length === 0) {
      const msg =
        language === "ky"
          ? `${greet}\n\nКызматтар азырынча жок. Салонго түз кайрылыңыз.`
          : `${greet}\n\nУслуги ещё не настроены. Пожалуйста, свяжитесь с салоном напрямую.`;
      return finish(msg, "done", v3);
    }

    // Always show the full assistant menu on the first reply, regardless of what the
    // client's first message said (even if it already names a service) — the salon wants
    // every new conversation to see the greeting + service list + booking prompt up front,
    // not a shortcut straight into pricing/date for whatever the client happened to type.
    debug.actions.push("greet+service_list");
    const menu = initialServiceMenu(services, language);
    return finish(greet, menu.state, v3, menu.msg);
  }

  // ===== awaiting_branch =====
  if (state === "awaiting_branch") {
    let branchId: string | null = null;

    if (selectedId?.startsWith("branch_")) {
      branchId = selectedId.slice(7);
      debug.actions.push(`branch_selected:${branchId}`);
    } else if (combinedText) {
      const found = input.branches.find((b) => {
        const n = normalizeForMatch(b.name);
        const t = normalizeForMatch(combinedText);
        return n.includes(t) || t.includes(n);
      });
      if (found) {
        branchId = found.id;
        debug.actions.push(`branch_text_match:${found.id}`);
      }
    }

    if (!branchId) {
      const faqReply = combinedText
        ? await callGeminiV3Faq(
            apiKey,
            input.salon.salonName,
            input.salonInfo,
            input.config,
            combinedText,
            language,
          )
        : "";
      const reask = language === "ky" ? "Кайсы филиалды тандаңыз?" : "Пожалуйста, выберите филиал:";
      return finish(
        faqReply ? `${faqReply}\n\n${reask}` : reask,
        "awaiting_branch",
        v3,
        buildBranchListMsg(input.branches),
      );
    }

    const newV3 = { ...v3, branch_id: branchId };
    const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
    if (services.length === 0) {
      const msg =
        language === "ky" ? "Бул филиалда кызматтар жок." : "В этом филиале услуги не настроены.";
      return finish(msg, "done", newV3);
    }
    const menu = initialServiceMenu(services, language);
    const q =
      menu.state === "awaiting_category"
        ? language === "ky"
          ? "Кайсы багытты тандайсыз?"
          : "Выберите категорию услуг:"
        : language === "ky"
          ? "Кайсы кызматка жазыласыз?"
          : "На какую услугу вас записать?";
    return finish(q, menu.state, newV3, menu.msg);
  }

  // ===== awaiting_category (V3: only when a salon has more services than fit one list) =====
  if (state === "awaiting_category") {
    const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);

    // Client typed a service name directly ("хочу стрижку") → skip the category step.
    if (!selectedId?.startsWith("cat_") && combinedText) {
      const found = findServiceByText(combinedText, services);
      if (found) {
        debug.actions.push(`svc_text_match:${(found as any).id}`);
        return advanceAfterService(found as any, v3);
      }
    }

    // Resolve the chosen category (list tap / number → cat_<name>, or a typed category name).
    let category: string | null = null;
    if (selectedId?.startsWith("cat_")) {
      category = selectedId.slice(4);
      debug.actions.push(`cat_selected:${category}`);
    } else if (combinedText) {
      const t = normalizeForMatch(combinedText);
      category =
        categoriesOf(services, language).find((c) => {
          const n = normalizeForMatch(c);
          return !!n && (n.includes(t) || t.includes(n));
        }) ?? null;
      if (category) debug.actions.push(`cat_text_match:${category}`);
    }

    if (!category) {
      const faqCue =
        /\?|расписани|часы|работаете|адрес|где вы|умеете|делаете|ведёте|принимаете|жасайсыз|иштейсиз|убакт|дарек|канча|барбы/i.test(
          combinedText,
        );
      const faqReply =
        faqCue && combinedText
          ? await callGeminiV3Faq(
              apiKey,
              input.salon.salonName,
              input.salonInfo,
              input.config,
              combinedText,
              language,
            )
          : "";
      const reask = language === "ky" ? "Багытты тандаңыз:" : "Выберите, пожалуйста, категорию:";
      return finish(
        faqReply ? `${faqReply}\n\n${reask}` : reask,
        "awaiting_category",
        v3,
        buildCategoryListMsg(services, language),
      );
    }

    const inCat = services
      .filter((s: any) => serviceCategory(s, language) === category)
      .slice(0, SERVICE_LIST_ROW_LIMIT);
    if (inCat.length === 0) {
      const reask =
        language === "ky"
          ? "Бул багытта кызмат жок. Башка багытты тандаңыз:"
          : "В этой категории нет услуг. Выберите другую:";
      return finish(reask, "awaiting_category", v3, buildCategoryListMsg(services, language));
    }
    const q =
      language === "ky" ? `*${category}* — кызматты тандаңыз:` : `*${category}* — выберите услугу:`;
    return finish(q, "awaiting_service", v3, buildServiceListMsg(inCat, language));
  }

  // ===== awaiting_service =====
  if (state === "awaiting_service") {
    const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
    let serviceId: string | null = null;

    if (selectedId?.startsWith("svc_")) {
      serviceId = selectedId.slice(4);
      debug.actions.push(`svc_selected:${serviceId}`);
    } else if (combinedText) {
      const found = findServiceByText(combinedText, services);
      if (found) {
        serviceId = (found as any).id;
        debug.actions.push(`svc_text_match:${serviceId}`);
      }
    }

    if (!serviceId) {
      const faqCue =
        /\?|расписани|часы|работаете|адрес|где вы|умеете|делаете|ведёте|принимаете|жасайсыз|иштейсиз|убакт|дарек|канча|барбы/i.test(
          combinedText,
        );
      const faqReply =
        faqCue && combinedText
          ? await callGeminiV3Faq(
              apiKey,
              input.salon.salonName,
              input.salonInfo,
              input.config,
              combinedText,
              language,
            )
          : "";
      const reask = language === "ky" ? "Кызматты тандаңыз:" : "Выберите, пожалуйста, услугу:";
      return reaskServiceMenu(faqReply ? `${faqReply}\n\n${reask}` : reask, v3, services);
    }

    const svcRow = services.find((s: any) => s.id === serviceId) as any;
    if (!svcRow) {
      const reask =
        language === "ky"
          ? "Кызмат табылган жок. Кайра тандаңыз:"
          : "Услуга не найдена. Выберите ещё раз:";
      return reaskServiceMenu(reask, v3, services);
    }

    return advanceAfterService(svcRow, v3);
  }

  // ===== awaiting_photo =====
  if (state === "awaiting_photo") {
    const skipPhoto = /без\s*фото|жоксуз\s*фото|пропустить|skip/i.test(combinedText);

    if (lastImage?.media_signed_url) {
      const dl = await downloadImageAsBase64(lastImage.media_signed_url);
      if ("error" in dl) {
        debug.errors.push(`photo_dl:${dl.error}`);
        const msg =
          language === "ky"
            ? "Фото ачылган жок. Кайра жиберип коруңуз 📷 же «жоксуз фото» деп жазыңыз."
            : "Не удалось открыть фото. Попробуйте ещё раз 📷 или напишите «без фото».";
        return finish(msg, "awaiting_photo", v3);
      }
      const priced = await priceFromPhoto({
        apiKey,
        imageBase64: dl.base64,
        mime: dl.mime,
        serviceName: v3.service_name ?? "",
        priceMin: v3.price_min ?? 0,
        priceMax: v3.price_max ?? 0,
        pricingRules: input.config.pricing_rules,
        language,
      });
      const dateMap = buildDateMap(tz, 7);
      if ("error" in priced) {
        debug.errors.push(`vision:${priced.error}`);
        const msg =
          language === "ky"
            ? "Фото боюнча так баа аныктоо мүмкүн болгон жок. Мастер жолугушканда айтат."
            : "По фото точную цену определить не удалось. Мастер уточнит на месте.";
        const dateQ = language === "ky" ? "\n\nКайсы күнгө жазыласыз?" : "\n\nНа какую дату?";
        return finish(
          msg + dateQ,
          "awaiting_date_choice",
          { ...v3, price_skipped: true },
          buildDateListMsg(dateMap, language, { back: true }),
        );
      }

      if (priced.confidence === "low") {
        const attempts = (v3.photo_attempts ?? 0) + 1;
        if (attempts < 2) {
          debug.actions.push("photo_low_confidence_retry");
          const msg =
            language === "ky"
              ? "Сүрөттөн так айырмалоо кыйын болду 🙏 Жарыгы жакшы жерде, жакыныраак дагы бир сүрөт жиберип көрүңүзчү."
              : "По этому фото сложно точно оценить 🙏 Пришлите, пожалуйста, ещё одно фото — при хорошем освещении и поближе.";
          return finish(msg, "awaiting_photo", { ...v3, photo_attempts: attempts });
        }
        // Second low-confidence attempt in a row — hand off to a human instead of guessing.
        debug.actions.push("photo_low_confidence_escalate");
        const clientLabel = input.client.name
          ? `${input.client.name} (${input.client.phone})`
          : input.client.phone;
        const caption =
          language === "ky"
            ? `Кардар (${clientLabel}) «${v3.service_name}» кызматы боюнча фото жиберди, бирок ИИ баасын так аныктай алган жок.`
            : `Клиент (${clientLabel}) прислал фото для услуги «${v3.service_name}», но ИИ не смог уверенно оценить стоимость.`;
        const msg =
          language === "ky"
            ? "Кечиресиз, фото боюнча так баа бере албадым. Администраторго жибердим — ал сиз менен 5 мүнөттүн ичинде байланышат."
            : "Извините, не смог точно оценить по фото. Передал администратору — он свяжется с вами в течение 5 минут.";
        return finish(msg, "done", { ...v3, photo_attempts: attempts }, undefined, null, {
          mediaUrl: lastImage.media_signed_url,
          caption,
        });
      }

      const range =
        priced.price_low === priced.price_high
          ? `${priced.price_low} сом`
          : `${priced.price_low}–${priced.price_high} сом`;
      const msg =
        language === "ky"
          ? `💰 *Болжолдуу баа: ${range}*\n${priced.explanation}\n\nТак баасын мастер жерде тактайт.`
          : `💰 *Ориентировочная стоимость: ${range}*\n${priced.explanation}\n\nТочную сумму мастер уточнит на месте.`;
      const dateQ = language === "ky" ? "\n\nКайсы күнгө жазыласыз?" : "\n\nНа какую дату?";
      return finish(
        msg + dateQ,
        "awaiting_date_choice",
        { ...v3, price_override: priced.price },
        buildDateListMsg(dateMap, language, { back: true }),
      );
    }

    if (skipPhoto) {
      const dateMap = buildDateMap(tz, 7);
      const msg = language === "ky" ? "Жакшы. Кайсы күнгө жазыласыз?" : "Хорошо. На какую дату?";
      return finish(
        msg,
        "awaiting_date_choice",
        { ...v3, price_skipped: true },
        buildDateListMsg(dateMap, language, { back: true }),
      );
    }

    const msg =
      language === "ky"
        ? "Фото алынган жок. 📷 иконкасы аркылуу фото жиберип же «жоксуз фото» деп жазыңыз."
        : "Фото не получили. Отправьте фото через иконку 📷 или напишите «без фото».";
    return finish(msg, "awaiting_photo", v3);
  }

  // ===== awaiting_date_choice =====
  if (state === "awaiting_date_choice") {
    let dateIso: string | null = null;

    if (selectedId?.startsWith("date_")) {
      dateIso = selectedId.slice(5);
      debug.actions.push(`date_selected:${dateIso}`);
    } else if (combinedText) {
      dateIso = parseDateFromTextV3(combinedText, tz);
      if (dateIso) debug.actions.push(`date_text_parse:${dateIso}`);
    }

    const dateMap = buildDateMap(tz, 7);
    if (!dateIso) {
      const faqReply = combinedText.includes("?")
        ? await callGeminiV3Faq(
            apiKey,
            input.salon.salonName,
            input.salonInfo,
            input.config,
            combinedText,
            language,
          )
        : "";
      const reask = language === "ky" ? "Датаны тандаңыз:" : "Выберите дату:";
      return finish(
        faqReply ? `${faqReply}\n\n${reask}` : reask,
        "awaiting_date_choice",
        v3,
        buildDateListMsg(dateMap, language, { back: true }),
      );
    }

    let masters = await loadMastersForService(
      db,
      input.salon.salonId,
      v3.service_id!,
      v3.branch_id ?? null,
    );
    // After "Нет, перенести" the master is already chosen — offer only their slots,
    // falling back to everyone if that master no longer does the service.
    if (v3.master_id) {
      const kept = masters.filter((m) => m.id === v3.master_id);
      if (kept.length > 0) masters = kept;
    }
    if (masters.length === 0) {
      const msg =
        language === "ky"
          ? "Бул күнгө мастер жок. Башка күн тандаңыз:"
          : "На эту дату мастеров нет. Выберите другую дату:";
      return finish(
        msg,
        "awaiting_date_choice",
        v3,
        buildDateListMsg(dateMap, language, { back: true }),
      );
    }

    const { isoLocalDate } = nowInTz(tz);
    const minStart = dateIso === isoLocalDate ? new Date() : undefined;
    const slots = await fetchMergedSlots({
      db,
      masters,
      serviceId: v3.service_id!,
      day: dateIso,
      tz,
      minStartTime: minStart,
      limit: MAX_SLOTS_SHOWN,
    });

    if (slots.length === 0) {
      const msg =
        language === "ky"
          ? "Бул күнгө бош убакыт жок. Башка күн тандаңыз:"
          : "На эту дату нет свободных слотов. Выберите другую дату:";
      return finish(
        msg,
        "awaiting_date_choice",
        v3,
        buildDateListMsg(dateMap, language, { back: true }),
      );
    }

    const newV3: V3BookingState = {
      ...v3,
      date: dateIso,
      slots_cache: slots.map((s) => ({ start: s.start, end: s.end, masterIds: s.master_ids })),
    };

    const dateLabel = formatDateInTz(`${dateIso}T12:00:00Z`, tz);
    const msg =
      language === "ky" ? `${dateLabel} — убакытты тандаңыз:` : `${dateLabel} — выберите время:`;
    return finish(
      msg,
      "awaiting_slot_choice",
      newV3,
      buildSlotListMsg(slots, tz, language, undefined, { back: true }),
    );
  }

  function detectPartOfDayV3(text: string): "morning" | "afternoon" | "evening" | null {
    const t = text.toLowerCase();
    if (/обед|түш(түн|тө|кө)?\b|туш(тун|то|ко)?\b|полдень|дн[ёе]м/i.test(t)) return "afternoon";
    if (/утр[оаы]|таң\w*|эртең\s*менен|эртен\s*менен/i.test(t)) return "morning";
    if (/вечер|кеч(инде|ке|ки)?\b/i.test(t)) return "evening";
    return null;
  }

  // ===== awaiting_slot_choice =====
  if (state === "awaiting_slot_choice") {
    const slotsCache = v3.slots_cache ?? [];
    let slot: { start: string; end: string; masterIds: string[] } | null = null;

    if (selectedId?.startsWith("slot_")) {
      const idx = parseInt(selectedId.slice(5), 10);
      if (!isNaN(idx) && idx >= 0 && idx < slotsCache.length) {
        slot = slotsCache[idx];
        debug.actions.push(`slot_selected:${slot.start}`);
      }
    } else if (combinedText) {
      const timeMatch = combinedText.match(/\b(\d{1,2}):(\d{2})\b/);
      if (timeMatch) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        slot =
          slotsCache.find((s) => {
            const t = formatTimeInTz(s.start, tz);
            const [sh, sm] = t.split(":").map(Number);
            return sh === h && sm === m;
          }) ?? null;
        if (slot) debug.actions.push(`slot_time_match:${slot.start}`);
      }
      if (!slot) {
        const first = /^(1|перв|первый|первое|бирин)/i.test(combinedText.trim());
        const second = /^(2|втор|второй|второе|экин)/i.test(combinedText.trim());
        if (first && slotsCache[0]) slot = slotsCache[0];
        else if (second && slotsCache[1]) slot = slotsCache[1];
      }
    }

    // Stale-cache guard: the list was future-only when shown, but if the client took a while to
    // answer, a slot may have passed. Never let a now-past time through — re-fetch fresh slots.
    if (slot && new Date(slot.start).getTime() <= Date.now() && v3.date) {
      debug.actions.push(`slot_now_past:${slot.start}`);
      const all = await loadMastersForService(
        db,
        input.salon.salonId,
        v3.service_id!,
        v3.branch_id ?? null,
      );
      const kept = v3.master_id ? all.filter((m) => m.id === v3.master_id) : all;
      const fresh = await fetchMergedSlots({
        db,
        masters: kept.length > 0 ? kept : all,
        serviceId: v3.service_id!,
        day: v3.date,
        tz,
        minStartTime: new Date(),
        limit: MAX_SLOTS_SHOWN,
      });
      if (fresh.length === 0) {
        const msg =
          language === "ky"
            ? "Бул күнгө бош убакыт калган жок. Башка күн тандаңыз:"
            : "На эту дату свободного времени не осталось. Выберите другую дату:";
        return finish(
          msg,
          "awaiting_date_choice",
          { ...v3, slots_cache: undefined },
          buildDateListMsg(buildDateMap(tz, 7), language, { back: true }),
        );
      }
      const newV3: V3BookingState = {
        ...v3,
        slots_cache: fresh.map((s) => ({ start: s.start, end: s.end, masterIds: s.master_ids })),
      };
      const msg =
        language === "ky"
          ? "Бул убакыт өтүп кетти. Актуалдуу бош убакыттар:"
          : "Это время уже прошло. Вот актуальное свободное время:";
      return finish(
        msg,
        "awaiting_slot_choice",
        newV3,
        buildSlotListMsg(fresh, tz, language, undefined, { back: true }),
      );
    }

    const mockSlots: MergedSlot[] = slotsCache.map((s) => ({
      start: s.start,
      end: s.end,
      master_ids: s.masterIds,
    }));
    if (!slot) {
      const partOfDay = combinedText ? detectPartOfDayV3(combinedText) : null;
      if (partOfDay && slotsCache.length > 0) {
        const ranges: Record<typeof partOfDay, [number, number]> = {
          morning: [0, 12],
          afternoon: [12, 17],
          evening: [17, 24],
        };
        const [lo, hi] = ranges[partOfDay];
        const filtered = mockSlots.filter((s) => {
          const h = parseInt(formatTimeInTz(s.start, tz).split(":")[0], 10);
          return h >= lo && h < hi;
        });
        const label =
          partOfDay === "morning"
            ? language === "ky"
              ? "эртең менен"
              : "утром"
            : partOfDay === "afternoon"
              ? language === "ky"
                ? "түштө"
                : "днём"
              : language === "ky"
                ? "кечинде"
                : "вечером";
        if (filtered.length > 0) {
          const msg = language === "ky" ? `Бош убакыттар ${label}:` : `Свободное время ${label}:`;
          return finish(
            msg,
            "awaiting_slot_choice",
            v3,
            buildSlotListMsg(filtered, tz, language, undefined, { back: true }),
          );
        }
        const msg =
          language === "ky"
            ? `${label.charAt(0).toUpperCase() + label.slice(1)} бош орун жок. Башка убакытты тандаңыз:`
            : `${label.charAt(0).toUpperCase() + label.slice(1)} свободных окон нет. Выберите другое время:`;
        return finish(
          msg,
          "awaiting_slot_choice",
          v3,
          buildSlotListMsg(mockSlots, tz, language, undefined, { back: true }),
        );
      }
      const msg = language === "ky" ? "Убакытты тандаңыз:" : "Пожалуйста, выберите время:";
      if (slotsCache.length > 0)
        return finish(
          msg,
          "awaiting_slot_choice",
          v3,
          buildSlotListMsg(mockSlots, tz, language, undefined, { back: true }),
        );
      const dateMap = buildDateMap(tz, 7);
      return finish(
        msg,
        "awaiting_date_choice",
        { ...v3, date: undefined, slots_cache: undefined },
        buildDateListMsg(dateMap, language, { back: true }),
      );
    }

    const allMasters = await loadMastersForService(
      db,
      input.salon.salonId,
      v3.service_id!,
      v3.branch_id ?? null,
    );
    const eligible =
      slot.masterIds.length > 0
        ? allMasters.filter((m) => slot!.masterIds.includes(m.id))
        : allMasters;

    if (eligible.length === 0) {
      const msg =
        language === "ky"
          ? "Мастер табылган жок. Башка убакытты тандаңыз:"
          : "Мастер не найден. Выберите другое время:";
      return finish(
        msg,
        "awaiting_slot_choice",
        v3,
        buildSlotListMsg(mockSlots, tz, language, undefined, { back: true }),
      );
    }

    const newV3: V3BookingState = { ...v3, slot_start: slot.start, slot_end: slot.end };

    if (eligible.length === 1) {
      newV3.master_id = eligible[0].id;
      newV3.master_name = eligible[0].name;
      debug.actions.push(`auto_master:${eligible[0].id}`);
      // Name already collected earlier (e.g. re-selection after "Нет, перенести") → straight to confirm.
      if (newV3.client_name) return confirmBooking(newV3);
      const msg = language === "ky" ? "Атыңызды жазыңыз:" : "Введите ваше имя:";
      return finish(msg, "awaiting_name", newV3);
    }

    const msg = language === "ky" ? "Мастерди тандаңыз:" : "Выберите мастера:";
    return finish(
      msg,
      "awaiting_master_choice",
      newV3,
      buildMasterListMsg(eligible, language, { back: true }),
    );
  }

  // ===== awaiting_master_choice =====
  if (state === "awaiting_master_choice") {
    let masterId: string | null = null;

    if (selectedId?.startsWith("master_")) {
      masterId = selectedId.slice(7);
      debug.actions.push(`master_selected:${masterId}`);
    } else {
      const masters = await loadMastersForService(
        db,
        input.salon.salonId,
        v3.service_id!,
        v3.branch_id ?? null,
      );
      const found = matchMasterByName(masters, combinedText);
      if (found) {
        masterId = found.id;
        debug.actions.push(`master_text_match:${found.id}`);
      }
    }

    const masters = await loadMastersForService(
      db,
      input.salon.salonId,
      v3.service_id!,
      v3.branch_id ?? null,
    );
    if (!masterId) {
      const msg = language === "ky" ? "Мастерди тандаңыз:" : "Выберите мастера:";
      return finish(
        msg,
        "awaiting_master_choice",
        v3,
        buildMasterListMsg(masters, language, { back: true }),
      );
    }

    const master = masters.find((m) => m.id === masterId);
    const newV3 = { ...v3, master_id: masterId, master_name: master?.name ?? "" };
    if (newV3.client_name) return confirmBooking(newV3);
    const msg = language === "ky" ? "Атыңызды жазыңыз:" : "Введите ваше имя:";
    return finish(msg, "awaiting_name", newV3);
  }

  // ===== awaiting_name =====
  if (state === "awaiting_name") {
    const name = combinedText.trim().slice(0, 80);
    if (name.length < 2) {
      const msg = language === "ky" ? "Атыңызды жазыңыз:" : "Пожалуйста, введите ваше имя:";
      return finish(msg, "awaiting_name", v3);
    }

    return confirmBooking({ ...v3, client_name: name });
  }

  // ===== awaiting_final_confirm =====
  if (state === "awaiting_final_confirm") {
    // A tapped button normally arrives as selectedId; when it doesn't, the title text
    // ("✅ Да, записать") must still match — hence the emoji/punctuation strip.
    const ct = stripLeadingNonWord(combinedText.trim().toLowerCase());
    // Checked before confirmed/denied: "нет, перенести" starts with "нет" and would
    // otherwise fall into the full-reset branch; "давай перенесём" starts with "давай".
    const knownConfirmId =
      selectedId === "confirm_yes" ||
      selectedId === "confirm_no" ||
      selectedId === "confirm_reschedule";
    const reschedule =
      selectedId === "confirm_reschedule" ||
      (!knownConfirmId &&
        (/перенес|перенос|другое время|другой день/.test(ct) || /башка убакыт|которуу/.test(ct)));
    const confirmed =
      !reschedule &&
      (selectedId === "confirm_yes" ||
        /^(да|ок|ладно|согласен|согласна|подтвер|записывай|давай)/.test(ct) ||
        /^(ооба|макул|жазыл)/.test(ct));
    const denied =
      !reschedule &&
      !confirmed &&
      (selectedId === "confirm_no" ||
        /^(нет|не надо|отмен|изменить|другой|другую|поменяй)/.test(ct) ||
        /^(жок|өзгөрт)/.test(ct));

    if (reschedule) {
      // Keep service, master and name — only the date/time is re-selected.
      debug.actions.push("confirm_reschedule");
      const newV3: V3BookingState = {
        ...v3,
        date: undefined,
        slot_start: undefined,
        slot_end: undefined,
        slots_cache: undefined,
      };
      const msg =
        language === "ky"
          ? "Жакшы, башка убакыт тандайлы. Датаны тандаңыз:"
          : "Хорошо, выберем другое время. Выберите дату:";
      return finish(
        msg,
        "awaiting_date_choice",
        newV3,
        buildDateListMsg(buildDateMap(tz, 7), language),
      );
    }

    if (denied) {
      // Full reset: the client wants something else entirely — start over from the service
      // menu, keeping only the branch and the name.
      debug.actions.push("confirm_denied_full_reset");
      const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
      const newV3: V3BookingState = { branch_id: v3.branch_id, client_name: v3.client_name };
      const msg =
        language === "ky"
          ? "Жакшы, кайра баштайлы. Кызматты тандаңыз:"
          : "Хорошо, начнём заново. Выберите услугу:";
      return reaskServiceMenu(msg, newV3, services);
    }

    if (!confirmed) {
      return confirmBooking(v3);
    }

    debug.actions.push("create_appointment");
    try {
      const rpcArgs: any = {
        _salon_id: input.salon.salonId,
        _master_id: v3.master_id,
        _service_id: v3.service_id,
        _starts_at: v3.slot_start,
        _client_name: v3.client_name,
        _client_phone: input.client.phone,
        _client_notes: null,
        _branch_id: v3.branch_id ?? null,
        _addon_ids: [],
        _source: "ai_assistant",
      };
      if (v3.price_override != null) rpcArgs._price_override = v3.price_override;
      const { data: newId, error } = await db.rpc("create_appointment", rpcArgs);
      if (error) throw error;

      const dateLabel = v3.date ? formatDateInTz(`${v3.date}T12:00:00Z`, tz) : "";
      const timeLabel = v3.slot_start ? formatTimeInTz(v3.slot_start, tz) : "";
      // Prefer the specific branch's address (multi-branch salon) over the salon-wide one.
      const branchAddress = v3.branch_id
        ? input.branches.find((b) => b.id === v3.branch_id)?.address
        : null;
      const address = branchAddress ?? input.salonInfo?.address ?? null;
      const addressLine = address ? `\n📍 ${address}` : "";
      const successMsg =
        language === "ky"
          ? `🎉 Жазылуу ырасталды!\n\n📅 ${dateLabel}, ⏰ ${timeLabel}\n💇 ${v3.service_name}${addressLine}\n\nКүтөбүз! ❤️`
          : `🎉 Запись подтверждена!\n\n📅 ${dateLabel}, ⏰ ${timeLabel}\n💇 ${v3.service_name}${addressLine}\n\nДо встречи! ❤️`;
      // Keep enough of the just-created appointment in state so the "Перенести/Отменить" buttons
      // attached below can jump straight into the manage flow without a DB lookup.
      const postBookingV3: V3BookingState = {
        branch_id: v3.branch_id,
        managing_appointment_id: newId as string,
        managing_appointment_label: `${v3.service_name} — ${dateLabel}, ${timeLabel}`,
        managing_service_id: v3.service_id,
        managing_master_id: v3.master_id,
        managing_appointment_starts_at: v3.slot_start,
      };
      return finish(
        successMsg,
        "done",
        postBookingV3,
        buildPostBookingMsg(language),
        newId as string,
      );
    } catch (e: any) {
      debug.errors.push(`create_appointment:${e?.message ?? e}`);
      const msg =
        language === "ky"
          ? "Жазылуу мүмкүн болгон жок. Кайра аракет кылып же салонго түз кайрылыңыз."
          : "Не удалось создать запись. Попробуйте ещё раз или свяжитесь с салоном напрямую.";
      return finish(msg, "awaiting_final_confirm", v3);
    }
  }

  // ===== awaiting_manage_choice =====
  if (state === "awaiting_manage_choice") {
    const candidates = v3.managing_candidates ?? [];
    const chosenId = selectedId?.startsWith("mgappt_") ? selectedId.slice(7) : null;
    if (!chosenId) {
      const msg = language === "ky" ? "Кайсы жазылууну тандайсыз?" : "Выберите запись из списка:";
      return finish(msg, "awaiting_manage_choice", v3, buildManageChoiceMsg(candidates, language));
    }
    const { data: a } = await db
      .from("appointments")
      .select("id, starts_at, service_id, master_id, services(name)")
      .eq("id", chosenId)
      .maybeSingle();
    if (!a) {
      const msg = language === "ky" ? "Жазылуу табылган жок." : "Запись не найдена.";
      return finish(msg, "done", {});
    }
    const label = `${(a as any).services?.name ?? "?"} — ${formatDateInTz((a as any).starts_at, tz)}, ${formatTimeInTz((a as any).starts_at, tz)}`;
    if (isWithinManageCutoff((a as any).starts_at)) return finish(manageCutoffMsg(), "done", {});
    const newV3: V3BookingState = {
      managing_appointment_id: a.id,
      managing_appointment_label: label,
      managing_service_id: (a as any).service_id,
      managing_master_id: (a as any).master_id,
    };
    // The client already said what to do before picking the appointment — don't re-ask.
    if (v3.managing_action === "cancel") {
      const details =
        language === "ky"
          ? `Чын эле бул жазылууну жокко чыгарабызбы?\n${label}`
          : `Точно отменяем эту запись?\n${label}`;
      return finish(
        details,
        "awaiting_manage_confirm",
        { ...newV3, managing_action: "cancel" },
        buildConfirmMsg(details, language),
      );
    }
    if (v3.managing_action === "reschedule") {
      return startRescheduleV3(newV3, v3.managing_request_text ?? "", (a as any).starts_at);
    }
    const q =
      language === "ky" ? `Тандалды: ${label}. Эмне кылабыз?` : `Выбрано: ${label}. Что делаем?`;
    return finish(q, "awaiting_manage_action", newV3, buildManageActionMsg(language));
  }

  // ===== awaiting_manage_action =====
  if (state === "awaiting_manage_action") {
    const wantsCancel =
      selectedId === "manage_cancel" || /отмен/i.test(combinedText) || /жокко/i.test(combinedText);
    const wantsReschedule =
      selectedId === "manage_reschedule" ||
      /перенес|перенос/i.test(combinedText) ||
      /которуп/i.test(combinedText);
    const wantsLeave =
      selectedId === "manage_leave" ||
      /не трогай|оставь|не надо/i.test(combinedText) ||
      /тийбе/i.test(combinedText);

    if (wantsLeave) {
      const msg =
        language === "ky" ? "Жакшы, эч нерсе өзгөртүлгөн жок." : "Хорошо, ничего не меняю.";
      return finish(msg, "done", {});
    }
    if (wantsCancel) {
      const details =
        language === "ky"
          ? `Чын эле бул жазылууну жокко чыгарабызбы?\n${v3.managing_appointment_label}`
          : `Точно отменяем эту запись?\n${v3.managing_appointment_label}`;
      return finish(
        details,
        "awaiting_manage_confirm",
        { ...v3, managing_action: "cancel" },
        buildConfirmMsg(details, language),
      );
    }
    if (wantsReschedule) {
      // The client may have typed the target right here ("перенесите на завтра в 19:00") —
      // startRescheduleV3 honours it and only falls back to the date list when nothing parsed.
      const { data: apptRow } = await db
        .from("appointments")
        .select("starts_at")
        .eq("id", v3.managing_appointment_id!)
        .maybeSingle();
      return startRescheduleV3(
        v3,
        combinedText,
        (apptRow as any)?.starts_at ?? new Date().toISOString(),
      );
    }
    const q = language === "ky" ? "Эмне кылабыз?" : "Что делаем с записью?";
    return finish(q, "awaiting_manage_action", v3, buildManageActionMsg(language));
  }

  // ===== awaiting_reschedule_date =====
  if (state === "awaiting_reschedule_date") {
    const timeHit = combinedText ? extractManageTime(combinedText) : null;
    let dateIso: string | null = null;
    if (selectedId?.startsWith("date_")) {
      dateIso = selectedId.slice(5);
    } else if (combinedText) {
      dateIso = parseDateFromTextV3(timeHit ? timeHit.rest : combinedText, tz);
    }
    if (!dateIso) {
      const q = language === "ky" ? "Датаны тандаңыз:" : "Выберите дату:";
      return finish(
        q,
        "awaiting_reschedule_date",
        v3,
        buildDateListMsg(buildDateMap(tz, 7), language),
      );
    }
    // offerRescheduleSlots keeps the SAME master when possible, offers other masters when
    // that master's day is full, and jumps straight to confirm when the client also named
    // an available time ("завтра в 19:00").
    return offerRescheduleSlots(v3, dateIso, timeHit?.time ?? null);
  }

  // ===== awaiting_reschedule_slot =====
  if (state === "awaiting_reschedule_slot") {
    const slotsCache = v3.managing_slots_cache ?? [];
    let slot: { start: string; end: string; master_id?: string; master_name?: string } | null =
      null;
    if (selectedId?.startsWith("slot_")) {
      const idx = parseInt(selectedId.slice(5), 10);
      if (!isNaN(idx) && idx >= 0 && idx < slotsCache.length) slot = slotsCache[idx];
    } else if (combinedText) {
      const timeMatch = combinedText.match(/\b(\d{1,2})[:.](\d{2})\b/);
      if (timeMatch) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        slot =
          slotsCache.find((s) => {
            const t = formatTimeInTz(s.start, tz);
            const [sh, sm] = t.split(":").map(Number);
            return sh === h && sm === m;
          }) ?? null;
      }
    }
    if (!slot) {
      const msg = language === "ky" ? "Убакытты тандаңыз:" : "Выберите время:";
      const mockSlots: MergedSlot[] = slotsCache.map((s) => ({
        start: s.start,
        end: s.end,
        master_ids: s.master_id ? [s.master_id] : [],
      }));
      const byId = slotsCache.some((s) => s.master_name)
        ? new Map(
            slotsCache.filter((s) => s.master_id).map((s) => [s.master_id!, s.master_name ?? ""]),
          )
        : undefined;
      return finish(
        msg,
        "awaiting_reschedule_slot",
        v3,
        buildSlotListMsg(mockSlots, tz, language, byId),
      );
    }
    // Stale-cache guard (same as new bookings): a slot that has since passed must not go through.
    if (new Date(slot.start).getTime() <= Date.now()) {
      debug.actions.push(`reschedule_slot_now_past:${slot.start}`);
      return offerRescheduleSlots(v3, isoDateInTz(slot.start, tz), null);
    }
    const dateLabel = formatDateInTz(slot.start, tz);
    const timeLabel = formatTimeInTz(slot.start, tz);
    // Slot from ANOTHER master (own master's day was full) → say so in the confirmation.
    const masterSuffix = slot.master_name ? `, мастер ${slot.master_name}` : "";
    const details =
      language === "ky"
        ? `Жаңы убакыт: ${dateLabel}, ${timeLabel}${masterSuffix}. Ырастайсызбы?`
        : `Новое время: ${dateLabel}, ${timeLabel}${masterSuffix}. Подтверждаете?`;
    const newV3 = {
      ...v3,
      managing_new_slot_start: slot.start,
      managing_new_slot_end: slot.end,
      managing_new_master_id: slot.master_id,
      managing_new_master_name: slot.master_name,
    };
    return finish(details, "awaiting_manage_confirm", newV3, buildConfirmMsg(details, language));
  }

  // ===== awaiting_manage_confirm =====
  if (state === "awaiting_manage_confirm") {
    const ct = stripLeadingNonWord(combinedText.trim().toLowerCase());
    const confirmed =
      selectedId === "confirm_yes" ||
      /^(да|ок|ладно|согласен|согласна|подтвер|давай)/.test(ct) ||
      /^(ооба|макул)/.test(ct);
    const denied =
      selectedId === "confirm_no" || /^(нет|не надо|отмен|стоп)/.test(ct) || /^(жок)/.test(ct);

    if (denied) {
      const msg =
        language === "ky" ? "Жакшы, эч нерсе өзгөртүлгөн жок." : "Хорошо, ничего не меняю.";
      return finish(msg, "done", {});
    }
    if (!confirmed) {
      const details =
        v3.managing_action === "cancel"
          ? language === "ky"
            ? `Жокко чыгарабызбы?\n${v3.managing_appointment_label}`
            : `Отменяем?\n${v3.managing_appointment_label}`
          : language === "ky"
            ? "Ырастайсызбы?"
            : "Подтверждаете?";
      return finish(details, "awaiting_manage_confirm", v3, buildConfirmMsg(details, language));
    }

    // Deadline may have passed while the client was mid-dialog — re-check before applying.
    if (manageCutoffHours > 0 && v3.managing_appointment_id) {
      const { data: cur } = await db
        .from("appointments")
        .select("starts_at")
        .eq("id", v3.managing_appointment_id)
        .maybeSingle();
      if (cur && isWithinManageCutoff((cur as any).starts_at))
        return finish(manageCutoffMsg(), "done", {});
    }

    if (v3.managing_action === "cancel" || v3.managing_action === "cancel_and_rebook") {
      const { error } = await db
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", v3.managing_appointment_id!)
        .eq("salon_id", input.salon.salonId)
        .eq("client_phone", input.client.phone);
      if (error) {
        debug.errors.push(`cancel_appointment:${error.message}`);
        const msg =
          language === "ky"
            ? "Жокко чыгаруу мүмкүн болгон жок. Салонго кайрылыңыз."
            : "Не удалось отменить. Свяжитесь с салоном напрямую.";
        return finish(msg, "done", {});
      }
      if (v3.managing_action === "cancel_and_rebook") {
        const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
        const msg =
          language === "ky"
            ? "✅ Мурунку жазылуу жокко чыгарылды. Кызматты кайра тандаңыз:"
            : "✅ Прежняя запись отменена. Выберите услугу заново:";
        return reaskServiceMenu(msg, { branch_id: v3.branch_id }, services);
      }
      const msg =
        language === "ky"
          ? "✅ Жазылуу жокко чыгарылды. Кайра жазылгыңыз келсе — жөн гана жазыңыз 😊"
          : "✅ Запись отменена. Если захотите записаться снова — просто напишите 😊";
      return finish(msg, "done", {});
    }

    // reschedule (v2 RPC when the client agreed to move to another master's slot)
    try {
      const { error } =
        v3.managing_new_master_id && v3.managing_new_master_id !== v3.managing_master_id
          ? await db.rpc(
              "reschedule_appointment_v2" as any,
              {
                _appointment_id: v3.managing_appointment_id,
                _new_starts_at: v3.managing_new_slot_start,
                _new_master_id: v3.managing_new_master_id,
              } as any,
            )
          : await db.rpc(
              "reschedule_appointment" as any,
              {
                _appointment_id: v3.managing_appointment_id,
                _new_starts_at: v3.managing_new_slot_start,
              } as any,
            );
      if (error) throw error;
      const dateLabel = v3.managing_new_slot_start
        ? formatDateInTz(v3.managing_new_slot_start, tz)
        : "";
      const timeLabel = v3.managing_new_slot_start
        ? formatTimeInTz(v3.managing_new_slot_start, tz)
        : "";
      const masterSuffix =
        v3.managing_new_master_name && v3.managing_new_master_id !== v3.managing_master_id
          ? `, мастер ${v3.managing_new_master_name}`
          : "";
      const msg =
        language === "ky"
          ? `✅ Жазылуу которулду: ${dateLabel}, ${timeLabel}${masterSuffix}.`
          : `✅ Запись перенесена: ${dateLabel}, ${timeLabel}${masterSuffix}.`;
      return finish(msg, "done", {});
    } catch (e: any) {
      debug.errors.push(`reschedule_appointment:${e?.message ?? e}`);
      const msg =
        language === "ky"
          ? "Которуу мүмкүн болгон жок. Башка убакытты тандап көрүңүз."
          : "Не удалось перенести. Попробуйте выбрать другое время.";
      return finish(msg, "awaiting_reschedule_date", { ...v3, managing_slots_cache: undefined });
    }
  }

  // Fallback: reset to service selection
  debug.errors.push(`unhandled_state:${state}`);
  const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
  const fallback =
    language === "ky"
      ? "Кайра баштайлы. Кайсы кызматка жазыласыз?"
      : "Начнём сначала. На какую услугу вас записать?";
  return reaskServiceMenu(fallback, {}, services);
}
