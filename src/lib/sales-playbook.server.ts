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

export type SalesPlaybookConfig = {
  usp: string[];
  objections: SalesObjectionEntry[];
  promos: SalesPromo[];
  bookingLinkMode: "off" | "auto" | "eager";
  /** salon_ai_assistant.sales_mode — the owner asked for a more assertive assistant. */
  salesMode: boolean;
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
    salesMode: raw.sales_mode === true,
  };
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
};

/**
 * The whole sales section of the system prompt. Returns "" when there is genuinely
 * nothing to say — an empty string is filtered out by the prompt builder, so a salon
 * with no playbook and a client with no objection pays zero tokens for any of this.
 */
export function renderSalesBlock(input: SalesBlockInput): string {
  const { playbook, objections, readiness, state, sn, todayIso, hasBookingLink } = input;
  const parts: string[] = [];

  // ── Doctrine. Short on purpose: the long-form guidance lives in the plays, and
  // only the play that fired gets injected.
  parts.push(
    `━━━ КАК ТЫ ВЕДЁШЬ ДИАЛОГ (логика сильного администратора) ━━━`,
    `Твоя работа — не «отвечать на вопросы» и не «продавать», а довести человека до решения, которое ему подходит. Последовательность: понять запрос и настоящую потребность → ответить по сути → снять сомнение или возражение → дать почувствовать, что здесь надёжно → предложить конкретный следующий шаг. Если услуга человеку не подходит — честно сказать это, даже ценой записи. Доверие дороже одной записи.`,
    `ПОТРЕБНОСТЬ ПЕРЕД ПРЕДЛОЖЕНИЕМ: прежде чем что-то советовать, пойми ЗАЧЕМ клиенту это (событие, проблема, повторяет прошлое, хочет изменений). Один точный вопрос лучше трёх общих. Не устраивай допрос — если ответ уже виден из сообщения или фото, не спрашивай.`,
  );

  // ── The play(s) for what actually fired this turn.
  const fresh = objections.filter((k) => !state.handled.includes(k));
  const toPlay = (fresh.length ? fresh : objections).slice(0, 2);
  if (toPlay.length) {
    parts.push(``, `━━━ СЕЙЧАС У КЛИЕНТА ВОЗРАЖЕНИЕ — ОТРАБОТАЙ ЕГО ДО ЛЮБЫХ ПРЕДЛОЖЕНИЙ ━━━`);
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
  if (playbook.usp.length && (trustTopic || playbook.salesMode)) {
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
