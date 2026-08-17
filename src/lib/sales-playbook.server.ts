// The sales brain of the virtual administrator.
//
// WHY THIS EXISTS AS CODE AND NOT AS MORE PROMPT
// ----------------------------------------------
// The V4 system prompt already runs ~12k tokens. Appending a full objection-handling
// playbook to every turn would (a) cost latency and money on every message, and
// (b) dilute instruction-following — the more rules compete for attention, the less
// reliably any single one is obeyed. So the playbook is SELECTIVE: this module detects
// which objection (if any) is actually on the table in THIS message and renders only
// that play, plus the owner's own facts.
//
// The second thing prose cannot do is COUNT. The single worst failure mode of an LLM
// salesperson is not being too soft — it is ending every message with "давайте запишу
// вас" regardless of what the client said. No amount of "не будь навязчивым" fixes it,
// because the model has no memory of how many times it already asked. A deterministic
// counter does: `closeAttempts` goes up on every turn we pushed for a booking without
// the client moving forward, and above a threshold the prompt flips to an explicit
// "закрытие в этом сообщении ЗАПРЕЩЕНО".
//
// WHY NOT MASLOW (asked directly, answered directly): Maslow's hierarchy is a
// descriptive theory of motivation with weak empirical support, and — decisively for
// this use case — it yields no computable next action. "Клиент на уровне потребности
// в принадлежности" does not tell the assistant whether to name a price, ask a
// question, or offer a slot. The frameworks that do transfer to a messenger sale are
// consultative selling (one diagnostic question that materially changes the
// recommendation), a named objection taxonomy with a per-type play, and an
// acknowledge → clarify → answer-with-a-fact → low-commitment-next-step pattern.
// SPIN contributes only its first half here; full SPIN is a long-cycle B2B method and
// its "implication" questions read as manipulation in a beauty DM.
//
// This module is pure: no DB, no network, no clock beyond what is passed in. That is
// what makes the whole sales layer unit-testable (see sales-playbook.test.ts).

// ---------------------------------------------------------------------------
// Owner-configured playbook (salon_ai_assistant.sales_* columns)
// ---------------------------------------------------------------------------

export type SalesObjectionEntry = {
  /** What the client says, in the owner's own words: «дорого», «у конкурентов дешевле». */
  trigger: string;
  /** The answer the owner wants given. Injected verbatim — it outranks the generic play. */
  answer: string;
};

export type SalesPromo = {
  title: string;
  details?: string | null;
  /** ISO date. A promo past its date is dropped, never quoted. */
  until?: string | null;
};

/**
 * How the assistant sells, chosen by the owner (salon_ai_assistant.sales_style).
 *
 * 'light'  — консультант: отвечает по сути, понимает ситуацию, ведёт к записи
 *            только когда это естественно следует из диалога.
 * 'active' — сильный администратор: выясняет настоящую потребность, работает с
 *            сомнениями до того, как они прозвучат, доводит до записи и (если она
 *            включена) до предоплаты.
 *
 * Both styles are bound by the same facts: prices, slots, masters and guarantees come
 * from tools and the owner's knowledge base. "Active" changes the conversational
 * strategy, never what may be claimed — that boundary is what keeps the mode safe to
 * hand to a salon owner as a checkbox.
 */
export type SalesStyle = "light" | "active";

export type SalesPlaybookConfig = {
  usp: string[];
  objections: SalesObjectionEntry[];
  promos: SalesPromo[];
  bookingLinkMode: "off" | "auto" | "eager";
  /** salon_ai_assistant.sales_style. Legacy sales_mode=true maps to 'active'. */
  style: SalesStyle;
};

/**
 * Normalise whatever is in the JSONB columns into a config the renderer can trust.
 * Deliberately forgiving: a salon whose row predates this migration, or whose column
 * holds an object instead of an array, must degrade to "no playbook" — never throw
 * inside a live conversation.
 */
export function parseSalesPlaybook(raw: {
  sales_usp?: unknown;
  sales_objections?: unknown;
  sales_promos?: unknown;
  booking_link_mode?: unknown;
  sales_style?: unknown;
  /** Legacy boolean, still honoured: a row read before the sales_style migration has only this. */
  sales_mode?: unknown;
}): SalesPlaybookConfig {
  const usp = asArray(raw.sales_usp)
    .map((x) =>
      typeof x === "string" ? x : typeof (x as any)?.text === "string" ? (x as any).text : "",
    )
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);

  const objections = asArray(raw.sales_objections)
    .map((x) => {
      const o = x as any;
      return {
        trigger: String(o?.trigger ?? "").trim(),
        answer: String(o?.answer ?? "").trim(),
      };
    })
    .filter((o) => o.trigger && o.answer)
    .slice(0, 20);

  const promos = asArray(raw.sales_promos)
    .map((x) => {
      const p = x as any;
      return {
        title: String(p?.title ?? "").trim(),
        details: p?.details ? String(p.details).trim() : null,
        until: p?.until ? String(p.until).trim() : null,
      };
    })
    .filter((p) => p.title)
    .slice(0, 10);

  const mode = raw.booking_link_mode;
  return {
    usp,
    objections,
    promos,
    bookingLinkMode: mode === "off" || mode === "eager" ? mode : "auto",
    style: parseSalesStyle(raw.sales_style, raw.sales_mode),
  };
}

/**
 * Anything unrecognised becomes 'light'. A typo in the column must not silently turn a
 * salon into a pushy salesperson — the safe failure direction is the calm one.
 */
export function parseSalesStyle(style: unknown, legacyMode?: unknown): SalesStyle {
  if (style === "active" || style === "light") return style;
  return legacyMode === true ? "active" : "light";
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  // The columns are jsonb; a client that stored a JSON *string* still round-trips here.
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Promos whose `until` date has passed are never shown — quoting a dead offer is a lie. */
export function activePromos(promos: SalesPromo[], todayIso: string): SalesPromo[] {
  return promos.filter((p) => {
    if (!p.until) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.until)) return true; // unparseable → owner's problem, keep it
    return p.until >= todayIso;
  });
}

// ---------------------------------------------------------------------------
// Objection taxonomy + detection
// ---------------------------------------------------------------------------

export type ObjectionKind =
  | "price" // «дорого», «кымбат», «а подешевле есть?»
  | "think" // «я подумаю», «ойлонуп көрөйүн»
  | "later" // «потом напишу», «позже», «кийин жазам»
  | "why_you" // «а почему именно вы», «чем вы лучше»
  | "fear" // страх процедуры/боли/вреда
  | "result_doubt" // «а получится?», «а держится?», сомнение в результате
  | "value_doubt" // «а это окупится?», «стоит ли», «ну не знаю» — сомнение в СМЫСЛЕ трат
  | "competitor"; // сравнение с конкретным другим салоном/ценой

/**
 * Keyword sets per objection, across the three languages the platform serves.
 *
 * Deliberately a hand-written matcher and not another LLM call: this runs on the hot
 * path of every single inbound message, and an extra model round-trip would add
 * latency to a system whose whole perf story (see the 2026-07-25 latency work) is
 * about not spending seconds we don't have. False negatives are cheap — the generic
 * prompt still handles the objection, just without the specialised play. False
 * positives are cheap too — the play is advice, not a script.
 */
const OBJECTION_PATTERNS: Array<{ kind: ObjectionKind; re: RegExp }> = [
  {
    kind: "price",
    re: /(дорог|дороговат|кымбат|дорого\s*же|подешевл|дешевл|скидк|арзан|арзыраак|цена\s*кусает|не\s*по\s*карман|бюджет|expensive|pricey|too\s*much|discount)/i,
  },
  {
    kind: "think",
    re: /(подума|поразмышл|обдума|ойлон|ойлонуп|посовету|с\s*мужем|с\s*мамой|надо\s*решить|определ(юсь|имся)|think\s*about|let\s*me\s*think)/i,
  },
  {
    kind: "later",
    re: /(потом\s*напиш|позже\s*напиш|напишу\s*позж|попозж|как-нибудь|в\s*другой\s*раз|не\s*сейчас|пока\s*нет|кийин|кийинчерээк|азыр\s*эмес|later|next\s*time|not\s*now)/i,
  },
  {
    kind: "why_you",
    re: /(почему\s*(именно\s*)?вы|чем\s*вы\s*лучше|а\s*вы\s*точно|вам\s*можно\s*доверя|давно\s*(ли\s*)?работа|опыт\s*есть|эмне\s*үчүн\s*сиз|why\s*you|why\s*should\s*i)/i,
  },
  {
    kind: "fear",
    re: /(боюсь|страшн|больно\s*ли|это\s*больно|вредно|вред\s*ли|навред|опасно|аллерг|испорт|сожж|коркуп|оору(бу|byu)?|зыян|зыяндуу|painful|does\s*it\s*hurt|is\s*it\s*safe)/i,
  },
  {
    kind: "result_doubt",
    re: /(а\s*(если\s*)?не\s*получ|не\s*понрав|точно\s*получится|сколько\s*держ|надолго\s*ли|как\s*долго\s*держ|результат\s*(будет|точно)|гарант|кепилдик|натыйжа|will\s*it\s*(work|last)|guarantee)/i,
  },
  {
    kind: "competitor",
    re: /(в\s*другом\s*салоне|у\s*других|у\s*конкурент|там\s*дешевл|мне\s*предлож|видел[аи]?\s*за|башка\s*салон|another\s*salon|cheaper\s*elsewhere)/i,
  },
  // The doubt that is NOT about price and NOT about the result, but about whether the whole
  // thing is worth doing at all. Prod 2026-08-12: «ну не знаю» and «а это окупится?» matched
  // nothing, so no play fired and the assistant answered with reassurance and another CTA —
  // the single most common way a warm lead goes cold.
  {
    kind: "value_doubt",
    re: /(окупит|стоит\s*ли|есть\s*ли\s*смысл|нет\s*ли\s*смысл|имеет\s*ли\s*смысл|не\s*знаю,?\s*(надо|нужно|стоит)?|ну\s*не\s*знаю|сомнева|не\s*уверен|а\s*надо\s*ли|туура\s*болобу|акча\s*текке|worth\s*it|not\s*sure)/i,
  },
];

/**
 * Which objections are on the table in this message. Returns every match, most
 * specific first (competitor/why_you before the broad price/think buckets), because
 * "в другом салоне дешевле" is both — and the competitor play is the useful one.
 */
export function detectObjections(text: string): ObjectionKind[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  const hits = OBJECTION_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.kind);
  if (hits.length <= 1) return hits;
  const priority: ObjectionKind[] = [
    "competitor",
    "why_you",
    "fear",
    "result_doubt",
    "value_doubt",
    "price",
    "later",
    "think",
  ];
  return [...hits].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type Readiness =
  | "ready" // explicitly asking to book / confirming
  | "objecting"
  | "exploring"; // asking about price, service, options — the default

const READY_RE =
  /(запиш|записа|запись|жазып|жаз(ып)?\s*кой|жазылам|бронир|хочу\s*на|давайте\s*на|book\s*me|sign\s*me\s*up|беремте|берем)/i;

/**
 * Is the client actively working on WHEN — naming a day, a time, or a part of the day?
 *
 * This exists to keep the anti-nag governor honest. Without it, a client browsing days
 * («а в пятницу?» … «а вечером?») looks identical to a client deflecting: neither says
 * "запишите", so both would read as "we pushed and nothing happened". The counter would
 * climb and the stop rule would forbid offering times — at the exact moment the client is
 * asking for times. Engagement with scheduling IS progress, even without the word "запись".
 */
const SCHEDULE_SIGNAL_RE = new RegExp(
  [
    "\\b\\d{1,2}[:.]\\d{2}\\b", // 17:00
    "\\b\\d{1,2}\\s*(час|ч\\b|саат)", // «в 5 часов», «саат 5»
    "\\b\\d{1,2}\\s*(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)",
    "сегодня|завтра|послезавтра|бүгүн|эртең|бүрсүгүнү|today|tomorrow",
    "понедельник|вторник|сред[ауы]|четверг|пятниц|суббот|воскресен",
    "дүйшөмбү|шейшемби|шаршемби|бейшемби|жума|ишемби|жекшемби",
    "monday|tuesday|wednesday|thursday|friday|saturday|sunday",
    "утром|днём|днем|вечером|обед|эртең\\s*менен|кечинде|morning|evening",
    "попозже|пораньше|раньше|позже",
    "на\\s*выходн|на\\s*этой\\s*неделе|на\\s*следующей\\s*неделе",
  ].join("|"),
  "i",
);

export function hasSchedulingSignal(text: string): boolean {
  return SCHEDULE_SIGNAL_RE.test(text ?? "");
}

/**
 * Coarse readiness signal. Objection wins over "ready" wording on purpose: «запишите,
 * но дорого же» is an objection to answer first, not a green light.
 */
export function classifyReadiness(text: string, objections: ObjectionKind[]): Readiness {
  if (objections.length) return "objecting";
  if (READY_RE.test(text ?? "")) return "ready";
  return "exploring";
}

// ---------------------------------------------------------------------------
// The anti-nag governor
// ---------------------------------------------------------------------------

export type SalesTurnState = {
  /** Consecutive turns where we pushed toward a booking and the client did NOT advance. */
  closeAttempts: number;
  /** Objection kinds already handled in this conversation — never re-run the same play. */
  handled: ObjectionKind[];
  /** How many times we have shown the client free slots. Drives booking-link fatigue. */
  slotRounds: number;
  /** ISO instant the online-booking link was last sent. One per session unless asked again. */
  bookingLinkSentAt?: string | null;
};

export const EMPTY_SALES_STATE: SalesTurnState = {
  closeAttempts: 0,
  handled: [],
  slotRounds: 0,
  bookingLinkSentAt: null,
};

/** Tolerant read of state_data.sales — an old conversation has no such key. */
export function readSalesState(raw: unknown): SalesTurnState {
  const s = (raw ?? {}) as any;
  return {
    closeAttempts: Number.isFinite(s.closeAttempts) ? Math.max(0, Math.trunc(s.closeAttempts)) : 0,
    handled: Array.isArray(s.handled)
      ? s.handled.filter((k: unknown): k is ObjectionKind =>
          OBJECTION_PATTERNS.some((p) => p.kind === k),
        )
      : [],
    slotRounds: Number.isFinite(s.slotRounds) ? Math.max(0, Math.trunc(s.slotRounds)) : 0,
    bookingLinkSentAt: typeof s.bookingLinkSentAt === "string" ? s.bookingLinkSentAt : null,
  };
}

/** Above this many fruitless pushes, the assistant is forbidden from closing again. */
export const CLOSE_ATTEMPT_LIMIT = 2;

/**
 * Did the assistant's own reply ask for the booking?
 *
 * The governor used to learn about a push only from tool calls — slots fetched, appointment
 * created. That misses the push that actually annoys people: a plain sentence, no tool
 * involved, «что скажете, подберём удобное время?», repeated verbatim at the end of every
 * message. Prod on 2026-08-12 showed four such closes in a row with closeAttempts still 0,
 * so the stop rule — the one mechanism designed to prevent exactly this — never armed.
 *
 * Matched against the OUTGOING text, which is the only place a verbal close exists. Kept as a
 * hand-written matcher for the same reason as the objection patterns: it runs every turn and
 * must not cost a model round-trip. A false positive is cheap (one turn of extra restraint);
 * a false negative is what produced the nagging.
 */
const CLOSE_ATTEMPT_RE = new RegExp(
  [
    "подбер(у|ём|ем)\\s+(вам\\s+)?(удобн|врем|окош|дат)",
    "подобрать\\s+(вам\\s+)?врем",
    "запиш(у|ем|ать)\\s*(вас|тебя)?",
    "записать\\s+вас",
    "хотите\\s+записа",
    "готовы\\s+записа",
    "на\\s+какой\\s+день",
    "какое\\s+время\\s+(вам\\s+)?(подойд|удобн)",
    "когда\\s+(вам\\s+)?удобн",
    "во\\s+сколько\\s+(вам\\s+)?удобн",
    "оформ(лю|им)\\s+запись",
    "давайте\\s+запиш",
    "жазып\\s*кой", // ky: «записать»
    "качан\\s+ынгайлуу", // ky: «когда удобно»
    "убакыт\\s+тандай", // ky: «выбрать время»
    "book\\s+you\\s+in",
    "shall\\s+i\\s+book",
    "what\\s+time\\s+works",
  ].join("|"),
  "i",
);

export function detectCloseAttempt(replyText: string): boolean {
  return CLOSE_ATTEMPT_RE.test(replyText ?? "");
}

/**
 * Advance the governor after a turn.
 *
 * "Progress" is the escape hatch: a booking, a reschedule, or the client naming a day
 * or a time all mean the push WORKED, so the counter resets. It only climbs when we
 * asked for the booking and got a deflection back — which is exactly the pattern that
 * reads as nagging.
 *
 * Getting this asymmetry right is the whole feature. Counting too eagerly is WORSE than
 * not counting at all: a client happily picking through days would trip the stop rule and
 * the assistant would refuse to offer times to someone who is asking for them.
 */
export function nextSalesState(
  prev: SalesTurnState,
  turn: {
    objections: ObjectionKind[];
    /** The client advanced: booked, picked a slot, gave a day, confirmed. */
    progressed: boolean;
    /** This turn ended with a push toward booking (slots offered / summary shown). */
    pushedToClose: boolean;
    /** get_available_slots / check_time ran this turn. */
    showedSlots: boolean;
    bookingLinkSentAt?: string | null;
  },
): SalesTurnState {
  const handled = [...prev.handled];
  for (const k of turn.objections) if (!handled.includes(k)) handled.push(k);
  return {
    closeAttempts: turn.progressed
      ? 0
      : turn.pushedToClose
        ? prev.closeAttempts + 1
        : prev.closeAttempts,
    handled: handled.slice(-8),
    slotRounds: turn.showedSlots ? prev.slotRounds + 1 : prev.slotRounds,
    bookingLinkSentAt: turn.bookingLinkSentAt ?? prev.bookingLinkSentAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------
//
// WHY A STAGE MACHINE ON TOP OF THE OBJECTION PLAYS
// -------------------------------------------------
// The plays above answer "what do I say about THIS objection". They say nothing about "where
// is this conversation, and what is the single next step". Without that, the model picks a
// next step from the whole menu every turn — which is how you get a greeting that also
// quotes a price, asks about the client's goal, offers three slots and mentions a promo. Each
// sentence is defensible; together they are a wall of text nobody answers.
//
// The stage is computed from FACTS THE SERVER ALREADY HAS (does this person have an upcoming
// appointment? is a prepayment hold open? has a service been chosen? is an objection on the
// table?) — never inferred by the model. That is what makes it trustworthy enough to
// constrain the reply, and it costs zero extra tokens and zero extra round-trips.

export type FunnelStage =
  | "new_lead" // first contact, nothing known yet
  | "discovery" // talking, but the real need is not established
  | "consulting" // service is on the table, explaining and pricing
  | "objection" // a doubt is blocking progress
  | "offer_booking" // doubt cleared / client engaged with WHEN
  | "prepayment" // slot held, waiting on the receipt
  | "booked"; // has a confirmed upcoming visit

export type FunnelFacts = {
  /** Client already has a confirmed appointment in the future. */
  hasUpcomingAppointment: boolean;
  /** A prepayment hold is open and unpaid. */
  awaitingPrepayment: boolean;
  /** A service has been settled on in this conversation. */
  serviceChosen: boolean;
  /** Assistant turns so far in this session. 0 = we have not spoken yet. */
  turnCount: number;
};

/**
 * Order of checks is the priority order, and it is deliberate.
 *
 * `booked` and `prepayment` come FIRST, above objections and everything else, because they
 * are the two states where the wrong move is most expensive: pitching a booking to someone
 * who already has one reads as "you don't know who I am", and pitching anything to someone
 * mid-payment interrupts money that is already moving.
 */
export function classifyFunnelStage(
  facts: FunnelFacts,
  objections: ObjectionKind[],
  readiness: Readiness,
  schedulingSignal: boolean,
): FunnelStage {
  if (facts.awaitingPrepayment) return "prepayment";
  if (facts.hasUpcomingAppointment) return "booked";
  if (objections.length) return "objection";
  if (readiness === "ready" || schedulingSignal) return "offer_booking";
  if (facts.serviceChosen) return "consulting";
  if (facts.turnCount === 0) return "new_lead";
  return "discovery";
}

/**
 * How far along the funnel each stage sits — for REPORTING, not for choosing a reply.
 *
 * This is a different question from the one classifyFunnelStage answers. That function returns the
 * stage that should shape THIS turn, in priority order: a client who has objected gets the objection
 * treatment even if a service is already picked. For a funnel report the question is instead "how
 * far did this conversation ever get", so the stages need a monotonic order.
 *
 * `objection` is ranked ABOVE `consulting` deliberately. An objection means the client engaged with
 * a concrete proposal — that is further than merely being told about a service. It also makes the
 * report actionable in the way that matters: a pile-up at `objection` is a script problem with a
 * known fix, while a pile-up at `discovery` means clients are leaving before anything was offered.
 */
export const FUNNEL_STAGE_RANK: Record<FunnelStage, number> = {
  new_lead: 0,
  discovery: 1,
  consulting: 2,
  objection: 3,
  offer_booking: 4,
  prepayment: 5,
  booked: 6,
};

/**
 * The further along of two stages. Used to keep a "furthest reached" marker on the conversation, so
 * a client who reached `offer_booking` and then drifted back to `discovery` is still counted as
 * having got that far — otherwise the report only ever shows where conversations ENDED, which
 * systematically understates how well the assistant is doing.
 */
export function furthestFunnelStage(
  a: FunnelStage | null | undefined,
  b: FunnelStage,
): FunnelStage {
  if (!a || !(a in FUNNEL_STAGE_RANK)) return b;
  return FUNNEL_STAGE_RANK[a] >= FUNNEL_STAGE_RANK[b] ? a : b;
}

/**
 * One short block per stage, each ending in the ONE next step for this turn.
 *
 * Kept to a handful of lines on purpose. The system prompt is already ~12k tokens; the value
 * here is not more instruction, it is *narrowing* — telling the model which single move is on
 * the table so it stops choosing from all of them at once.
 */
export function renderStageBlock(
  stage: FunnelStage,
  sn: { nomSg: string; genSg: string },
  opts: { style: SalesStyle },
): string {
  const active = opts.style === "active";
  const head = `━━━ ЭТАП РАЗГОВОРА: ${STAGE_LABEL[stage]} ━━━`;
  switch (stage) {
    case "new_lead":
      return [
        head,
        `Это первое сообщение. Коротко поздоровайся и ответь ровно на то, что человек спросил. НЕ вываливай прайс, преимущества и предложение записаться сразу — сначала пойми, зачем он написал.`,
        active
          ? `СЛЕДУЮЩИЙ ШАГ: ответь на вопрос и задай ОДИН вопрос про его ситуацию — не «чем помочь», а по сути того, с чем он пришёл («давно это беспокоит?», «к какой дате хотите привести себя в порядок?»). Этот вопрос нужен тебе, чтобы дальше говорить о ЕГО случае, а не об услуге вообще.`
          : `СЛЕДУЮЩИЙ ШАГ: один короткий вопрос о его запросе (что беспокоит / что хочет решить). Одно сообщение — один вопрос.`,
      ].join("\n");

    case "discovery":
      return [
        head,
        `Настоящая потребность ещё не ясна. Твоя задача сейчас — понять её, а не продать. Слушай, что человек называет проблемой ЕГО словами, и опирайся дальше именно на эти слова.`,
        active
          ? `СЛЕДУЮЩИЙ ШАГ: один точный вопрос, ответ на который РЕАЛЬНО меняет рекомендацию (что уже пробовал, что не устроило в прошлый раз, к какому сроку нужен результат). Общие вопросы «для галочки» не задавай. Предлагать запись рано — сначала пойми, что человеку нужно.`
          : `СЛЕДУЮЩИЙ ШАГ: один уточняющий вопрос по сути. Предлагать запись на этом этапе рано.`,
      ].join("\n");

    case "consulting":
      return [
        head,
        `Услуга уже обсуждается. Отвечай по существу фактами из прайса и книги знаний, связывая ответ с тем, что человек назвал своей проблемой.`,
        active
          ? `СЛЕДУЮЩИЙ ШАГ: закрой текущий вопрос и свяжи ответ с ЕГО ситуацией — что именно это решает лично для него. Если вопрос закрыт — сам предложи следующий шаг к записи одной фразой, не жди инициативы. Не задавай нового вопроса, пока не ответили на прошлый.`
          : `СЛЕДУЮЩИЙ ШАГ: закрой текущий вопрос. Не задавай нового вопроса, пока не ответили на прошлый. Предлагай запись, только если человек сам показал, что готов говорить о времени.`,
      ].join("\n");

    case "objection":
      return [
        head,
        `У человека сомнение. Пока оно не снято, любое предложение записаться воспринимается как давление.`,
        active
          ? `СЛЕДУЮЩИЙ ШАГ: отработать возражение по схеме ниже — сначала понять НАСТОЯЩУЮ причину, а не спорить с формулировкой. Ничего больше в этом сообщении.`
          : `СЛЕДУЮЩИЙ ШАГ: отработать возражение по схеме ниже. Ничего больше в этом сообщении.`,
      ].join("\n");

    case "offer_booking":
      return [
        head,
        `Человек готов говорить о времени. Не начинай консультацию заново и не пересказывай уже сказанное.`,
        active
          ? `СЛЕДУЮЩИЙ ШАГ: довести до конкретного времени. Не «хотите записаться?» — а предложи 1–2 реальных ближайших окна из инструментов и дай выбрать. Спрашивай день, потом время — по одному, а не всё сразу.`
          : `СЛЕДУЮЩИЙ ШАГ: получить день и время. Спрашивай день, потом время — по одному, а не всё сразу.`,
      ].join("\n");

    case "prepayment":
      return [
        head,
        `Слот держится за клиентом, ждём подтверждение оплаты. Ничего не продавай и не предлагай — это собьёт человека посреди оплаты.`,
        `СЛЕДУЮЩИЙ ШАГ: спокойно ответь на его вопрос и подскажи, что делать с оплатой. Второй раз реквизиты и QR не отправляй, если он не попросил.`,
      ].join("\n");

    case "booked":
      return [
        head,
        `У этого человека УЖЕ ЕСТЬ подтверждённая запись впереди. Предлагать записаться снова, спрашивать «на какой день вам удобно» и подбирать время — ЗАПРЕЩЕНО: он подумает, что его запись потеряли.`,
        `СЛЕДУЮЩИЙ ШАГ: ответь на его вопрос. Если он хочет ДРУГУЮ услугу или ВТОРУЮ запись — сначала прямо уточни, что это дополнительно к уже существующей записи, и только потом подбирай время. Если он хочет перенести или отменить — используй нужный инструмент.`,
      ].join("\n");
  }
}

const STAGE_LABEL: Record<FunnelStage, string> = {
  new_lead: "новый обращение",
  discovery: "выясняем потребность",
  consulting: "консультируем",
  objection: "работаем с возражением",
  offer_booking: "предлагаем запись",
  prepayment: "ждём предоплату",
  booked: "клиент уже записан",
};

// ---------------------------------------------------------------------------
// The plays
// ---------------------------------------------------------------------------

/**
 * One play per objection type. Each follows the same four moves — acknowledge, find
 * the real driver, answer with a FACT (never an invented benefit), offer a step that
 * costs the client nothing — because a consistent shape is what makes the assistant
 * read as one competent person instead of seven different scripts.
 *
 * `sn` is the industry's specialist noun ("мастер" / "врач"), so a dental clinic never
 * reads a line about "мастера".
 */
function playFor(kind: ObjectionKind, sn: { nomSg: string; genSg: string }): string {
  switch (kind) {
    case "price":
      return [
        `ВОЗРАЖЕНИЕ «ДОРОГО» — отработай так, НЕ оправдывайся и НЕ извиняйся за цену:`,
        `1) Прими всерьёз, без спора: «Понимаю, сумма ощутимая».`,
        `2) Пойми, ЧТО именно за этим стоит — не угадывай. Обычно одно из трёх: не понял, за что платит; сравнил с более дешёвым предложением; сейчас нет такой суммы. Задай ОДИН короткий вопрос, чтобы понять, какое из трёх («Вам важнее уложиться в бюджет или получить максимально стойкий результат?»).`,
        `3) Ответь ФАКТАМИ этого бизнеса: из чего складывается цена (материалы, длительность, квалификация ${sn.genSg}), что входит в услугу, что клиент НЕ платит отдельно. Только реальные факты из прайса и правил салона.`,
        `4) Дай честную альтернативу, если она есть в прайсе: более простой вариант услуги, меньшая зона, другой ${sn.nomSg} с другой ценой. Если альтернативы нет — так и скажи.`,
        `ЗАПРЕЩЕНО: выдумывать скидку, рассрочку, «специальную цену для вас», бонус или подарок, которых нет в фактах салона. Скидку можно упомянуть ТОЛЬКО если она есть в списке акций. Если акций нет — не намекай на них вовсе.`,
      ].join("\n");

    case "think":
      return [
        `ВОЗРАЖЕНИЕ «Я ПОДУМАЮ» — это почти всегда вежливая форма невысказанного сомнения, а не отказ:`,
        `1) Согласись искренне: «Конечно, подумайте — это ваши деньги и ваше время».`,
        `2) Одним мягким вопросом достань настоящее сомнение: «Подскажите, что смущает больше — цена или сам результат? Отвечу честно».`,
        `3) Если клиент назвал сомнение — отработай его по сути и фактами. Если не назвал — не дави и не повторяй вопрос.`,
        `4) Оставь дверь открытой БЕЗ давления: скажи, что будете рады видеть, и что написать можно в любой момент. Никакого «а то места разберут», если это неправда.`,
        `ЗАПРЕЩЕНО: повторять предложение записаться в том же сообщении, где клиент сказал «подумаю».`,
      ].join("\n");

    case "later":
      return [
        `ВОЗРАЖЕНИЕ «ПОТОМ НАПИШУ / ПОЗЖЕ» — не удерживай силой:`,
        `1) Спокойно прими: «Хорошо, будем на связи».`,
        `2) Дай ОДНУ полезную вещь напоследок, без вопроса в конце: например, до какого числа держится акция (если она реально есть), или что на выходные обычно записываются заранее — только если это правда.`,
        `3) Закончи тепло и коротко. Больше вопросов в этом сообщении не задавай — клиент явно попросил паузу.`,
        `ЗАПРЕЩЕНО: «а давайте всё-таки подберём время», «может, всё же запишем», уточняющие вопросы после явной просьбы отложить.`,
      ].join("\n");

    case "why_you":
      return [
        `ВОПРОС «ПОЧЕМУ ИМЕННО ВЫ» — это запрос на доверие, отвечать нужно конкретикой, а не самопохвалой:`,
        `1) Отвечай ТОЛЬКО реальными фактами этого бизнеса: преимущества из блока ниже, опыт и специализация ${sn.genSg} (из get_masters — specialization/bio_short), что входит в услугу, гарантия — если она реально задана владельцем.`,
        `2) Одна-две конкретики сильнее пяти общих слов. «У нас качественно и индивидуальный подход» — пустая фраза, так писать нельзя.`,
        `3) Если владелец не задал преимуществ — НЕ выдумывай их. Честно расскажи, что входит в услугу и как работает ${sn.nomSg}, и предложи прийти на консультацию.`,
        `ЗАПРЕЩЕНО: сравнивать себя с конкретными конкурентами, обесценивать других, обещать «лучшие в городе», приписывать себе награды, сертификаты и стаж, которых нет в фактах салона.`,
      ].join("\n");

    case "fear":
      return [
        `СТРАХ ПРОЦЕДУРЫ (боль, вред, «испорчу») — здесь честность важнее записи:`,
        `1) Признай страх как нормальный, не отмахивайся: «Это частый вопрос, отвечу честно».`,
        `2) Объясни по фактам из базы знаний: что реально чувствует клиент, сколько длится, есть ли дискомфорт, какие есть противопоказания и риски. Не преуменьшай.`,
        `3) Скажи, что конкретно вы делаете, чтобы риска было меньше (подготовка, тест, подбор состава) — только если это правда и есть в фактах салона.`,
        `4) Предложи безопасный шаг: консультацию или осмотр перед процедурой, если такая услуга есть в прайсе.`,
        `ЖЁСТКО: если клиент называет беременность, аллергию, заболевание, приём лекарств, травму — НЕ решай сам, вызови escalate_to_human. Никогда не уговаривай при риске для здоровья: отказ от записи здесь — правильный исход.`,
      ].join("\n");

    case "result_doubt":
      return [
        `СОМНЕНИЕ В РЕЗУЛЬТАТЕ («а получится?», «надолго ли?») — отвечай как специалист, а не как продавец:`,
        `1) Назови честный ожидаемый результат и срок из базы знаний — с диапазоном, а не одним «идеальным» числом.`,
        `2) Скажи, от чего результат зависит именно в этом случае (исходные данные, уход дома, регулярность). Это повышает доверие сильнее любого обещания.`,
        `3) Гарантию упоминай ТОЛЬКО если владелец её задал, и никогда дольше, чем держится сам результат.`,
        `4) Если по фото/описанию результат будет хуже ожидаемого — скажи об этом ДО записи и предложи реалистичную альтернативу.`,
        `ЗАПРЕЩЕНО: «100% результат», «гарантируем», «точно понравится».`,
      ].join("\n");

    case "value_doubt":
      return [
        `СОМНЕНИЕ В СМЫСЛЕ («а это окупится?», «стоит ли», «ну не знаю») — человек не спорит с ценой, он не видит, зачем ЕМУ это. Отвечать общими словами тут хуже всего:`,
        `1) Не переубеждай и не хвали услугу. Сначала пойми, о чём именно сомнение: не верит, что поможет ИМЕННО ему; не понимает, что получит на выходе; или боится, что не хватит сил довести до конца.`,
        `2) Задай ОДИН вопрос, который вернёт разговор к его ситуации: что он уже пробовал и что из этого не сработало. Ответ на этот вопрос — половина продажи.`,
        `3) Ответь по его случаю, а не про услугу вообще: что конкретно у него разберут, какой результат реалистичен, за какой срок — только по фактам салона.`,
        `4) Скажи прямо и спокойно, что решение за ним и что бесплатно ждать «правильного момента» не нужно — если сомнение не снято, лучше не записываться сейчас.`,
        `ЗАПРЕЩЕНО: пустые фразы «инвестиция в себя», «вложение в здоровье», «главное — начать», «многие наши клиенты довольны». Это ответ ни о чём: человек их слышал сто раз и они не отвечают на его вопрос.`,
      ].join("\n");

    case "competitor":
      return [
        `СРАВНЕНИЕ С КОНКУРЕНТОМ — работай с ним уважительно, это признак интереса, а не отказ:`,
        `1) Никогда не критикуй другой салон, ${sn.genSg} или их цену. Ни одного плохого слова.`,
        `2) Уточни, что именно сравнивают — часто это разные услуги под одним названием (разный состав, длительность, объём работы, зона).`,
        `3) Объясни, что входит в ВАШУ цену, фактами из прайса и правил салона. Дальше клиент решает сам — так и скажи.`,
        `4) Не занижай цену и не «догоняй» конкурента. Если у вас дороже — это нормально, объясни почему, по существу.`,
        `ЗАПРЕЩЕНО: обещать «сделаем как у них, только дешевле», выдумывать сравнения качества.`,
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Style doctrine
// ---------------------------------------------------------------------------
//
// WHY TWO DOCTRINES AND NOT A "PUSHINESS DIAL"
// --------------------------------------------
// A single intensity knob produces the worst version of both ends: a soft assistant that
// still nags, or an assertive one that nags harder. The two styles differ in WHAT THE
// ASSISTANT IS TRYING TO DO on a turn, and that is a different instruction, not a stronger
// one. Light: answer well and let the client decide when to move. Active: understand the
// person's actual situation and move their state along one step.
//
// Both are bound by exactly the same facts. Nothing below licenses a claim the tools and the
// owner's knowledge base do not support — that is deliberate, and it is why "active" is safe
// to expose as a switch in a self-service admin panel.

const LIGHT_STYLE_DOCTRINE: string[] = [
  `━━━ СТИЛЬ ПРОДАЖ: ЛЁГКИЕ ПРОДАЖИ ━━━`,
  `Ты спокойный, дружелюбный консультант. Твоя задача — чтобы человек получил понятный ответ и почувствовал, что ему помогают, а не продают.`,
  `Как вести себя: сначала пойми вопрос и ситуацию, ответь по существу, мягко покажи, чем услуга полезна ИМЕННО в его случае, и задай уместный вопрос, если он нужен для ответа.`,
  `Запись предлагай тогда, когда это естественно следует из разговора: человек сам заговорил о времени, или его вопрос уже закрыт и следующий логичный шаг — прийти. Не подгоняй, не повторяй предложение записаться, не создавай срочность.`,
  `Решение остаётся за клиентом, и это нормально. Если он не готов — тепло оставь дверь открытой и остановись.`,
];

/**
 * The active doctrine, condensed from the owner's reference on selling by understanding
 * the person rather than praising the product.
 *
 * Every line here is a behaviour the model can actually perform on a single turn. The
 * abstract half of the source material ("клиент должен почувствовать, что его поняли") is
 * expressed as the concrete move that produces the feeling — reflect the client's own words
 * back — because an instruction the model cannot check itself against does nothing.
 */
const ACTIVE_STYLE_DOCTRINE = (sn: { nomSg: string; genSg: string; datSg: string }): string[] => [
  `━━━ СТИЛЬ ПРОДАЖ: АКТИВНЫЕ ПРОДАЖИ ━━━`,
  `Твоя цель — перевести человека из «я просто узнаю» в «я понимаю, зачем мне это, и хочу записаться». Не расхваливай услугу: работай с ситуацией конкретного человека.`,
  `ДИАГНОСТИКА (делай это в каждом сообщении, молча): что человек уже сказал; чего он НЕ договаривает; чего боится; почему тянет с решением; какого результата хочет на самом деле. Отвечай тому, что за вопросом, а не только буквальному вопросу.`,
  `ГОВОРИ ЕГО СЛОВАМИ: используй формулировки, которыми человек описал свою проблему. Услышанным человек чувствует себя тогда, когда узнаёт в ответе собственные слова, а не рекламный текст.`,
  `ПОТРЕБНОСТЬ: свяжи услугу с ОДНОЙ потребностью, которая реально видна в диалоге — внешний вид, здоровье и безопасность, уверенность в себе, мнение окружающих, статус, экономия времени, удобство и контроль. Одна точная, а не список.`,
  `ПОСЛЕДСТВИЯ БЕЗДЕЙСТВИЯ упоминай только когда они фактические и уместные (состояние ухудшится, сезон закончится, запись к ${sn.datSg} расписана вперёд — если это правда). Запугивание и выдуманные последствия ЗАПРЕЩЕНЫ.`,
  `ВОПРОСЫ ПРОДАЮТ ЛУЧШЕ АРГУМЕНТОВ: один вопрос, который помогает человеку самому сформулировать, что ему нужно, сильнее трёх доводов. Вопрос «для скрипта» не задавай.`,
  `ЭМОЦИЯ ПО СИТУАЦИИ: уместны сочувствие, лёгкая ирония, уверенность, облегчение. Эмоция должна соответствовать тому, что человек написал, а не добавляться для «живости».`,
  `ЗАПРЕЩЕНО в этом режиме: давить, спорить, уговаривать, манипулировать, выдумывать дефицит и срочность, повторять призыв записаться в каждом сообщении, говорить шаблонами колл-центра («оставьте заявку», «наши специалисты свяжутся»), выкатывать длинный скрипт. Клиент должен САМ прийти к выводу — ты только помогаешь увидеть проблему, смысл решения и следующий шаг.`,
  `ГРАНИЦА, КОТОРУЮ РЕЖИМ НЕ СДВИГАЕТ: цены, сроки, гарантии, свободное время, результаты и отзывы — только реальные, из инструментов и фактов салона. Активный режим меняет то, КАК ты ведёшь разговор, а не то, что ты имеешь право утверждать.`,
];

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export type SalesBlockInput = {
  playbook: SalesPlaybookConfig;
  /** Objections detected in THIS turn's client message. */
  objections: ObjectionKind[];
  readiness: Readiness;
  state: SalesTurnState;
  /** Industry specialist noun, so the copy stays professionally correct. */
  sn: { nomSg: string; genSg: string; datSg: string };
  /** Salon-local ISO date, for expiring promos. */
  todayIso: string;
  /** Whether an online-booking URL exists at all for this salon. */
  hasBookingLink: boolean;
  /** The client's raw message this turn — owner-defined triggers are matched against it. */
  clientText: string;
  /** Where this conversation is in the funnel. Computed server-side, never by the model. */
  stage: FunnelStage;
  /**
   * The assistant's previous reply. Injected only when the governor says we are at risk of
   * nagging or of re-asking — that is the only situation where paying ~40 tokens to say
   * "don't repeat yourself" earns its keep.
   */
  lastAssistantReply?: string | null;
};

/**
 * The whole sales section of the system prompt. Returns "" when there is genuinely
 * nothing to say — an empty string is filtered out by the prompt builder, so a salon
 * with no playbook and a client with no objection pays zero tokens for any of this.
 */
export function renderSalesBlock(input: SalesBlockInput): string {
  const { playbook, objections, readiness, state, sn, todayIso, hasBookingLink, stage } = input;
  const parts: string[] = [];

  // ── Where we are, and the one move that belongs here. First in the block so everything
  // below is read as detail on a decision that is already made.
  const active = playbook.style === "active";
  parts.push(renderStageBlock(stage, sn, { style: playbook.style }));
  parts.push(``);

  // ── Doctrine. Short on purpose: the long-form guidance lives in the plays, and
  // only the play that fired gets injected.
  //
  // The two styles share the first paragraph — "trust beats one booking" is not a mode,
  // it is the product. They diverge on what the assistant DOES with the turn: light
  // answers and waits, active diagnoses and moves the client's state along.
  parts.push(
    `━━━ КАК ТЫ ВЕДЁШЬ ДИАЛОГ (логика сильного администратора) ━━━`,
    `Твоя работа — не «отвечать на вопросы» и не «продавать», а довести человека до решения, которое ему подходит. Последовательность: понять запрос и настоящую потребность → ответить по сути → снять сомнение или возражение → дать почувствовать, что здесь надёжно → предложить конкретный следующий шаг. Если услуга человеку не подходит — честно сказать это, даже ценой записи. Доверие дороже одной записи.`,
    `ПОТРЕБНОСТЬ ПЕРЕД ПРЕДЛОЖЕНИЕМ: прежде чем что-то советовать, пойми ЗАЧЕМ клиенту это (событие, проблема, повторяет прошлое, хочет изменений). Один точный вопрос лучше трёх общих. Не устраивай допрос — если ответ уже виден из сообщения или фото, не спрашивай.`,
    // Prod 2026-08-12: «Многие наши клиенты отмечают значительные улучшения» — invented social
    // proof, in a clinic, from a model that had no such fact anywhere. The generic "не выдумывай
    // факты" rule does not catch it, because it does not read as a factual claim to the model.
    // Naming the exact phrasings is what makes it catchable.
    `НИКАКИХ ВЫДУМАННЫХ ОТЗЫВОВ И СТАТИСТИКИ: фразы «многие наши клиенты», «клиенты отмечают», «все довольны», «у нас высокий процент результата», «люди возвращаются» — ЗАПРЕЩЕНЫ, если этого дословно нет в фактах салона. У тебя нет данных об отзывах и результатах других клиентов. Ссылаться можно только на то, что написал владелец.`,
    `НИКАКОЙ ВОДЫ: «инвестиция в себя», «вложение в здоровье», «главное — сделать первый шаг», «индивидуальный подход», «качественный сервис» — пустые фразы, которые ничего не отвечают. Вместо них — конкретика по случаю этого человека или честное «не знаю».`,
  );

  parts.push(``, ...(active ? ACTIVE_STYLE_DOCTRINE(sn) : LIGHT_STYLE_DOCTRINE));

  // ── The play(s) for what actually fired this turn.
  const fresh = objections.filter((k) => !state.handled.includes(k));
  const toPlay = (fresh.length ? fresh : objections).slice(0, 2);
  if (toPlay.length) {
    parts.push(``, `━━━ СЕЙЧАС У КЛИЕНТА ВОЗРАЖЕНИЕ — ОТРАБОТАЙ ЕГО ДО ЛЮБЫХ ПРЕДЛОЖЕНИЙ ━━━`);
    // The plays themselves are style-neutral (they are about the objection, not the mood).
    // What differs is where the turn LANDS: active returns to value and names one next step,
    // light answers honestly and hands the decision back.
    parts.push(
      active
        ? `ПОРЯДОК РАБОТЫ С ЛЮБЫМ ВОЗРАЖЕНИЕМ: 1) признай сомнение, не спорь с формулировкой; 2) пойми НАСТОЯЩУЮ причину (за «дорого» может стоять «не понял, за что плачу», «сравнил с дешевле», «сейчас нет денег» — это три разных разговора); 3) ответь именно на эту причину, фактами; 4) верни разговор к тому, что человек получит в СВОЕЙ ситуации; 5) предложи ОДИН логичный следующий шаг. Не спорить и не уговаривать — понять и показать смысл.`
        : `ПОРЯДОК РАБОТЫ С ЛЮБЫМ ВОЗРАЖЕНИЕМ: 1) признай сомнение; 2) уточни, что за ним стоит, если это неясно; 3) ответь честно и по фактам; 4) оставь решение за клиентом. Не переубеждай и не возвращайся к предложению записаться в этом же сообщении, если человек сам не сказал, что вопрос снят.`,
    );
    for (const k of toPlay) parts.push(playFor(k, sn));
    if (fresh.length === 0) {
      parts.push(
        `ВНИМАНИЕ: это возражение в диалоге УЖЕ звучало и ты на него отвечал. НЕ повторяй тот же ответ другими словами — это раздражает. Либо дай НОВЫЙ аргумент по существу, либо честно признай, что решение за клиентом, и не дави.`,
      );
    }
  }

  // ── Owner's own objection answers. Injected verbatim and marked as outranking the
  // generic play: the owner knows their clients better than any framework.
  const ownerMatches = matchOwnerObjections(playbook.objections, input);
  if (ownerMatches.length) {
    parts.push(
      ``,
      `━━━ ОТВЕТЫ ВЛАДЕЛЬЦА НА ЭТО ВОЗРАЖЕНИЕ (СИЛЬНЕЕ ОБЩЕЙ СХЕМЫ ВЫШЕ) ━━━`,
      ...ownerMatches.map((o) => `Клиент говорит «${o.trigger}» → отвечай так: ${o.answer}`),
      `Используй смысл этих ответов своими живыми словами, не зачитывай как скрипт. Если ответ владельца противоречит общей схеме — прав владелец.`,
    );
  }

  // ── USP: only rendered when trust is actually the topic. A permanent "мы лучшие"
  // block would leak self-praise into ordinary price questions.
  const trustTopic = objections.some((k) => k === "why_you" || k === "competitor" || k === "price");
  if (playbook.usp.length && (trustTopic || active)) {
    parts.push(
      ``,
      `━━━ ЧЕМ ЭТОТ БИЗНЕС РЕАЛЬНО СИЛЁН (слова владельца — только это можно приписывать себе) ━━━`,
      ...playbook.usp.map((u) => `— ${u}`),
      `Называй одно-два подходящих к вопросу, естественно и без пафоса. Ничего сверх этого списка себе не приписывай.`,
    );
  }

  // ── Promos.
  const promos = activePromos(playbook.promos, todayIso);
  if (promos.length) {
    parts.push(
      ``,
      `━━━ ДЕЙСТВУЮЩИЕ АКЦИИ (единственные, которые существуют) ━━━`,
      ...promos.map(
        (p) =>
          `— ${p.title}${p.details ? `: ${p.details}` : ""}${p.until ? ` (действует до ${p.until})` : ""}`,
      ),
      `Упомяни акцию САМ, если она относится к обсуждаемой услуге, — до подтверждения записи, не дожидаясь вопроса. Любую другую скидку или подарок придумывать ЗАПРЕЩЕНО.`,
    );
  }

  // ── Prepayment framing. Active only, and deliberately conditional in its wording: the
  // renderer does not know whether this salon takes prepayments (the tool layer decides that
  // at booking time), so the instruction is about HOW to talk about one that exists, never a
  // licence to introduce one. An assistant inventing a prepayment would be a billing incident.
  if (active) {
    parts.push(
      ``,
      `━━━ ПРЕДОПЛАТА (если она есть в этом салоне) ━━━`,
      `Не выдумывай предоплату. Говори о ней, только если инструмент записи её потребовал или клиент спросил сам. Если она есть — не прячь её и не подавай как барьер: это фиксация времени за клиентом. Объясни коротко и прозрачно: сколько, что это подтверждает запись, и вычитается ли сумма из стоимости — но только если это указано в фактах салона.`,
      `Возврат обещай ТОЛЬКО если условие возврата прямо задано владельцем. Реквизиты отправляй после согласия клиента, а не вместе с первым же упоминанием цены. Давить на оплату запрещено.`,
    );
  }

  // ── The governor. This is the part that no prompt can do on its own.
  //
  // Readiness is checked FIRST, and that ordering is not cosmetic. A client who has
  // deflected twice and then writes «хорошо, записывайте» is the most valuable message in
  // the whole conversation — running the stop rule ahead of it would make the assistant
  // refuse to book someone who just asked to be booked. The anti-nag rule exists to stop
  // UNWANTED pushes; a requested one is never unwanted.
  if (readiness === "ready") {
    parts.push(
      ``,
      `КЛИЕНТ ГОТОВ: он прямо говорит о записи. Не консультируй заново и не пересказывай то, что уже сказал — веди к выбору дня, времени и ${sn.genSg} максимально коротко.`,
    );
  } else if (state.closeAttempts >= CLOSE_ATTEMPT_LIMIT) {
    parts.push(
      ``,
      `━━━ СТОП-ПРАВИЛО НАВЯЗЧИВОСТИ (АБСОЛЮТНОЕ, ВАЖНЕЕ ЛЮБЫХ ПРАВИЛ ПРОДАЖ) ━━━`,
      `Ты уже ${state.closeAttempts} раза подряд предлагал записаться, и клиент не сделал шаг вперёд. В ЭТОМ сообщении предлагать запись, подбирать время и спрашивать «на какой день» ЗАПРЕЩЕНО. Просто ответь по сути на то, что человек спросил, и остановись. Инициативу дальше проявляет клиент. Нарушение этого правила — худшая ошибка администратора: так теряют клиента насовсем.`,
    );
  } else if (objections.length) {
    parts.push(
      ``,
      `ПОРЯДОК В ЭТОМ ХОДЕ: сначала полностью закрой возражение. Предлагать запись в этом же сообщении можно ТОЛЬКО если клиент сам сказал, что вопрос снят.`,
    );
  } else if (state.closeAttempts === 1) {
    // One unanswered close is not yet nagging, but a second identical one is how it starts.
    // The hard stop at CLOSE_ATTEMPT_LIMIT was the only brake, which meant the assistant was
    // free to repeat «подберём время?» twice before anything intervened. This is the warning
    // shot: answer the question, don't re-ask.
    parts.push(
      ``,
      `ТЫ УЖЕ ЗВАЛ ЗАПИСАТЬСЯ в прошлом сообщении, и клиент не сделал шаг. Не повторяй призыв в этом сообщении — ни теми же словами, ни другими. Ответь ровно на то, что человек спросил, и остановись. Он сам скажет, когда будет готов.`,
    );
  }

  // ── Booking-link policy. The tool has a hard server-side gate; this tells the model
  // when it is even worth trying, so it doesn't burn a tool call to be refused.
  if (hasBookingLink && playbook.bookingLinkMode !== "off") {
    parts.push(
      ``,
      `ССЫЛКА НА ОНЛАЙН-ЗАПИСЬ (инструмент send_booking_link): у салона есть страница самостоятельной записи. Отправляй её НЕ всем подряд, а только в четырёх случаях: (1) клиент сам попросил ссылку или сайт; (2) он уже несколько раз перебирает время и явно хочет посмотреть расписание сам; (3) календарь не отвечает и ты не можешь показать окошки; (4) клиент прямо говорит, что запишется позже сам.${playbook.bookingLinkMode === "eager" ? " Владелец разрешил предлагать ссылку активнее: можно один раз предложить её как удобную альтернативу, когда услуга уже выбрана." : ""}`,
      `Отправив ссылку, НЕ бросай клиента: скажи, что здесь, в чате, тоже запишешь в любой момент. Второй раз ссылку в этом диалоге не отправляй, если клиент не попросит снова.`,
    );
  }

  // ── Anti-repetition. The previous reply IS already in the conversation history, but history
  // is context, not instruction — the model happily rephrases its own last message when it has
  // nothing new to add. Naming the text and forbidding it explicitly is what changes the
  // behaviour. Gated on the two states where repetition actually shows up (a stalled close, or
  // an unresolved objection) so the ordinary path pays nothing for it.
  const repetitionRisk = state.closeAttempts > 0 || objections.length > 0;
  const prev = (input.lastAssistantReply ?? "").trim();
  if (repetitionRisk && prev) {
    parts.push(
      ``,
      `━━━ НЕ ПОВТОРЯЙСЯ ━━━`,
      `Твоё предыдущее сообщение было: «${prev.slice(0, 320)}»`,
      `Не пересказывай его другими словами и не задавай тот же вопрос второй раз. Если добавить по существу нечего — ответь коротко на заданный вопрос и остановись.`,
    );
  }

  return parts.join("\n");
}

/**
 * Owner-defined objection entries relevant to this turn.
 *
 * Two ways to match, because owners write triggers both ways: as the client's literal
 * phrase («дорого») — matched by substring against the message — and as a category
 * name that lines up with a detected kind.
 */
function matchOwnerObjections(
  entries: SalesObjectionEntry[],
  input: Pick<SalesBlockInput, "objections" | "clientText">,
): SalesObjectionEntry[] {
  const text = (input.clientText ?? "").toLowerCase();
  const kinds = new Set(input.objections);
  const out: SalesObjectionEntry[] = [];
  for (const e of entries) {
    const trig = e.trigger.toLowerCase().trim();
    if (!trig) continue;
    const bySubstring = text.length > 0 && text.includes(trig);
    const byKind = detectObjections(e.trigger).some((k) => kinds.has(k));
    if (bySubstring || byKind) out.push(e);
    if (out.length >= 3) break;
  }
  return out;
}
