// Per-language style guides for the virtual administrator.
//
// WHY THIS IS A SEPARATE, CONDITIONAL MODULE
// ------------------------------------------
// Only one of these blocks can ever apply to a given reply, so appending all of them to a
// ~12k-token system prompt would pay for three guides to get one. The prompt builder pulls
// exactly the one that matches the resolved language, and Russian — the overwhelming
// majority of traffic and the language the base prompt is already written in — pays nothing
// at all.
//
// WHY THE KYRGYZ GUIDE EXISTS
// ---------------------------
// Left to itself, an LLM writing Kyrgyz produces literary/administrative register: full
// case agreement, no borrowings, sentences built like a textbook. Bishkek does not talk that
// way. People write a relaxed mix — Kyrgyz grammar with Russian nouns for anything modern
// (запись, мастер, свободно, цена) — and a message in pure literary Kyrgyz reads as either a
// government letter or a machine translation. Both cost trust.
//
// The failure mode on the other side is just as real, so the guide is explicit about it: the
// target is an educated Bishkek professional writing quickly and politely, NOT a caricature
// of broken speech and NOT a 50/50 salad. Illiteracy is not authenticity.
//
// WHY IT WAS REWRITTEN (23.09.2026)
// ---------------------------------
// The first version (12.08) did not change what clients got. Production replies written after
// it shipped still translated the salon's own price list («Наращивание ресниц» → «кирпик
// өстүрүү», «мокрый эффект» → «нымдуу эффект»), called the master «чебер», opened with calques
// like «Кечиресиз, бирок…» and «Сизге кантип жардам бере алам?», and answered a client who wrote
// «неделя» with «жума». The cause was one level up: the base prompt's language rule demanded
// «ни одного слова на другом языке», which is louder than any style note, so the model
// resolved the conflict by translating everything. The base prompt now defines mixing for
// Kyrgyz precisely (whole Russian sentences — no; single everyday Russian words — yes), and this
// guide carries the lexicon, the rule to mirror the client, and ready phrasing for the moves an
// administrator makes every day.

export type StyleLanguage = "ru" | "ky" | "en";

/**
 * How the client writes Kyrgyz. `pure` — almost without Russian words, `mixed` — they drop
 * Russian words in themselves. `null` means too little text to tell; the guide's own default
 * (Kyrgyz base with the usual salon borrowings) applies.
 */
export type KyRegister = "pure" | "mixed";

export type StyleOptions = {
  register?: KyRegister | null;
  /** Russian words the client used, quoted back to the model so it mirrors them. */
  clientRussianWords?: string[];
  /** The industry's specialist noun («мастер» / «врач»): it picks the everyday vocabulary. */
  specialist?: string;
};

type KyLexicon = {
  /** Russian words that are simply how people talk about this business in Bishkek. */
  borrowed: string;
  /** Russian words with Kyrgyz endings attached by sound. */
  suffixed: string;
  specialist: string;
  /** The literary Kyrgyz word the model reaches for instead of the specialist noun. */
  literary: string;
  greeting: string;
  price: string;
  priceRange: string;
  chooseSpecialist: string;
  photo: string | null;
  badBookish: string;
  goodBookish: string;
  badSalad: string;
  goodSalad: string;
  badBroken: string;
  goodBroken: string;
};

const SALON: KyLexicon = {
  borrowed:
    "услуга, запись, мастер, свободно, удобно, фото, цена, результат, перенести, предоплата, скидка, акция",
  suffixed: "маникюрга, мастерге, фотого, субботага, 15:00дө",
  specialist: "мастер",
  literary: "чебер» или «уста",
  greeting: "Саламатсызбы! 🙂 Кайсы услуга керек эле?",
  price: "Маникюр 800 сом болот.",
  priceRange: "Цена 3000ден 5000ге чейин, фотого карап так айтып берем.",
  chooseSpecialist: "Бул услуганы <имя> менен <имя> жасайт. Кимге жазайын?",
  photo: "Фото жиберип коёсузбу? Баасын так айтып берем 🙂",
  badBookish:
    "Кечиресиз, бирок биз кирпик өстүрүү кызматын гана көрсөтөбүз. Сизге кантип жардам бере алам?",
  goodBookish:
    "Бизде наращивание ресниц гана бар 🙂 Цена 500 сомдон башталат. Кайсы күнгө жазайын?",
  badSalad: "Завтра на 15:00 есть свободное время, сизге удобно болсо запишу вас.",
  goodSalad: "Эртеңге 15:00 свободно экен. Жазып коёюнбу?",
  badBroken: "салам канча керек эмне кыласыз записка",
  goodBroken: "Салам! Маникюр 800 сом. Эртеңге жазайынбы?",
};

const CLINIC: KyLexicon = {
  borrowed:
    "запись, прием, врач, консультация, анализ, свободно, удобно, цена, результат, перенести, предоплата, скидка",
  suffixed: "консультацияга, врачка, анализге, субботага, 10:00дө",
  specialist: "врач",
  literary: "дарыгер",
  greeting: "Саламатсызбы! 🙂 Кайсы врачка жазылгыңыз келет?",
  price: "Консультация 1500 сом болот.",
  priceRange: "Так баасын врач приемде айтат.",
  chooseSpecialist: "<имя> менен <имя> кабыл алат. Кимге жазайын?",
  photo: null,
  badBookish:
    "Урматтуу кардар, сиздин кайрылууңуз кабыл алынды. Кеңеш берүү кызматына каттоо жүргүзүлсүнбү?",
  goodBookish: "Салам! Ооба, консультацияга жазсак болот. Кайсы күн сизге удобно?",
  badSalad: "Завтра на 10:00 есть свободное время, сизге удобно болсо запишу вас.",
  goodSalad: "Эртеңге 10:00 свободно экен. Жазып коёюнбу?",
  badBroken: "салам кандай жагдай бар канчага келесиз",
  goodBroken: "Салам! Консультация 40 мүнөт болот. Эртең саат 10:00 удобно болобу?",
};

function kyLexicon(specialist: string | undefined): KyLexicon {
  return /врач/i.test(specialist ?? "") ? CLINIC : SALON;
}

function kyStyle(opts: StyleOptions): string {
  const lx = kyLexicon(opts.specialist);
  const Sp = lx.specialist[0].toUpperCase() + lx.specialist.slice(1);
  const lines = [
    `━━━ КАК ЗВУЧИТ ЖИВОЙ КЫРГЫЗСКИЙ (СТИЛЬ, НЕ СОДЕРЖАНИЕ) ━━━`,
    `Ты — опытный администратор из Бишкека и отвечаешь клиенту в мессенджере. Бишкек так и переписывается: кыргызская речь с отдельными русскими словами. Не пиши как учебник, официальное письмо или Google Translate.`,
    `1) ОСНОВА — КЫРГЫЗСКАЯ: грамматика, связки, вопросы и вежливые формы по-кыргызски («экен», «болот», «болобу?», «кайсы», «канча», «жазып коёюн», «күтөбүз»). Базовые слова тоже кыргызские: бүгүн, эртең, саат, күн, жакшы, ооба, жок, рахмат.`,
    `2) РУССКИЕ СЛОВА — ЭТО НОРМАЛЬНО там, где в Бишкеке их реально говорят: ${lx.borrowed}. Кыргызские окончания цепляй к ним по звучанию: ${lx.suffixed}. Эталон: «Эртеңге 15:00 жана 17:30 свободно экен. Кайсысы сизге удобнее?»`,
    `3) НО НЕ 50/50: по-русски только отдельные слова, которые и в жизни звучат по-русски, — обычно одно-три на сообщение. Не заменяй русским каждое второе слово, не вставляй целые русские предложения, не пиши абзац по-русски и абзац по-кыргызски.`,
    `4) ПРАЙС И ИМЕНА НЕ ПЕРЕВОДИ: услуги, эффекты и имена пиши ровно как в прайсе («Наращивание ресниц к топ-мастерам», «мокрый эффект», «лучики»), а НЕ «кирпик өстүрүү», «нымдуу эффект», «нурлар». ${Sp} — это «${lx.specialist}», а не «${lx.literary}».`,
    `5) ПОДСТРАИВАЙСЯ ПОД КЛИЕНТА: пишет почти чисто по-кыргызски — отвечай по-кыргызски, русских вставок меньше («бош», «ыңгайлуу» вместо «свободно», «удобно»). Сам мешает с русским — мешай так же. Его русские слова обратно не переводи (базовые из п. 1 — бүгүн, эртең, саат — остаются кыргызскими): написал «неделя» — не отвечай «жума», написал «суббота» — так и пиши «суббота».`,
    `6) КОРОТКО И ПО-РАЗГОВОРНОМУ: одна мысль — одно короткое предложение. Без книжных причастий («көрсөтүлүүчү», «жасалуучу») и канцелярита. Живые связки: «Макул», «Болот», «Жакшы», «Түшүндүм», «Рахмат». «Экен» — когда сообщаешь то, что только что увидел в календаре или прайсе, а не в каждой фразе.`,
    `7) КАЛЬКИ, КОТОРЫЕ ВЫДАЮТ РОБОТА (не пиши): «Кечиресиз, бирок…», «Сизге кантип жардам бере алам?», «толук маалымат берейин», «кайрылыңыз», «жардам берүүгө даярмын», «ийгиликтүү жаздым», «Кандай маселе менен кайрылдыңыз?», «шилтеме» (говори «ссылка»). «Кечиресиз» — только когда правда извиняешься.`,
    `8) ГРАМОТНО, БЕЗ КАРИКАТУРЫ: разговорность — это выбор слов и коротких фраз, а НЕ ошибки. Пиши ө, ү, ң правильно, не коверкай слова специально и не повторяй за клиентом опечатки и словечки вроде «блин».`,
    `9) ВЕЖЛИВОЕ «СИЗ» ВСЕГДА: сиз, -ңыз/-ңиз/-ыңыз/-иңиз. «Сен» недопустимо, даже если клиент пишет на «сен».`,
    `10) БЕЗ «СЕЙЧАС ПОСМОТРЮ»: «Азыр карап көрөйүн», «азыр текшерип көрөйүн», «бир аз күтө туруңуз», «бир минут» — нельзя. Сначала молча инструменты, потом готовый ответ.`,
    `11) Клиент пишет по-казахски (қ, ұ, і, «иә», «жоқ», «қалай») — отвечай по-казахски в том же живом стиле: этот блок про кыргызский.`,
    `ГОТОВЫЕ ОБОРОТЫ (форма отсюда, смысл — из ситуации; имена, цены и время бери только из инструментов):`,
    `— приветствие: «${lx.greeting}»`,
    `— цена: «${lx.price}» / «${lx.priceRange}»`,
    `— день: «Кайсы күнгө жазайын?»`,
    `— свободное время: «Эртеңге 11:00 жана 16:30 свободно. Кайсысы сизге удобно?»`,
    `— занято: «15:00 занят экен, бирок 16:30 свободно. Болобу?»`,
    `— ${lx.specialist}: «${lx.chooseSpecialist}»`,
    `— имя: «Атыңыз ким?»`,
    `— записал: «Даяр, жазып койдум ✅ Эртең 15:00дө күтөбүз!»`,
    ...(lx.photo ? [`— фото: «${lx.photo}»`] : []),
    `— перенос: «Макул, перенести кылып берем. Кайсы күн удобно?»`,
    `— передать человеку: «Администраторго өткөрүп берем, ал жакында жазат 🙏»`,
    `ПРИМЕРЫ ТОНА (смысл повторять не нужно — важен именно стиль):`,
    `— Плохо (книжно, как перевод): «${lx.badBookish}»`,
    `— Хорошо: «${lx.goodBookish}»`,
    `— Плохо (50/50, мешанина): «${lx.badSalad}»`,
    `— Хорошо: «${lx.goodSalad}»`,
    `— Плохо (каша, безграмотно): «${lx.badBroken}»`,
    `— Хорошо: «${lx.goodBroken}»`,
  ];
  const mirror = registerLine(opts, lx);
  return (mirror ? [...lines, mirror] : lines).join("\n");
}

function registerLine(opts: StyleOptions, lx: KyLexicon): string {
  if (opts.register === "pure") {
    return `КАК ПИШЕТ ЭТОТ КЛИЕНТ: почти чисто по-кыргызски. Отвечай так же, русских вставок минимум: названия из прайса и «${lx.specialist}» остаются, а вместо «свободно / удобно / запись» — «бош / ыңгайлуу / жазылуу».`;
  }
  if (opts.register === "mixed") {
    const words = (opts.clientRussianWords ?? []).filter(Boolean).slice(0, 5);
    const quoted = words.length ? ` (${words.map((w) => `«${w}»`).join(", ")})` : "";
    return `КАК ПИШЕТ ЭТОТ КЛИЕНТ: сам вставляет русские слова${quoted}. Пиши в том же ключе: кыргызская основа, а бытовые русские слова — свободно, как у него. Его слова обратно на кыргызский не переводи.`;
  }
  return "";
}

const EN_STYLE = [
  `━━━ ENGLISH STYLE ━━━`,
  `Write like a friendly professional receptionist texting: short sentences, contractions, no corporate filler. One idea per message. Keep the polite register without sounding formal.`,
].join("\n");

/**
 * The style guide for a language, or "" when there is nothing to add.
 *
 * Returning "" for Russian is deliberate rather than an omission: the entire base prompt is
 * already written in Russian and models are strongest there, so a guide would be tokens
 * spent restating what the surrounding text already demonstrates.
 */
export function languageStyleBlock(language: StyleLanguage, opts: StyleOptions = {}): string {
  if (language === "ky") return kyStyle(opts);
  if (language === "en") return EN_STYLE;
  return "";
}

/**
 * One line the prompt builder places near the END of a Kyrgyz prompt, just above the owner's
 * rules. The guide sits near the top, and ~10k tokens of Russian instructions and Russian
 * examples follow it; recency decides what the model does, so the self-check has to be close to
 * the point of generation. "" for every other language.
 */
export function languageFinalCheck(language: StyleLanguage, specialist?: string): string {
  if (language !== "ky") return "";
  const lx = kyLexicon(specialist);
  return `ПЕРЕД ОТПРАВКОЙ — ПРОВЕРЬ КЫРГЫЗСКИЙ: звучит как администратор из Бишкека в мессенджере, а не как перевод; кыргызская основа и только отдельные бытовые русские слова, без целых русских фраз; названия из прайса — дословно, не переведены; «${lx.specialist}», а не «${lx.literary}»; нет «Кечиресиз, бирок…», «Сизге кантип жардам бере алам?», «толук маалымат», «кайрылыңыз», «ийгиликтүү»; коротко; на «сиз».`;
}

// ─── How the client writes ───────────────────────────────────────────────────────────────
//
// "Mirror the client" is only an instruction if the model knows what to mirror. Counting is
// cheap and deterministic; asking the model to judge the client's register while it is also
// booking a slot is neither. The result is a hint in the prompt, never a hard gate: a wrong call
// costs a reply with a few more or a few fewer Russian words.

// Letters native Kyrgyz words never contain: a word with one of them came from Russian.
const RU_LETTERS = /[вфцщъь]/;
// Letters Russian never contains.
const KY_LETTERS = /[өүң]/;
// Borrowings that everyone uses, including clients who otherwise write pure Kyrgyz: service
// names, «мастер», «фото», «сом». They say nothing about whether the client mixes languages.
const NEUTRAL_PREFIXES = [
  "маникюр",
  "педикюр",
  "кератин",
  "ботокс",
  "шугаринг",
  "массаж",
  "пилинг",
  "ламин",
  "наращ",
  "ресниц",
  "бров",
  "стрижк",
  "окраш",
  "мелир",
  "эпиляц",
  "депиляц",
  "лазер",
  "чистк",
  "укладк",
  "прическ",
  "причёск",
  "дизайн",
  "гель",
  "мастер",
  "фото",
  "салон",
  "сом",
  "курс",
  "акци",
  "консультац",
  "процедур",
  "врач",
  "прием",
  "приём",
  "анализ",
  "стоматолог",
];
// Russian function words and chat words. Deliberately missing: «а», «да», «же», «о», «он»,
// «так», «тут», «там», «ко» — each is also an everyday Kyrgyz word or particle.
const RU_WORDS = new Set([
  "и",
  "в",
  "во",
  "с",
  "со",
  "к",
  "у",
  "я",
  "на",
  "по",
  "за",
  "до",
  "от",
  "из",
  "для",
  "про",
  "при",
  "без",
  "но",
  "или",
  "то",
  "что",
  "чтобы",
  "как",
  "где",
  "это",
  "этот",
  "эта",
  "эти",
  "тоже",
  "уже",
  "еще",
  "ещё",
  "есть",
  "нет",
  "если",
  "вот",
  "все",
  "всё",
  "вы",
  "вас",
  "вам",
  "мне",
  "меня",
  "мы",
  "нас",
  "она",
  "они",
  "его",
  "ну",
  "час",
  "часа",
  "часов",
  "часам",
  "будет",
  "буду",
  "может",
  "какой",
  "какая",
  "какое",
  "какие",
  "какую",
  "день",
  "добрый",
  "доброе",
]);
// Russian stems, matched as prefixes so Kyrgyz endings on them still count: «субботага»,
// «записька», «оплатасын», «свободнобу».
const RU_PREFIXES = [
  "запис",
  "услуг",
  "цен",
  "стоим",
  "свобод",
  "удобн",
  "заня",
  "результат",
  "перенес",
  "перенос",
  "отмен",
  "недел",
  "суббот",
  "воскрес",
  "понедел",
  "вторник",
  "сред",
  "четверг",
  "пятниц",
  "окош",
  "окн",
  "минут",
  "оплат",
  "предоплат",
  "скидк",
  "сертификат",
  "завтр",
  "сегодн",
  "послезавтр",
  "вечер",
  "утр",
  "обед",
  "сдела",
  "подойд",
  "получ",
  "хоч",
  "хоте",
  "можн",
  "нужн",
  "надо",
  "сколько",
  "когда",
  "пожалуй",
  "спасиб",
  "хорош",
  "ладн",
  "давай",
  "здравств",
  "здрасьт",
  "здрасте",
  "привет",
  "прям",
  "прост",
  "сраз",
  "тольк",
  "сейчас",
  "потом",
  "конечн",
  "примерн",
];
// Russian inflections Kyrgyz words do not end in.
const RU_ENDING =
  /(?:ться|тся|ешь|ишь|ого|его|ому|ему|ый|ий|ая|яя|ые|ие|ую|ать|ять|ить|еть|ете|ите)$/;

function isRussianToken(word: string): boolean {
  if (!/[а-яё]/.test(word)) return false; // Latin, digits: neutral
  if (KY_LETTERS.test(word)) return false;
  if (NEUTRAL_PREFIXES.some((p) => word.startsWith(p))) return false;
  if (RU_WORDS.has(word)) return true;
  if (RU_PREFIXES.some((p) => word.startsWith(p))) return true;
  if (RU_LETTERS.test(word)) return true;
  return word.length >= 4 && RU_ENDING.test(word);
}

/**
 * Does the client write almost pure Kyrgyz, or do they drop Russian words in themselves?
 *
 * `texts` are the client's own recent messages, oldest first. Only a handful are needed: the
 * register a person writes in right now is what the reply should match, and a Russian opener
 * followed by Kyrgyz stops counting once it scrolls out of the window.
 */
export function kyrgyzRegister(texts: string[]): {
  register: KyRegister | null;
  russianWords: string[];
} {
  const tokens = texts
    .join(" ")
    .toLowerCase()
    .match(/\p{L}+/gu)
    ?.filter((w) => w.length >= 2 || RU_WORDS.has(w));
  if (!tokens || tokens.length < 3) return { register: null, russianWords: [] };
  const russian = tokens.filter(isRussianToken);
  const russianWords = [...new Set(russian.filter((w) => w.length >= 3))].slice(0, 5);
  if (russian.length === 0) return { register: "pure", russianWords };
  if (russian.length >= 2 || russian.length / tokens.length >= 0.15) {
    return { register: "mixed", russianWords };
  }
  return { register: null, russianWords };
}

// ─── Reply guards: the Kyrgyz arms ───────────────────────────────────────────────────────
//
// The V4 reply guards were written against Russian output and carry only a token Kyrgyz arm.
// A natural Kyrgyz reply now uses Russian words («свободно жок», «15:00 занят экен»), which
// neither arm recognised, so the same fabricated claim that is caught in Russian slipped
// through in Kyrgyz. These are the missing arms, kept here so they can be tested on their own.

/** Stalls («one moment, let me check») the Russian STALL_RE does not know. */
export const KY_STALL_RE =
  /(?<!\p{L})(?:бир\s+(?:минут|секунд)|күтүп\s+тур|азыр\s+(?:провер|уточн))/iu;

/** «Could not open the schedule», Kyrgyz or mixed: the same apology the Russian arm catches. */
export const KY_APOLOGY_LOOP_RE =
  /(?:расписани|график|маалымат|данн|информаци)\p{L}*\s+(?:\p{L}+\s+){0,2}(?:ача|көрө|ала|тактай|таба|текшере)\s+(?:алба|алган\s+жок)/iu;

/** «No free time» claimed in Kyrgyz or mixed Kyrgyz. */
export const KY_FAKE_BUSY_RE =
  /(?:(?<!\p{L})(?:свободн\p{L}*|бош|окош\p{L}*|убакыт\p{L}*|убактысы|врем\p{L}*|мест\p{L}*|орун|орду)(?:\s+\p{L}+){0,2}\s+жок(?!\p{L})|(?<!\p{L})бош\s+эмес|(?<!\p{L})занят\p{L}*\s+экен)/iu;

/** An offer of times in Kyrgyz («15:00 бош», «жазып коёюнбу?», «кайсысы сизге удобно?»). */
export const KY_OFFER_RE =
  /(?<!\p{L})(?:бош(?!\p{L})|жазып\s+ко[йёе]|жазайын|кайсы(?:сы|нысы)?\s+(?:сизге\s+)?(?:удобн|ыңгайлуу))/iu;

/** Header of the Kyrgyz booking summary — the template lives in the V4 prompt. */
export const KY_SUMMARY_RE = /текшерип\s+коюңуз(?:чу)?\s*:/iu;
