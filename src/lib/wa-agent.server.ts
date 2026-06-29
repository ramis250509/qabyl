// WhatsApp assistant — server-only.
// Direct Google AI Studio (Gemini API) integration + explicit state machine.
// No Lovable Gateway, no tool-loop hallucinations — deterministic TS code drives
// services/masters/slots from DB; Gemini only classifies intent and renders text.

type AdminClient = Awaited<ReturnType<typeof getAdmin>>;
async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Note: gemini-1.5-* models were retired on Sept 24, 2025 → 404 on new API keys.
const MODEL_TEXT = "gemini-2.5-flash";
const MODEL_VISION = "gemini-2.5-flash";

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
};

export type WaAssistantConfig = {
  greeting: string | null;
  tone_instructions: string | null;
  pricing_rules: string | null;
  languages: string[];
};

export type WaSalonContext = {
  salonId: string;
  salonName: string;
  timezone: string;
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
  | "awaiting_photo"
  | "awaiting_price_confirm"
  | "awaiting_part_of_day"
  | "awaiting_slot_choice"
  | "awaiting_master_choice"
  | "awaiting_name"
  | "awaiting_final_confirm"
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
};

export type WaAgentInput = {
  salon: WaSalonContext;
  config: WaAssistantConfig;
  client: { phone: string; name: string | null };
  history: WaIncomingMessage[];
  lastMessages: WaIncomingMessage[]; // unprocessed inbound messages merged into this turn
  branches: WaBranchInfo[];
  selectedBranchId: string | null;
  state: WaAgentState;
  stateData: WaAgentStateData;
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
  };
};

export type GreenApiCreds = { instance: string; token: string };

// ============================================================
// Green-API helpers
// ============================================================

export function normalizeChatIdToPhone(chatId: string): string {
  return chatId.replace(/@c\.us$/, "").replace(/[^\d]/g, "");
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

// ============================================================
// Time / language helpers
// ============================================================

function nowInTz(tz: string): { isoLocalDate: string; humanDate: string; hour: number; minute: number; dow: number } {
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

function buildDateMap(tz: string, days = 14): Array<{ iso: string; label: string; relative: string }> {
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
  /(?<![\p{L}])(алейкум|ассалму|байке|эже|аке|иним|кандайс[\p{L}]*|саламат[\p{L}]*|салам(атсызбы|атчылык)?|жакшы|кандай|канча|ооба|жок|макул|бүгүн|бугун|эртең|эртен|эртеси|кеч(инде|ке|ки)?|таңда|түш(тө|кү)?|менин|жаз[\p{L}]*|куну|күнү|кереги|керек|рахмат|тушун[\p{L}]*|түшүн[\p{L}]*|саат|болот|кайра|кызмат[\p{L}]*)(?![\p{L}])/iu;

function detectLanguage(text: string): "ru" | "ky" | "en" {
  if (!text) return "ru";
  const lower = text.toLowerCase();
  const hasKyrgyzLetters = /[ңүөҢҮӨ]/.test(text);
  const hasLatinKyrgyzSignals = /\b(salam|salamat|bugun|bugin|erten|kec|kyrgyz|kizmat|chach|kyzmat|kyrgyzstan|sizin|biz|jany|ja?an|manikur|pedikur)\b/i.test(lower);
  // Islamic greeting used as standard Kyrgyz greeting in Kyrgyzstan — treat as Kyrgyz signal.
  const hasIslamicGreeting = /ассаламу?\s*а?лейку?м|ассалму\s*а?лейку?м/i.test(text);
  if (hasKyrgyzLetters || KY_WORD_RE.test(lower) || hasLatinKyrgyzSignals || hasIslamicGreeting) return "ky";
  if (/[а-яё]/i.test(lower)) return "ru";
  if (/^[\x00-\x7f\s]+$/.test(text) && /[a-z]/i.test(text)) return "en";
  return "ru";
}

// A message carries a "confident" language signal when it has Kyrgyz-unique letters / words,
// or is plainly Latin (English). Plain Cyrillic without Kyrgyz markers is NOT confident — that
// keeps a Kyrgyz conversation from flipping to Russian on a short word like "бугун".
function confidentLanguage(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/[ңүөҢҮӨ]/.test(text)) return true;
  if (KY_WORD_RE.test(lower)) return true;
  if (/ассаламу?\s*а?лейку?м|ассалму/i.test(text)) return true;
  if (/\b(salam|salamat|bugun|bugin|erten|kec|kizmat|chach|kyrgyz|jany|sizin|biz|kanday|kansha)\b/i.test(lower)) return true;
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
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const body: any = {
    contents: opts.contents ?? [{ role: "user", parts: opts.parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
      // Gemini 2.5 Flash can spend the token budget on hidden "thinking".
      // Enable up to 5000 tokens of thinking for complex reasoning (intent classification, parsing).
      // This improves accuracy on ambiguous/multilingual inputs without lengthening the actual reply.
      thinkingConfig: { thinkingBudget: 5000 },
    },
  };
  if (opts.responseMimeType) body.generationConfig.responseMimeType = opts.responseMimeType;
  if (opts.responseSchema) body.generationConfig.responseSchema = opts.responseSchema;
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }

  const url = `${GEMINI_BASE}/${opts.model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      if (r.status === 429 || r.status >= 500) {
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
      if (!text) return { ok: false, error: `gemini empty response: ${JSON.stringify(json).slice(0, 200)}` };
      return { ok: true, text };
    } catch (e: any) {
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        continue;
      }
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
  return { ok: false, error: "gemini unknown" };
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
  services: Array<{ id: string; name: string; category: string | null; price: number; price_max: number | null; price_type: string }>,
) {
  const t = normalizeForMatch(text);
  if (!t) return null;
  const hasServiceSignal = /(услуга|услуги|сервис|кызмат|чач|маник|педик|окраш|бров|ресниц|уклад|макияж|hair|nail|cut|color)/i.test(text);
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
    const firstToken = (t.split(" ").find((tok) => tok.length >= 3)) ?? "";
    if (firstToken) {
      const fallback = services.find((s) =>
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
  services: Array<{ id: string; name: string; category: string | null; price: number; price_max: number | null; price_type: string }>;
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
    if (fuzzyHit(toks, ["утром", "утро", "утра"])) { entities.part_of_day = "morning"; intent = intent ?? "choose_part_of_day"; }
    else if (fuzzyHit(toks, ["днем", "день", "дня"])) { entities.part_of_day = "afternoon"; intent = intent ?? "choose_part_of_day"; }
    else if (fuzzyHit(toks, ["вечером", "вечер", "вечера"])) { entities.part_of_day = "evening"; intent = intent ?? "choose_part_of_day"; }
  }

  // Exact yes / no / any-master, now incl. Kyrgyz (ооба/макул = yes, жок = no, баары бир = any).
  // Extended patterns to catch more variations including typos and abbreviations.
  if (/(^|\s)(да|ага|ок|окей|оке|хорошо|хорош|записывайте|подтверждаю|ооба|макул|макуль|yes|ага|угу)(\s|$)/.test(t)) intent = intent ?? "confirm_yes";
  if (/(^|\s)(нет|неа|ни|другое|не подходит|жок|no|неэ|нее)(\s|$)/.test(t)) intent = intent ?? "deny_no";
  if (/(^|\s)(любой|любому|без разницы|не принципиально|все равно|всё равно|любое|неважно|не важно|баары бир|баарыбир|бары бир|равно)(\s|$)/.test(t)) intent = intent ?? "any_master";
  // Typo-tolerant yes/no for short confirmations ("оке", "нееет", "ооаба", "макуль") — increased maxDist.
  if (!intent) {
    if (fuzzyHit(toks, ["окей", "хорошо", "ооба", "макул", "хорош"], 2)) intent = "confirm_yes";
    else if (fuzzyHit(toks, ["неа", "нет", "жок", "ни"], 1)) intent = "deny_no";
  }
  if (/(^|\s)(отмена|не нужно|передумал)(\s|$)/.test(t)) intent = "cancel";

  // Numbered slot selection: "первый", "2", "четвёртое", "последнее" etc.
  const ordinals: Record<string, number> = {
    первый: 1, первое: 1, первую: 1, первая: 1, "1": 1,
    второй: 2, второе: 2, вторую: 2, вторая: 2, "2": 2,
    третий: 3, третье: 3, третью: 3, третья: 3, "3": 3,
    четвертый: 4, четвертое: 4, четвертую: 4, четвертая: 4,
    четвёртый: 4, четвёртое: 4, четвёртую: 4, "4": 4,
    последний: -1, последнее: -1, последнюю: -1, последняя: -1,
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
      if (n >= 1 && n <= 9) { entities.slot_number = n; intent = intent ?? "choose_specific_time"; }
    }
  }

  const service = findServiceByText(raw, opts.services);
  if (service) {
    entities.service_id = service.id;
    // Do NOT override ask_services — client is asking what's available, not choosing a specific service.
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

  if (!intent && /(какие|какая|что есть|услуги|прайс|цены|стоимость|сколько|кызмат|услуга)/.test(t)) {
    intent = /(сколько|цена|цены|стоимость|прайс)/.test(t) ? "ask_price" : "ask_services";
  }
  if (!intent && /(здрав|привет|салам|ассаламу|ассалму|алейкум|hello|hi|salam|salamat)/.test(t)) intent = "greet";
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
  const weak = intent === "other" || intent === "greet" || intent === "smalltalk" ||
               intent === "ask_price" || intent === "ask_services";
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
  services: Array<{ id: string; name: string; category: string | null; price: number; price_max: number | null; price_type: string }>;
  branches: WaBranchInfo[];
  dateMap: Array<{ iso: string; label: string; relative: string }>;
}): Promise<{ intent: Intent; entities: Entities; language: "ru" | "ky" | "en" }> {
  const compactHistory = opts.history
    .slice(-10)
    .map((m) => `${m.direction === "in" ? "client" : "assistant"}: ${sanitizeHistoryMessage(m).slice(0, 200)}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");

  const services = opts.services
    .slice(0, 80)
    .map((s) => `${s.id} | ${s.name}${s.category ? " (" + s.category + ")" : ""} | ${s.price_type === "range" ? `${s.price}–${s.price_max}` : s.price}`)
    .join("\n");

  const branches = opts.branches.map((b) => `${b.id} | ${b.name}${b.address ? ", " + b.address : ""}`).join("\n");
  const dates = opts.dateMap.slice(0, 14).map((d) => `${d.iso} = ${d.relative} (${d.label})`).join("\n");

  const sys = `Ты — парсер сообщений клиента салона красоты. Получаешь последнее сообщение клиента и историю диалога. Возвращаешь СТРОГО JSON по схеме, без markdown.
Никогда не выдумывай id — service_id и branch_id выбирай ровно из переданных таблиц или оставляй пустыми.
Определи язык клиента: "ru", "ky" (кыргызский — слова кандай, салам, бүгүн, эртең, кеч, ң/ү/ө) или "en".
Для дат используй таблицу. Если клиент сказал "сегодня"/"завтра" — поставь day_relative; если назвал дату — day_iso по таблице.
Время суток: до 12:00 = morning, 12:00–17:00 = afternoon, после 17:00 = evening.
Если клиент пишет HH:MM или "в 14", "в 6 вечера" — заполни specific_time как "HH:MM" в 24-часовом формате.
Намерения:
- greet: приветствие, "ассаламу алейкум", "здравствуйте", "привет"
- smalltalk: благодарность, "ладно", "хорошо", без действия
- ask_services: "какие услуги?", "что у вас есть?", "сколько стоит ...?"
- choose_service: клиент назвал услугу — подбери service_id по названию из таблицы услуг, либо service_query (свободный текст)
- choose_day: клиент назвал день
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
      deterministic.intent === "choose_service" && mergedEntities.service_id &&
      // When deterministic confidently found a service, override Gemini's weak intents
      ["other", "greet", "smalltalk", "ask_services", "ask_price", "confirm_yes", "deny_no"].includes(geminiIntent)
        ? deterministic.intent
        // Trust deterministic when it explicitly found a query intent that Gemini misread as service choice
        : (["ask_services", "ask_price"].includes(deterministic.intent as string) &&
           geminiIntent === "choose_service" && !mergedEntities.service_id)
          ? deterministic.intent
          : deterministic.intent && deterministic.intent !== "other" &&
              (geminiIntent === "other" || geminiIntent === "greet" || geminiIntent === "smalltalk")
            ? deterministic.intent
            : geminiIntent;
    return {
      intent: promoteIntentFromEntities(intent as Intent, mergedEntities),
      entities: mergedEntities,
      language: (deterministic.language ?? parsed.language ?? detectLanguage(opts.lastText)) as "ru" | "ky" | "en",
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
  const langName = opts.language === "ky" ? "кыргызском" : opts.language === "en" ? "английском" : "русском";
  // Prepend a warm greeting on first contact (unless the reply already greets).
  const greetReply = (reply: string): string => {
    if (!opts.greet) return reply;
    if (/^\s*(здрав|привет|саламат|салам|ваалейкум|hello|hi|hey|добр)/iu.test(reply)) return reply;
    // Only use the admin-configured greeting (typically in Russian) for Russian-speaking clients.
    // For Kyrgyz/English clients, use a language-appropriate default instead.
    const useConfigGreeting = opts.language === "ru" && opts.greeting && /\p{L}/u.test(opts.greeting);
    const g = useConfigGreeting
      ? opts.greeting!.trim()
      : (opts.islamicGreeting && opts.language === "ky") ? "Ваалейкум Ассалам!"
      : opts.language === "ky" ? "Саламатсызбы!"
      : opts.language === "en" ? "Hello!"
      : "Здравствуйте!";
    const shortHint = (opts.language === "ru" && /коротко|кратко|без лишних слов|по делу/i.test(`${opts.tone ?? ""} ${opts.greeting ?? ""}`))
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
  if (/^—\s+[^\n]+/m.test(opts.factualContext)) {
    return greetReply(instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName));
  }

  const greetInstruction = opts.greet
    ? "Это ПЕРВОЕ сообщение клиенту — начни с короткого тёплого приветствия от салона, затем выполни задачу.\n\n"
    : "";
  const styleInstruction = opts.tone
    ? `Соблюдай правила стиля салона: ${opts.tone}\n\n`
    : "";
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
    return greetReply(instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName));
  }
  const cleaned = res.text.replace(/^```[a-z]*|```$/gi, "").trim();
  if (/^(спроси|скажи|поприветствуй|извинись|предложи|уточни)\b/i.test(cleaned)) {
    return greetReply(instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName));
  }
  // Guard against the exact production symptom: Gemini returned a partial
  // sentence like "...на какую услугу хотели бы записа" with finishReason STOP.
  // WhatsApp must never receive half-words, so fall back to deterministic text
  // for the current factual step when the answer has no sentence terminator.
  if (!/[.!?…]$/.test(cleaned)) {
    return greetReply(instructionFallbackReply(opts.factualContext, opts.language, opts.salon.salonName));
  }
  // Gemini was already told to greet on first contact; greetReply is a no-op if it did.
  return greetReply(cleaned);
}

// Language-aware clarification used when the client keeps replying with something we can't
// parse for the question we're currently on. Deterministic (not paraphrased by Gemini) so the
// wording is GUARANTEED to differ from the previous verbatim question — kills the repeat loop.
function stuckClarifyReply(questionKey: string | undefined, language: "ru" | "ky" | "en"): string {
  const L = <T,>(ru: T, ky: T, en: T): T => (language === "ky" ? ky : language === "en" ? en : ru);
  switch (questionKey) {
    case 'photo':
    case 'photo_retry':
      return L(
        'Пришлите, пожалуйста, фото — нажмите на иконку изображения рядом с полем сообщения.',
        'Сүрөттү жөнөтүңүзчү — билдирүү талаасынын жанындагы сүрөт баскычын басыңыз.',
        'Please send a photo — tap the photo icon next to the message field.',
      );
    case 'service':
      return L(
        'Извините, не совсем поняла 🙂 Напишите, пожалуйста, название услуги — например «стрижка» или «маникюр».',
        'Кечиресиз, толук түшүнбөй калдым 🙂 Кызматтын атын жазыңызчы — мисалы «чач кыркуу» же «маникюр».',
        'Sorry, I didn\'t quite get that 🙂 Please type the service name — e.g. “haircut” or “manicure”.',
      );
    case 'part':
      return L(
        'Кажется, я не совсем поняла 🙂 Подскажите, когда удобнее — утром, днём или вечером?',
        'Сизди толук түшүнбөй калдым окшойт 🙂 Качан ыңгайлуу — эртең менен, түштө же кечинде?',
        'Sorry, I didn\'t quite catch that 🙂 When works best — morning, afternoon, or evening?',
      );
    case 'slot':
      return L(
        'Не совсем поняла 🙂 Назовите удобное время цифрами — например 12:30 — или номер из списка.',
        'Толук түшүнбөдүм 🙂 Ыңгайлуу убакытты сан менен жазыңыз — мисалы 12:30 — же тизмедеги номерди.',
        'I didn\'t quite get that 🙂 Tell me a time in numbers — e.g. 12:30 — or a number from the list.',
      );
    case 'master':
      return L(
        'Подскажите имя мастера из списка или напишите «не принципиально».',
        'Тизмедеги устанын атын айтыңыз же «баары бир» деп жазыңыз.',
        'Tell me a master\'s name from the list, or just say “any”.',
      );
    case 'name':
      return L(
        'Подскажите, пожалуйста, ваше имя — как к вам обращаться?',
        'Атыңызды айтыңызчы — сизге кандай кайрылсам болот?',
        'Could you tell me your name, please?',
      );
    case 'confirm':
      return L(
        'Чтобы записать, напишите «да», либо назовите другое удобное время.',
        'Жазыш үчүн «ооба» деп жазыңыз, же башка ыңгайлуу убакыт айтыңыз.',
        'To book, reply “yes”, or tell me another time that suits you.',
      );
    default:
      return L(
        'Извините, не совсем поняла 🙂 Уточните, пожалуйста, чем могу помочь с записью?',
        'Кечиресиз, толук түшүнбөдүм 🙂 Жазылууда эмне менен жардам берейин?',
        'Sorry, I didn\'t quite get that 🙂 How can I help you book an appointment?',
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

function instructionFallbackReply(factual: string, language: "ru" | "ky" | "en", salonName?: string): string {
  const text = factual.replace(/\s+/g, " ").trim();
  const serviceList = [...factual.matchAll(/^—\s+(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (serviceList.length) {
    const list = serviceList.map((s) => `— ${s}`).join("\n");
    if (language === "ky") return `Бизде бар кызматтар:\n${list}\n\nКайсы кызматка жазыласыз?`;
    if (language === "en") return `We offer:\n${list}\n\nWhich service would you like to book?`;
    return `У нас есть:\n${list}\n\nНа какую услугу вас записать?`;
  }
  const confirmMatch = text.match(/подтвердить запись:\s*услуга «(.+?)»,\s*(.+?)\s+в\s+([0-9:]+),\s*мастер\s+(.+?)\./i);
  if (confirmMatch) {
    if (language === "ky") return `Тактап коёюн: «${confirmMatch[1]}», ${confirmMatch[2]} саат ${confirmMatch[3]}, мастер ${confirmMatch[4]}. Баары туурабы, жазайынбы?`;
    if (language === "en") return `Let's confirm: ${confirmMatch[1]}, ${confirmMatch[2]} at ${confirmMatch[3]}, master ${confirmMatch[4]}. Shall I book it?`;
    return `Подтвердите, пожалуйста: «${confirmMatch[1]}», ${confirmMatch[2]} в ${confirmMatch[3]}, мастер ${confirmMatch[4]}. Всё верно, записываю?`;
  }
  // Ambiguous yes/no while confirming a specific slot.
  const ambiguousConfirm = text.match(/подтверждаете запись на\s+(.+?)\s+в\s+([0-9:]+)/i);
  if (ambiguousConfirm) {
    if (language === "ky") return `${ambiguousConfirm[1]} саат ${ambiguousConfirm[2]} жазайынбы? «Ооба» деп жазыңыз же башка убакыт айтыңыз.`;
    if (language === "en") return `Shall I book ${ambiguousConfirm[1]} at ${ambiguousConfirm[2]}? Reply "yes" or suggest another time.`;
    return `Записываю на ${ambiguousConfirm[1]} в ${ambiguousConfirm[2]}? Напишите «да» или назовите другое время.`;
  }
  // Several masters free for the chosen slot.
  const masterChoice = text.match(/на\s+([0-9:]+)\s+свободны мастера\s+(.+?)\.\s*спроси/i);
  if (masterChoice) {
    if (language === "ky") {
      const names = masterChoice[2].replace(/ и /g, " жана ");
      return `${masterChoice[1]} бош усталар: ${names}. Кимге жазайын, же «баары бир»?`;
    }
    if (language === "en") return `Available masters at ${masterChoice[1]}: ${masterChoice[2]}. Who should I book, or "any"?`;
    return `На ${masterChoice[1]} свободны мастера ${masterChoice[2]}. К кому записать или «не принципиально»?`;
  }
  // Requested specific time not available — offer the nearest ones.
  const nearestMatch = text.match(/в\s+([0-9:]+)\b.*свободного окна нет.*ближайшие:\s*([^.]*)/i);
  if (nearestMatch) {
    if (language === "ky") return `${nearestMatch[1]} бош эмес. Жакынкы убакыттар: ${nearestMatch[2]}. Кайсынысы туура келет?`;
    if (language === "en") return `${nearestMatch[1]} isn't free. Nearest times: ${nearestMatch[2]}. Which one works?`;
    return `На ${nearestMatch[1]} свободного окна нет. Ближайшее время: ${nearestMatch[2]}. Какое подойдёт?`;
  }
  if (/не получилось открыть фото|не получилось оценить по фото/i.test(text)) {
    if (language === "ky") return "Сүрөттү ача алган жокмын. Дагы бир жолу жөнөтүңүзчү, же баасын уста жеринде айтат.";
    if (language === "en") return "I couldn't open the photo. Please send it again, or the master will price it on site.";
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
    if (language === "ky") return `Болжолдуу баасы — ${priceConfirm[1]} сом (так баасын уста жеринде айтат). Кайсы күнгө жазыласыз: бүгүн, эртең же башка күнгө?`;
    if (language === "en") return `Approximate price — ${priceConfirm[1]} som (master will confirm on site). What day works for you?`;
    return `Примерная стоимость — около ${priceConfirm[1]} сом (точную мастер озвучит на месте). На какой день вас записать?`;
  }
  if (priceConfirm && /продолжаем|подбор времени|стоимость по фото/i.test(text)) {
    if (language === "ky") return `Болжолдуу баасы — ${priceConfirm[1]} сом. Убакыт тандоону улантабызбы?`;
    if (language === "en") return `Approximate price — ${priceConfirm[1]} som. Shall we continue picking a time?`;
    return `Примерная стоимость — около ${priceConfirm[1]} сом. Продолжаем подбор времени?`;
  }
  if (/только что заняли/i.test(text)) {
    if (language === "ky") return "Тилекке каршы, бул убакытты азыр ээлеп коюшту. Башка убакыт тандайлыбы?";
    if (language === "en") return "Sorry, that time was just taken. Shall we pick another slot?";
    return "К сожалению, это время только что заняли. Давайте выберем другое окно?";
  }
  if (/нет доступных мастеров/i.test(text)) {
    if (language === "ky") return "Бул кызматка азыр бош уста жок. Башка кызматты тандаңызчы.";
    if (language === "en") return "No masters are available for this service right now. Please choose another service.";
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
    if (language === "en") return "Sorry about that! Please write again to rebook, or call the salon directly.";
    return "Извините за это! Напишите ещё раз, чтобы переписаться, или позвоните в салон напрямую.";
  }
  if (/услуги ещё не настроены|услуги еще не настроены/i.test(text)) {
    if (language === "ky") return "Кечиресиз, кызматтар азырынча тууралануда. Салонго түз кайрылыңызчы.";
    if (language === "en") return "Sorry, services aren't set up yet. Please contact the salon directly.";
    return "Извините, услуги пока настраиваются. Пожалуйста, свяжитесь с салоном напрямую.";
  }
  if (/другое время или день|на какое другое время|на какое время записать/i.test(text)) {
    if (language === "ky") return "Кайсы убакытка же күнгө жазайын?";
    if (language === "en") return "What time or day should I book for?";
    return "На какое время или день вас записать?";
  }
  if (/поприветствуй|помочь с записью|на какую услугу записать/i.test(text)) {
    if (language === "ky") return `Саламатсызбы${salonName ? `! Бул «${salonName}»` : ""}. Кайсы кызматка жазыласыз?`;
    if (language === "en") return `Hello${salonName ? `! This is ${salonName}` : ""}. Which service would you like to book?`;
    return `Здравствуйте${salonName ? `! Вас приветствует «${salonName}»` : ""}. На какую услугу вас записать?`;
  }
  const partAsk = text.match(/удобнее\.?\s*доступные варианты:\s*([^.]*)/i);
  if (partAsk) {
    if (language === "ky") return `Кайсы убакыт ыңгайлуу: ${partAsk[1]}?`;
    if (language === "en") return `What time works for you: ${partAsk[1]}?`;
    return `Когда вам удобнее: ${partAsk[1]}?`;
  }
  if (/утром|дн[её]м|вечером|morning|afternoon|evening/i.test(text)) {
    if (language === "ky") return "Кайсы убакыт ыңгайлуу: эртең менен, түштө же кечинде?";
    if (language === "en") return "What time of day is better for you: morning, afternoon, or evening?";
    return "Когда удобнее: утром, днём или вечером?";
  }
  if (/какой день|какой день|на какой день/i.test(text)) {
    if (language === "ky") return "Кайсы күнгө жазыласыз: бүгүн, эртең же башка күнгө?";
    if (language === "en") return "Which day would you like to book for: today, tomorrow, or another day?";
    return "На какой день вас записать: сегодня, завтра или на другую дату?";
  }
  const freeMatch = text.match(/на\s+(.+?)\s+свободно:\s*([^.]*)/i);
  if (freeMatch) {
    if (language === "ky") return `${freeMatch[1]} бош убакыттар: ${freeMatch[2]}. Кайсы убакытты тандайсыз?`;
    if (language === "en") return `Available times for ${freeMatch[1]}: ${freeMatch[2]}. Which time would you like?`;
    return `На ${freeMatch[1]} свободно: ${freeMatch[2]}. Какое время выбрать?`;
  }
  if (/свободных окон нет|свободного окна нет/i.test(text)) {
    if (language === "ky") return "Бул убакытка бош орун жок. Башка убакытты же күндү тандайсызбы?";
    if (language === "en") return "There are no available slots for that time. Would you like another time or day?";
    return "На это время свободных окон нет. Выберем другое время или день?";
  }
  const bookedMatch = text.match(/салон «(.+?)»,\s*(.+?)\s+в\s+([0-9:]+),\s*мастер\s+(.+?),\s*услуга\s+«(.+?)»/i);
  if (bookedMatch) {
    const [, salon, date, time, master, service] = bookedMatch;
    if (language === "ky") return `Даяр! 🎉 Сизди «${salon}» салонуна ${date}, саат ${time} жаздык. Уста ${master}, кызмат «${service}». Күтөбүз! 😊`;
    if (language === "en") return `All set! 🎉 You're booked at "${salon}" on ${date} at ${time}. Master ${master}, service "${service}". See you! 😊`;
    return `Готово! 🎉 Записали вас в «${salon}» на ${date} в ${time}. Мастер ${master}, услуга «${service}». Ждём вас в гости! 😊`;
  }
  if (/как обращаться|имя/i.test(text)) {
    if (language === "ky") return "Атыңыз ким?";
    if (language === "en") return "What name should I use for the booking?";
    return "Подскажите, пожалуйста, как к вам обращаться?";
  }
  if (language === "ky") return "Тактап коюңузчу, кандай кызматка жазыласыз?";
  if (language === "en") return "Please уточните, which service would you like to book?".replace("уточните", "clarify");
  return "Подскажите, пожалуйста, на какую услугу вас записать?";
}

// ============================================================
// Slot loading / merging
// ============================================================

type DbMaster = {
  id: string;
  name: string;
  branch_id: string | null;
  sort_order: number;
  service_ids: string[];
};

type MergedSlot = {
  start: string;
  end: string;
  master_ids: string[];
};

async function loadServicesForSalon(db: AdminClient, salonId: string) {
  const { data } = await db
    .from("services")
    .select("id, name, category, price, price_max, price_type, duration_min")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .order("sort_order");
  return data ?? [];
}

async function loadMastersForService(
  db: AdminClient,
  salonId: string,
  serviceId: string,
  branchId: string | null,
): Promise<DbMaster[]> {
  const { data } = await db
    .from("masters")
    .select("id, name, branch_id, sort_order, master_services(service_id)")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .order("sort_order");
  const all = (data ?? []).map((m: any) => ({
    id: m.id,
    name: m.name,
    branch_id: m.branch_id ?? null,
    sort_order: m.sort_order ?? 0,
    service_ids: (m.master_services ?? []).map((s: any) => s.service_id),
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

function formatTimeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatDateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

async function fetchMergedSlots(opts: {
  db: AdminClient;
  masters: DbMaster[];
  serviceId: string;
  day: string;
  tz: string;
  part?: "morning" | "afternoon" | "evening";
  minStartTime?: Date;
  limit?: number;
}): Promise<MergedSlot[]> {
  const map = new Map<string, MergedSlot>();
  for (const m of opts.masters) {
    const { data } = await opts.db.rpc("get_available_slots", {
      _master_id: m.id,
      _service_id: opts.serviceId,
      _date: opts.day,
    });
    for (const s of data ?? []) {
      const key = s.slot_start as string;
      if (opts.part && !isInPart(key, opts.tz, opts.part)) continue;
      if (opts.minStartTime && new Date(key).getTime() <= opts.minStartTime.getTime()) continue;
      const cur = map.get(key);
      if (cur) {
        if (!cur.master_ids.includes(m.id)) cur.master_ids.push(m.id);
      } else {
        map.set(key, { start: key, end: s.slot_end as string, master_ids: [m.id] });
      }
    }
  }
  const list = Array.from(map.values()).sort((a, b) => (a.start < b.start ? -1 : 1));
  return list.slice(0, opts.limit ?? 4);
}

// ============================================================
// Photo pricing (Gemini Vision)
// ============================================================

async function priceFromPhoto(opts: {
  apiKey: string;
  imageBase64: string;
  mime: string;
  serviceName: string;
  priceMin: number;
  priceMax: number;
  pricingRules: string | null;
  language: "ru" | "ky" | "en";
}): Promise<{ price: number; explanation: string } | { error: string }> {
  const sys = `Ты оцениваешь стоимость услуги «${opts.serviceName}» по фото клиента.
Цена ОБЯЗАНА быть числом в диапазоне [${opts.priceMin}, ${opts.priceMax}] сом, не выходи за границы.
${opts.pricingRules ? `Правила оценки от салона: ${opts.pricingRules}` : ""}
Верни строго JSON: {"price": число, "explanation": "1 короткое предложение"}.`;
  const res = await callGemini({
    model: MODEL_VISION,
    apiKey: opts.apiKey,
    systemInstruction: sys,
    parts: [
      { inline_data: { mime_type: opts.mime, data: opts.imageBase64 } },
      { text: "Оцени стоимость по фото." },
    ],
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: { price: { type: "number" }, explanation: { type: "string" } },
      required: ["price", "explanation"],
    },
    temperature: 0.2,
    maxOutputTokens: 200,
  });
  if (!res.ok || !res.text) return { error: res.error ?? "vision failed" };
  try {
    const j = JSON.parse(res.text);
    const p = Math.max(opts.priceMin, Math.min(opts.priceMax, Number(j.price)));
    return { price: Math.round(p), explanation: String(j.explanation ?? "") };
  } catch (e: any) {
    return { error: e?.message ?? "parse failed" };
  }
}

async function downloadImageAsBase64(url: string): Promise<{ base64: string; mime: string } | { error: string }> {
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
    if (ab.byteLength > 4 * 1024 * 1024) return { error: "image too large" };
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
  const lastImage = [...input.lastMessages].reverse().find((m) => m.kind === "image" && m.media_signed_url);
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
    (input.stateData.language as any) ?? clampLanguage(detectLanguage(combinedLastText), allowedLangs);

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
    else if (detectedLang !== storedLang && confidentLanguage(combinedLastText)) language = detectedLang;
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

  const tone = input.config.tone_instructions;
  const islamicGreeting = /ассаламу?\s*а?лейку?м|ассалму/i.test(combinedLastText);
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

  // ----- Done state: graceful post-booking handling
  if (state === "done") {
    const newBookingIntents: Intent[] = [
      "choose_service", "ask_services", "ask_price",
      "choose_day", "choose_part_of_day", "choose_specific_time",
    ];
    if (newBookingIntents.includes(intent)) {
      // Client clearly wants a new booking — reset and fall through
      sd = { language };
      state = "idle";
    } else {
      // Closing phrase, complaint or acknowledgement — respond in context
      const isComplaint = /(неправил|не то|не туда|ошибк|не верн|неверн|не так|не на то|не 12|не на 12)/i.test(combinedLastText);
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
      const list = input.branches.map((b) => `— ${b.name}${b.address ? ", " + b.address : ""}`).join("\n");
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
  else if (entities.day_iso && /^\d{4}-\d{2}-\d{2}$/.test(entities.day_iso)) sd.day = entities.day_iso;

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
  if (state === "awaiting_part_of_day" && !sd.part_of_day && !entities.specific_time && intent === "any_master") {
    sd.part_of_day = "afternoon";
  }

  // ----- Slot selection from cache (for awaiting_slot_choice without specific_time entity)
  if (state === "awaiting_slot_choice" && !sd.slot_start && !entities.specific_time) {
    const cachedSlots: MergedSlot[] = (sd as any).slots_cache ?? [];
    if (cachedSlots.length > 0) {
      let picked: MergedSlot | undefined;
      if (entities.slot_number != null) {
        const idx = entities.slot_number < 0
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
  if (
    state === "awaiting_final_confirm" &&
    (entities.specific_time || entities.day_relative || entities.day_iso || entities.service_id || entities.part_of_day)
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
    const top = services.slice(0, 8).map((s: any) => {
      const price = s.price_type === "range" ? `${s.price}–${s.price_max} сом` : `${s.price} сом`;
      return `— ${s.name}: ${price}`;
    }).join("\n");
    if (intent === "greet") {
      factual = `Поприветствуй клиента от имени салона «${input.salon.salonName}» и предложи помочь с записью. Перечисли услуги:\n${top}`;
    } else if (intent === "ask_price" || intent === "ask_services") {
      factual = `Клиент спросил об услугах/ценах. Перечисли услуги с ценами:\n${services.slice(0, 10).map((s: any) => `— ${s.name}: ${s.price_type === "range" ? `${s.price}–${s.price_max}` : s.price} сом`).join("\n")}\nСпроси, на какую услугу записать.`;
    } else if (intent === "smalltalk" || intent === "other") {
      // Non-booking message with no context — respond naturally and hint at booking
      factual = `Клиент написал: "${combinedLastText}". Ответь коротко и дружелюбно, затем мягко предложи помочь с записью в салон «${input.salon.salonName}».`;
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
        factual = `Не получилось открыть фото. Попроси прислать его ещё раз или мастер уточнит цену на месте.`;
        state = "awaiting_photo";
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
        factual = `Не получилось оценить по фото. Скажи, что точную стоимость мастер озвучит на месте, и предложи выбрать день для записи.`;
        return finish();
      } else {
        sd.priced_value = priced.price;
        state = "collecting"; // move past awaiting_photo so next turn goes to day selection
        factual = `Скажи: по фото ориентировочная стоимость «${svcRow.name}» — около ${priced.price} сом (${priced.explanation}). Цена примерная, точную мастер уточнит на месте. Затем сразу спроси на какой день записать.`;
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
    const sample = dateMap.slice(0, 3).map((d) => `${d.relative} (${d.label})`).join(", ");
    factual = `Спроси, на какой день записать. Подскажи примеры: ${sample}.`;
    state = "collecting";
    return finish();
  }

  // Drop a part-of-day that has already passed for today (e.g. "утром" chosen at 17:00).
  if (sd.day === today && sd.part_of_day && !sd.specific_time && !availablePartsToday(nowHour).includes(sd.part_of_day)) {
    sd.part_of_day = undefined;
  }

  // 4) Need part of day or specific time?
  if (!sd.part_of_day && !sd.specific_time) {
    const parts = sd.day === today ? availablePartsToday(nowHour) : (["morning", "afternoon", "evening"] as const);
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
  const masters = await loadMastersForService(db, input.salon.salonId, sd.service_id, selectedBranchId);
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
        sd.part_of_day === "morning" ? "утром" : sd.part_of_day === "afternoon" ? "днём" : "вечером";
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
    const priceStr = sd.priced_value != null ? ` Стоимость по фото — около ${sd.priced_value} сом.` : "";
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
    } catch (e: any) {
      const raw = instructionFallbackReply(factual, language, input.salon.salonName);
      if (isFirstContact && !/^\s*(здрав|привет|саламат|салам|hello|hi|hey|добр)/iu.test(raw)) {
        const g = input.config.greeting?.trim() ||
          (language === "ky" ? "Саламатсызбы!" : language === "en" ? "Hello!" : "Здравствуйте!");
        reply = `${g} ${raw}`.trim();
      } else {
        reply = raw;
      }
      debug.errors.push(`compose: ${e?.message ?? String(e)}`);
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
