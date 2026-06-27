# Инструкция для Lovable AI — исправления ИИ-Админа (WhatsApp-ассистент)

Примени точечные правки в трёх файлах. Для каждой — найди блок «БЫЛО» и замени на «СТАЛО».
Не меняй ничего другого. После применения ничего не переименовывай.

==================================================================
ФАЙЛ 1: src/lib/wa-agent.server.ts
==================================================================

--- Правка 1.1 (тип состояния: добавить price_skipped) ---
БЫЛО:
  service_price_type?: "fixed" | "range";
  priced_value?: number;
СТАЛО:
  service_price_type?: "fixed" | "range";
  priced_value?: number;
  price_skipped?: boolean; // Vision pricing failed → master prices on site, don't re-ask for a photo

--- Правка 1.2 (тип состояния: добавить greeted/reask_count/needs_human) ---
БЫЛО:
  last_prompt?: string; // key of the last question we asked, to avoid verbatim loops
};
СТАЛО:
  last_prompt?: string; // key of the last question we asked, to avoid verbatim loops
  greeted?: boolean; // we have already greeted the client in this session → never greet twice
  reask_count?: number; // consecutive turns we re-asked the SAME question after an unrecognized reply
  needs_human?: boolean; // bot gave up after repeated confusion → conversation flagged for a live admin
};

--- Правка 1.3 (KY_WORD_RE — добавить макул/түш/кечке) ---
БЫЛО:
const KY_WORD_RE =
  /(?<![\p{L}])(салам(атсызбы|атчылык)?|жакшы|кандай|канча|ооба|жок|бүгүн|бугун|эртең|эртен|эртеси|кеч(инде)?|таңда|менин|жаз[\p{L}]*|куну|күнү|кереги|керек|рахмат|тушун[\p{L}]*|түшүн[\p{L}]*|саат|болот|кайра|кызмат[\p{L}]*)(?![\p{L}])/iu;
СТАЛО:
const KY_WORD_RE =
  /(?<![\p{L}])(салам(атсызбы|атчылык)?|жакшы|кандай|канча|ооба|жок|макул|бүгүн|бугун|эртең|эртен|эртеси|кеч(инде|ке|ки)?|таңда|түш(тө|кү)?|менин|жаз[\p{L}]*|куну|күнү|кереги|керек|рахмат|тушун[\p{L}]*|түшүн[\p{L}]*|саат|болот|кайра|кызмат[\p{L}]*)(?![\p{L}])/iu;

--- Правка 1.4 (добавить helpers сразу ПОСЛЕ функции levenshtein) ---
Найди конец функции levenshtein:
  return prev[b.length];
}
И сразу после неё ВСТАВЬ:

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

--- Правка 1.5 (части дня + да/нет: кыргызский + fuzzy) ---
БЫЛО:
  if (/(^|\s)(утро|утром|таң|тан)(\s|$)/.test(t)) {
    entities.part_of_day = "morning";
    intent = intent ?? "choose_part_of_day";
  } else if (/(^|\s)(день|днем|днём|туш|түш)(\s|$)/.test(t)) {
    entities.part_of_day = "afternoon";
    intent = intent ?? "choose_part_of_day";
  } else if (/(^|\s)(вечер|вечером|кеч)(\s|$)/.test(t)) {
    entities.part_of_day = "evening";
    intent = intent ?? "choose_part_of_day";
  }

  if (/(^|\s)(да|ага|ок|окей|хорошо|записывайте|подтверждаю|yes)(\s|$)/.test(t)) intent = intent ?? "confirm_yes";
  if (/(^|\s)(нет|неа|другое|не подходит|no)(\s|$)/.test(t)) intent = intent ?? "deny_no";
  if (/(^|\s)(любой|любому|без разницы|не принципиально|все равно|всё равно|любое|неважно|не важно)(\s|$)/.test(t)) intent = intent ?? "any_master";
СТАЛО:
  const toks = t.split(/\s+/).filter(Boolean);
  if (/(^|\s)(утро|утром|таң|тан|таңда|таңкы|эртең менен|эртен менен)(\s|$)/.test(t)) {
    entities.part_of_day = "morning";
    intent = intent ?? "choose_part_of_day";
  } else if (/(^|\s)(день|днем|днём|туш|түш|түштө|тушто|түшкү)(\s|$)/.test(t)) {
    entities.part_of_day = "afternoon";
    intent = intent ?? "choose_part_of_day";
  } else if (/(^|\s)(вечер|вечером|кеч|кечинде|кечке|кечки)(\s|$)/.test(t)) {
    entities.part_of_day = "evening";
    intent = intent ?? "choose_part_of_day";
  } else if (!entities.part_of_day) {
    // Typo-tolerant fallback for the part of day ("вечром", "утрам", elongated "днеее").
    if (fuzzyHit(toks, ["утром", "утро"])) { entities.part_of_day = "morning"; intent = intent ?? "choose_part_of_day"; }
    else if (fuzzyHit(toks, ["днем", "день"])) { entities.part_of_day = "afternoon"; intent = intent ?? "choose_part_of_day"; }
    else if (fuzzyHit(toks, ["вечером", "вечер"])) { entities.part_of_day = "evening"; intent = intent ?? "choose_part_of_day"; }
  }

  // Exact yes / no / any-master, now incl. Kyrgyz (ооба/макул = yes, жок = no, баары бир = any).
  if (/(^|\s)(да|ага|ок|окей|хорошо|записывайте|подтверждаю|ооба|макул|yes)(\s|$)/.test(t)) intent = intent ?? "confirm_yes";
  if (/(^|\s)(нет|неа|другое|не подходит|жок|no)(\s|$)/.test(t)) intent = intent ?? "deny_no";
  if (/(^|\s)(любой|любому|без разницы|не принципиально|все равно|всё равно|любое|неважно|не важно|баары бир|баарыбир|бары бир)(\s|$)/.test(t)) intent = intent ?? "any_master";
  // Typo-tolerant yes/no for short confirmations ("оке", "нееет", "ооаба", "макуль").
  if (!intent) {
    if (fuzzyHit(toks, ["окей", "хорошо", "ооба", "макул"])) intent = "confirm_yes";
    else if (fuzzyHit(toks, ["неа", "нет", "жок"])) intent = "deny_no";
  }

--- Правка 1.6 (matchMasterByName: fuzzy по имени) ---
БЫЛО:
function matchMasterByName(masters: DbMaster[], name: string | undefined): DbMaster | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  return (
    masters.find((m) => m.name.toLowerCase() === norm) ??
    masters.find((m) => m.name.toLowerCase().startsWith(norm)) ??
    masters.find((m) => m.name.toLowerCase().includes(norm)) ??
    null
  );
}
СТАЛО:
function matchMasterByName(masters: DbMaster[], name: string | undefined): DbMaster | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  const exact =
    masters.find((m) => m.name.toLowerCase() === norm) ??
    masters.find((m) => m.name.toLowerCase().startsWith(norm)) ??
    masters.find((m) => m.name.toLowerCase().includes(norm));
  if (exact) return exact;
  // Typo-tolerant fallback: closest name within ~1/3 edit distance ("Айгул" → "Айгуль").
  let best: DbMaster | null = null;
  let bestDist = Infinity;
  for (const m of masters) {
    const cand = m.name.toLowerCase();
    const maxLen = Math.max(norm.length, cand.length);
    if (maxLen < 4) continue;
    const d = levenshtein(norm, cand);
    if (d <= Math.floor(maxLen / 3) && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

--- Правка 1.7 (isFirstContact учитывает флаг greeted) ---
БЫЛО:
  // First contact = the assistant hasn't said anything yet in this session → greet warmly.
  const isFirstContact = !input.history.some((m) => m.direction === "out");
СТАЛО:
  // First contact = the assistant hasn't said anything yet in this session → greet warmly.
  // We trust an explicit `greeted` flag over history: history is loaded from `session_started_at`
  // and can be empty after a reload, which previously made the bot greet again and again.
  const isFirstContact =
    input.stateData.greeted !== true && !input.history.some((m) => m.direction === "out");

--- Правка 1.8 (запомнить greeted при первом контакте) ---
БЫЛО:
  // Working copy of state
  let state: WaAgentState = input.state;
  let sd: WaAgentStateData = { ...input.stateData, language };
СТАЛО:
  // Working copy of state
  let state: WaAgentState = input.state;
  let sd: WaAgentStateData = { ...input.stateData, language };
  // Once we greet, remember it for the whole session so we never greet twice.
  if (isFirstContact) sd.greeted = true;

--- Правка 1.9 (новые ответы: clarify + hand-off — вставить ПЕРЕД функцией instructionFallbackReply) ---
Найди строку:
function instructionFallbackReply(factual: string, language: "ru" | "ky" | "en", salonName?: string): string {
И ВСТАВЬ ПЕРЕД НЕЙ:

// Language-aware clarification used when the client keeps replying with something we can't
// parse for the question we're currently on. Deterministic (not paraphrased by Gemini) so the
// wording is GUARANTEED to differ from the previous verbatim question — kills the repeat loop.
function stuckClarifyReply(questionKey: string | undefined, language: "ru" | "ky" | "en"): string {
  const L = <T,>(ru: T, ky: T, en: T): T => (language === "ky" ? ky : language === "en" ? en : ru);
  switch (questionKey) {
    case "service":
      return L(
        "Извините, не совсем поняла 🙂 Напишите, пожалуйста, название услуги — например «стрижка» или «маникюр».",
        "Кечиресиз, толук түшүнбөй калдым 🙂 Кызматтын атын жазыңызчы — мисалы «чач кыркуу» же «маникюр».",
        "Sorry, I didn't quite get that 🙂 Please type the service name — for example “haircut” or “manicure”.",
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

--- Правка 1.10 (compose: усилить вес tone) ---
БЫЛО:
${opts.tone ? `Тон салона: ${opts.tone}` : ""}
СТАЛО:
${opts.tone ? `ОБЯЗАТЕЛЬНЫЕ правила тона и формулировок от салона (соблюдай их в каждом ответе): ${opts.tone}` : ""}

--- Правка 1.11 (downloadImageAsBase64: таймаут + Buffer) ---
БЫЛО:
async function downloadImageAsBase64(url: string): Promise<{ base64: string; mime: string } | { error: string }> {
  try {
    const r = await fetch(url);
    if (!r.ok) return { error: `download ${r.status}` };
    const mime = r.headers.get("content-type") ?? "image/jpeg";
    const ab = await r.arrayBuffer();
    if (ab.byteLength > 4 * 1024 * 1024) return { error: "image too large" };
    const bytes = new Uint8Array(ab);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const base64 = btoa(bin);
    return { base64, mime };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}
СТАЛО:
async function downloadImageAsBase64(url: string): Promise<{ base64: string; mime: string } | { error: string }> {
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

--- Правка 1.12 (range-guard: учитывать price_skipped) ---
БЫЛО:
  // 2) Range-priced service → photo flow before slots
  if (svcRow && svcRow.price_type === "range" && sd.priced_value == null) {
СТАЛО:
  // 2) Range-priced service → photo flow before slots.
  // `price_skipped` means Vision failed earlier and we agreed the master prices on site — without
  // it the null `priced_value` made the bot ask for a photo again on every later turn.
  if (svcRow && svcRow.price_type === "range" && sd.priced_value == null && !sd.price_skipped) {

--- Правка 1.13 (ошибка Vision выставляет price_skipped) ---
БЫЛО:
      if ("error" in priced) {
        debug.errors.push(`vision: ${priced.error}`);
        factual = `Не получилось оценить по фото. Скажи, что точную стоимость мастер озвучит на месте, а пока подбери удобное время.`;
        // Fall through — proceed without override
        sd.priced_value = undefined;
      } else {
СТАЛО:
      if ("error" in priced) {
        debug.errors.push(`vision: ${priced.error}`);
        factual = `Не получилось оценить по фото. Скажи, что точную стоимость мастер озвучит на месте, а пока подбери удобное время.`;
        // Proceed without a price override, and remember we skipped so we don't re-ask for a photo.
        sd.priced_value = undefined;
        sd.price_skipped = true;
      } else {

--- Правка 1.14 (смена услуги сбрасывает price_skipped) ---
БЫЛО:
        sd.service_price_type = svc.price_type as any;
        sd.priced_value = undefined;
        sd.master_id = undefined;
СТАЛО:
        sd.service_price_type = svc.price_type as any;
        sd.priced_value = undefined;
        sd.price_skipped = undefined;
        sd.master_id = undefined;

--- Правка 1.15 (finish(): анти-зацикливание + эскалация) ---
БЫЛО:
  // ----- closure helper to render and return
  async function finish(): Promise<WaAgentResult> {
    let reply: string;
    try {
      reply = await compose1(factual);
    } catch (e: any) {
      reply = instructionFallbackReply(factual, language, input.salon.salonName);
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
СТАЛО:
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
      reply = instructionFallbackReply(factual, language, input.salon.salonName);
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

==================================================================
ФАЙЛ 2: src/routes/api/public/wa.$salonId.ts
==================================================================

--- Правка 2.1 (не сбрасывать активную бронь при паузе) ---
БЫЛО:
        const { data: existingConv } = await supabaseAdmin
          .from("wa_conversations")
          .select("id, status, session_started_at, last_appointment_at, last_message_at")
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
        const gapMs = previousLastMessageAt ? Date.now() - previousLastMessageAt : 0;
        const startsNewSession =
          !existingConv ||
          gapMs > 20 * 60 * 1000 ||
          (previousLastAppointmentAt > 0 && previousLastAppointmentAt >= previousSessionStartedAt);
СТАЛО:
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

--- Правка 2.2 (объявить lastSentReply) ---
БЫЛО:
          let curState: WaAgentState = (convSnapshot.state ?? "idle") as WaAgentState;
          let curStateData = convSnapshot.state_data ?? {};
          let curSelectedBranch: string | null = convSnapshot.selected_branch_id ?? null;
          const sessionStartedAt = (convSnapshot.session_started_at ?? nowIso) as string;
СТАЛО:
          let curState: WaAgentState = (convSnapshot.state ?? "idle") as WaAgentState;
          let curStateData = convSnapshot.state_data ?? {};
          let curSelectedBranch: string | null = convSnapshot.selected_branch_id ?? null;
          const sessionStartedAt = (convSnapshot.session_started_at ?? nowIso) as string;
          // Track the last text we actually sent in THIS drain pass so we don't fire the exact
          // same WhatsApp message twice when the client double-texts within one webhook window.
          let lastSentReply: string | null = null;

--- Правка 2.3 (дедуп одинаковых исходящих) ---
БЫЛО:
            // 5) Send reply
            const sent = await greenApiSendMessage(creds, chatId, result.reply);
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
              } as any,
            });
СТАЛО:
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

==================================================================
ФАЙЛ 3: src/components/admin/WaChatsTab.tsx
==================================================================

--- Правка 3.1 (тип Conversation: добавить state_data) ---
БЫЛО:
  status: "active" | "booked" | "closed";
  last_message_at: string;
  last_message_preview: string | null;
};
СТАЛО:
  status: "active" | "booked" | "closed";
  last_message_at: string;
  last_message_preview: string | null;
  state_data: { needs_human?: boolean } | null;
};

--- Правка 3.2 (helper needsHuman — после функции statusBadge) ---
БЫЛО:
function statusBadge(s: Conversation["status"]) {
  if (s === "booked") return <Badge>Записан</Badge>;
  if (s === "closed") return <Badge variant="outline">Закрыт</Badge>;
  return <Badge variant="secondary">Активный</Badge>;
}
СТАЛО:
function statusBadge(s: Conversation["status"]) {
  if (s === "booked") return <Badge>Записан</Badge>;
  if (s === "closed") return <Badge variant="outline">Закрыт</Badge>;
  return <Badge variant="secondary">Активный</Badge>;
}

// The assistant gave up after repeated confusion and flagged the chat for a live admin.
const needsHuman = (c: Conversation) => c.state_data?.needs_human === true;

--- Правка 3.3 (бейдж в списке диалогов) ---
БЫЛО:
                    <div className="font-medium truncate text-sm">
                      {c.client_name || c.client_phone}
                    </div>
                    {statusBadge(c.status)}
                  </div>
СТАЛО:
                    <div className="font-medium truncate text-sm">
                      {c.client_name || c.client_phone}
                    </div>
                    {needsHuman(c) ? <Badge variant="destructive">Нужен ответ</Badge> : statusBadge(c.status)}
                  </div>

--- Правка 3.4 (бейдж в шапке чата) ---
БЫЛО:
                  <div className="text-xs text-muted-foreground">{activeConv.client_phone}</div>
                </div>
                {statusBadge(activeConv.status)}
СТАЛО:
                  <div className="text-xs text-muted-foreground">{activeConv.client_phone}</div>
                </div>
                {needsHuman(activeConv) ? (
                  <Badge variant="destructive">Нужен ответ администратора</Badge>
                ) : (
                  statusBadge(activeConv.status)
                )}

==================================================================
ФАЙЛ 4: src/components/admin/AiAssistantTab.tsx
==================================================================

--- Правка 4.1 (подсказка под полем «Как разговаривать с клиентами») ---
БЫЛО:
          <p className="text-xs text-muted-foreground">
            Тон общения, на каких языках отвечать, что важно учитывать (например —
            не использовать сленг, всегда уточнять имя).
          </p>
СТАЛО:
          <p className="text-xs text-muted-foreground">
            Управляет тоном и формулировками ассистента: вежливость, обращение на «вы»,
            запрет сленга, фирменные фразы (например — «не использовать сленг», «всегда
            предлагать комбо стрижка+укладка»). Шаги записи (услуга → день → время →
            мастер → подтверждение) выстроены автоматически и всегда соблюдаются.
          </p>

==================================================================
КОНЕЦ. Тестовый файл wa-agent.scenarios.test.ts менять НЕ нужно (он только для локальных тестов,
в сборку/деплой не входит).
==================================================================
