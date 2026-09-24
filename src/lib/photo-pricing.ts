// A photograph may classify salon-defined attributes; it must never invent a price.
// Keep this module pure so the same validation/pricing is used by the agent and regression tests.
export type PhotoOption = { id: string; label: string; amount: number };
/**
 * Какой именно снимок нужен, чтобы увидеть признак.
 *
 * "current" — что у клиента сейчас (волосы, ногти, зона).
 * "reference" — что клиент хочет получить (скрин из Instagram, картинка с Pinterest).
 *
 * Зачем разделение: для ногтей цена зависит и от текущего покрытия, и от сложности желаемого
 * дизайна. Без пометки «этот критерий читается с референса» ассистент считал бы цену по одному
 * фото «до» и промахивался на дизайне — либо, что хуже, начинал выспрашивать дизайн текстом.
 */
export type PhotoShot = "current" | "reference";
export type PhotoCriterion = {
  id: string;
  label: string;
  mode: "base" | "surcharge";
  options: PhotoOption[];
  /** Снимок, на котором виден признак. Отсутствует = "current" (так читаются и старые конфиги). */
  shot?: PhotoShot;
};
export type PhotoPricingConfig = {
  enabled: boolean;
  criteria: PhotoCriterion[];
  /** Что клиент фотографирует — одно слово в родительном падеже: «волос», «ногтей», «зоны». */
  subject?: string;
  /** Нужен ли снимок желаемого результата, даже если ни один критерий цены с него не читается. */
  needs_reference?: boolean;
  /** Необязательная своя формулировка просьбы. Пусто — фразу собираем сами из subject. */
  ask?: string;
};
export type PhotoClassification = {
  relevant: boolean;
  /** Самый вероятный вариант по каждому признаку, который на фото виден хотя бы частично. */
  values: Record<string, string | null>;
  /**
   * Все варианты, которые фото НЕ исключает (включая самый вероятный). Кадр обрезан — сюда
   * попадают все длины длиннее видимой части; темно — все возможные густоты. Нет записи —
   * признак определён уверенно.
   */
  possible?: Record<string, string[]>;
  /** Признаки, о которых фото не говорит ничего: нет нужного снимка или признак вне кадра. */
  uncertain?: string[];
};

/** Слово для фразы-просьбы: владелец выбирает из списка, а не печатает руками. */
export const PHOTO_SUBJECTS: { id: string; label: string; genitive: string }[] = [
  { id: "hair", label: "Волосы", genitive: "волос" },
  { id: "nails", label: "Ногти", genitive: "ногтей" },
  { id: "lashes", label: "Ресницы", genitive: "ресниц" },
  { id: "brows", label: "Брови", genitive: "бровей" },
  { id: "skin", label: "Кожа", genitive: "кожи" },
  { id: "zone", label: "Зона процедуры", genitive: "зоны" },
];

export const PHOTO_PRESETS: PhotoCriterion[] = [
  {
    id: "length",
    label: "Длина волос",
    mode: "base",
    shot: "current",
    options: [
      { id: "short", label: "До плеч", amount: 0 },
      { id: "medium", label: "Ниже плеч", amount: 0 },
      { id: "long", label: "До лопаток", amount: 0 },
      { id: "very_long", label: "Ниже лопаток", amount: 0 },
    ],
  },
  {
    id: "density",
    label: "Густота",
    mode: "surcharge",
    shot: "current",
    options: [
      { id: "normal", label: "Обычная", amount: 0 },
      { id: "thick", label: "Густая", amount: 0 },
      { id: "very_thick", label: "Очень густая", amount: 0 },
    ],
  },
  {
    id: "bleached",
    label: "Следы осветления",
    mode: "surcharge",
    shot: "current",
    options: [
      { id: "no", label: "Натуральные", amount: 0 },
      { id: "partial", label: "Отросшее осветление", amount: 0 },
      { id: "yes", label: "Осветлённые по длине", amount: 0 },
    ],
  },
  {
    id: "nail_state",
    label: "Что сейчас на ногтях",
    mode: "base",
    shot: "current",
    options: [
      { id: "bare", label: "Без покрытия", amount: 0 },
      { id: "gel", label: "Старый гель-лак", amount: 0 },
      { id: "extended", label: "Наращённые", amount: 0 },
    ],
  },
  {
    id: "nail_length",
    label: "Длина ногтей",
    mode: "surcharge",
    shot: "current",
    options: [
      { id: "short", label: "Короткие", amount: 0 },
      { id: "medium", label: "Средние", amount: 0 },
      { id: "long", label: "Длинные", amount: 0 },
    ],
  },
  {
    id: "design",
    label: "Сложность дизайна",
    mode: "surcharge",
    shot: "reference",
    options: [
      { id: "plain", label: "Однотон", amount: 0 },
      { id: "accent", label: "Пара акцентных", amount: 0 },
      { id: "complex", label: "Сложный дизайн", amount: 0 },
    ],
  },
  {
    id: "lash_effect",
    label: "Желаемый объём ресниц",
    mode: "base",
    shot: "reference",
    options: [
      { id: "classic", label: "Классика (1D)", amount: 0 },
      { id: "2d", label: "2D", amount: 0 },
      { id: "3d", label: "3D", amount: 0 },
      { id: "mega", label: "Мега-объём (4D и больше)", amount: 0 },
    ],
  },
  {
    id: "lash_state",
    label: "Что сейчас на ресницах",
    mode: "surcharge",
    shot: "current",
    options: [
      { id: "natural", label: "Свои ресницы", amount: 0 },
      { id: "extended", label: "Старое наращивание (снятие)", amount: 0 },
    ],
  },
];

/**
 * Какие готовые критерии относятся к какой зоне. Владельцу, который настраивает наращивание
 * ресниц, «длина и густота волос» — шум: он их либо пропустит, либо, хуже, добавит.
 */
const PRESET_SUBJECT: Record<string, string> = {
  length: "hair",
  density: "hair",
  bleached: "hair",
  nail_state: "nails",
  nail_length: "nails",
  design: "nails",
  lash_effect: "lashes",
  lash_state: "lashes",
};

/** В конфиге зона хранится словом для фразы («ногтей»), а сравнивать удобнее по id. */
function subjectId(genitive: string | undefined): string | null {
  const word = genitive?.trim();
  return PHOTO_SUBJECTS.find((s) => s.genitive === word)?.id ?? null;
}

/** Готовые критерии для зоны (id из PHOTO_SUBJECTS). Зона неизвестна — показываем все. */
export function photoPresetsFor(subject: string | null): PhotoCriterion[] {
  return subject ? PHOTO_PRESETS.filter((p) => PRESET_SUBJECT[p.id] === subject) : PHOTO_PRESETS;
}

/**
 * Зона по названию и категории услуги — чтобы для «Маникюра с дизайном» кабинет сразу предлагал
 * критерии ногтей. Возвращает слово для фразы («ногтей») или undefined, если непонятно.
 *
 * Название проверяется раньше категории: «Вечерний макияж» лежит в категории «Макияж и причёски»
 * и по категории стал бы «волосами». По той же причине ресницы и брови проверяются раньше волос:
 * «Окрашивание бровей» — это брови, хотя «окрашивание» обычно про волосы.
 */
export function guessPhotoSubject(service: {
  name?: string | null;
  category?: string | null;
}): string | undefined {
  for (const text of [service.name, service.category]) {
    const t = (text ?? "").toLowerCase();
    if (!t.trim()) continue;
    if (/макияж|make-?up/.test(t)) return undefined;
    if (/ресниц|lash/.test(t)) return "ресниц";
    if (/бров|brow/.test(t)) return "бровей";
    if (/ногт|маникюр|педикюр|nail/.test(t)) return "ногтей";
    if (
      /волос|стрижк|окрашив|тонирова|мелирова|балаяж|кератин|завивк|причёск|прическ|укладк/.test(t)
    )
      return "волос";
  }
  return undefined;
}

/**
 * Зона услуги (id из PHOTO_SUBJECTS): выбранная владельцем, иначе по уже добавленным готовым
 * критериям, иначе по названию. Правила, сохранённые до появления выбора зоны, так тоже её
 * получают — по «Длине волос» понятно, что это волосы. null — определить не удалось.
 *
 * Правила не проверяются: кабинет спрашивает и про черновик, в котором ещё нет ни одного критерия.
 */
export function photoZoneOf(
  config: { subject?: string; criteria?: PhotoCriterion[] },
  service?: { name?: string | null; category?: string | null },
): string | null {
  const own = subjectId(config.subject);
  if (own) return own;
  const fromPresets = new Set(
    (config.criteria ?? []).map((c) => PRESET_SUBJECT[c.id]).filter(Boolean),
  );
  if (fromPresets.size === 1) return [...fromPresets][0];
  return subjectId(guessPhotoSubject(service ?? {}));
}

/**
 * Зона настроенной услуги — для guard'а в ассистенте. null — не настроена или зона неизвестна;
 * такую услугу считаем подходящей к любому разговору.
 */
export function photoSubjectOf(
  raw: unknown,
  service?: { name?: string | null; category?: string | null },
): string | null {
  const config = validatePhotoConfig(raw);
  return config ? photoZoneOf(config, service) : null;
}

/**
 * О какой зоне идёт речь в тексте. Нужно guard'у «анкета вместо фото»: вопрос «что сейчас на
 * ногтях?» законен, если у салона по фото настроены только волосы, — ногти ассистенту приходится
 * уточнять словами. Кыргызские корни — рядом с русскими: «чач» (волосы), «тырмак» (ногти),
 * «кирпик» (ресницы), «каш» (брови).
 */
export function photoSubjectsMentioned(text: string): string[] {
  const t = (text ?? "").toLowerCase();
  const words: [string, RegExp][] = [
    ["lashes", /ресниц|кирпик/],
    ["brows", /бров|каш(ы|тар|ка|ым)/],
    ["nails", /ногт|маникюр|педикюр|покрыти|гель-?лак|дизайн|тырмак|тырмаг/],
    ["hair", /волос|густот|осветл|обесцвеч|окрашив|мелирова|кератин|стрижк|причёс|причес|чач/],
  ];
  return words.filter(([, re]) => re.test(t)).map(([id]) => id);
}

/** Снимок, с которого читается критерий. Старый конфиг без поля — всегда «текущее состояние». */
export function criterionShot(criterion: PhotoCriterion): PhotoShot {
  return criterion.shot === "reference" ? "reference" : "current";
}

/**
 * Какие снимки просить у клиента. Референс нужен, если владелец включил его явно ИЛИ если с него
 * читается хоть один критерий цены — иначе ассистент попросил бы одно фото и всё равно не смог бы
 * посчитать цену, а дальше по привычке полез бы выспрашивать дизайн словами.
 *
 * Фото «как сейчас» не просим, если с него не читается ни один критерий: для ресниц, где цену
 * задаёт только желаемый объём, снимок своих глаз ничего не даёт — только лишний шаг для клиента.
 */
export function photoShotsNeeded(raw: unknown): PhotoShot[] {
  const config = validatePhotoConfig(raw);
  if (!config) return [];
  const current = config.criteria.some((c) => criterionShot(c) === "current");
  const reference =
    config.needs_reference === true ||
    config.criteria.some((c) => criterionShot(c) === "reference");
  const shots: PhotoShot[] = [];
  if (current) shots.push("current");
  if (reference) shots.push("reference");
  return shots;
}

/**
 * Готовая короткая просьба — ровно то, что ассистент говорит вместо анкеты.
 *
 * Живёт в коде, а не только в промпте, по двум причинам: владелец видит в кабинете ту самую фразу,
 * которую услышит клиент, и она же подставляется в детерминированную страховку, когда модель всё
 * равно скатывается в опрос текстом.
 */
export function photoRequestLine(raw: unknown): string {
  const config = validatePhotoConfig(raw);
  if (!config) return "";
  if (config.ask?.trim()) return config.ask.trim();
  const of = config.subject?.trim() ? ` ${config.subject.trim()}` : "";
  const shots = photoShotsNeeded(config);
  if (shots.length === 2)
    return `Пришлите, пожалуйста, фото${of} сейчас и фото того, что хотите сделать — сразу сориентирую по стоимости 🙂`;
  if (shots[0] === "reference")
    return "Пришлите, пожалуйста, пример того, что хотите сделать, — фото или скрин, сразу сориентирую по стоимости 🙂";
  return `Пришлите, пожалуйста, фото${of} — сразу сориентирую по стоимости 🙂`;
}

export function validatePhotoConfig(raw: unknown): PhotoPricingConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const config = raw as PhotoPricingConfig;
  if (
    config.enabled !== true ||
    !Array.isArray(config.criteria) ||
    !config.criteria.length ||
    config.criteria.length > 8
  )
    return null;
  if (config.subject != null && (typeof config.subject !== "string" || config.subject.length > 40))
    return null;
  if (config.ask != null && (typeof config.ask !== "string" || config.ask.length > 300))
    return null;
  if (config.needs_reference != null && typeof config.needs_reference !== "boolean") return null;
  const ids = new Set<string>();
  let bases = 0;
  for (const criterion of config.criteria) {
    if (
      !criterion ||
      typeof criterion.id !== "string" ||
      !/^[a-z0-9_]{1,40}$/.test(criterion.id) ||
      ids.has(criterion.id) ||
      typeof criterion.label !== "string" ||
      !criterion.label.trim() ||
      criterion.label.length > 80 ||
      !["base", "surcharge"].includes(criterion.mode) ||
      (criterion.shot != null && !["current", "reference"].includes(criterion.shot)) ||
      !Array.isArray(criterion.options) ||
      criterion.options.length < 2 ||
      criterion.options.length > 12
    )
      return null;
    ids.add(criterion.id);
    if (criterion.mode === "base") bases++;
    const optionIds = new Set<string>();
    for (const option of criterion.options) {
      if (
        !option ||
        typeof option.id !== "string" ||
        !/^[a-z0-9_]{1,40}$/.test(option.id) ||
        optionIds.has(option.id) ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        option.label.length > 80 ||
        !Number.isFinite(option.amount) ||
        option.amount < 0 ||
        option.amount > 10_000_000
      )
        return null;
      optionIds.add(option.id);
    }
  }
  return bases <= 1 ? config : null;
}

export function calculatePhotoPrice(
  raw: unknown,
  classification: PhotoClassification,
  service: { price: number; price_max: number },
):
  | { price: number; selected: Record<string, string> }
  | { needs: string[]; needShots: PhotoShot[] }
  | { error: string } {
  const config = validatePhotoConfig(raw);
  if (!config) return { error: "photo_rules_not_configured" };
  if (!classification.relevant)
    return {
      needs: ["Фото не относится к выбранной услуге — попросите подходящее фото."],
      needShots: photoShotsNeeded(config),
    };
  const selected: Record<string, string> = {};
  const needs: string[] = [];
  const needShots = new Set<PhotoShot>();
  // Полная цена и доплаты копятся отдельно и складываются в конце. Раньше цена менялась прямо в
  // цикле, и порядок критериев решал исход: владелец добавил в кабинете «Густоту» раньше «Длины» —
  // доплата прибавлялась, а потом «Длина» её затирала. Густые длинные волосы стоили как обычные.
  let base: number | null = null;
  let surcharges = 0;
  for (const criterion of config.criteria) {
    const value = classification.values?.[criterion.id];
    const option = criterion.options.find((o) => o.id === value);
    if (!option || classification.uncertain?.includes(criterion.id)) {
      needs.push(criterion.label);
      // Какого СНИМКА не хватило. Иначе ассистент просит «другое фото волос», хотя на самом деле
      // не увидел дизайн — то есть референс, которого клиент вообще не присылал.
      needShots.add(criterionShot(criterion));
      continue;
    }
    selected[criterion.id] = option.id;
    if (criterion.mode === "base") base = option.amount;
    else surcharges += option.amount;
  }
  if (needs.length) return { needs, needShots: [...needShots] };
  const price = (base ?? service.price) + surcharges;
  if (
    !Number.isFinite(service.price) ||
    !Number.isFinite(service.price_max) ||
    !Number.isFinite(price) ||
    price < service.price ||
    price > service.price_max
  )
    return { error: "photo_price_outside_service_range" };
  return { price, selected };
}

/**
 * Желаемый результат — это выбор клиента, а не признак, который надо «разглядеть». Примера у
 * клиента часто нет: «хочу просто однотон», «сделайте 2D». Такие слова принимаем, но ТОЛЬКО для
 * критериев, которые владелец пометил «видно на референсе». Что у клиента сейчас (длина, густота,
 * покрытие, старое наращивание), по-прежнему решает только фото: словам «у меня короткие» цена не
 * верит — ради этого оценка по фото и затевалась.
 *
 * chosen — строки «критерий:вариант» (например "design:plain"); их отдаёт модели сам инструмент в
 * price_by_choice, так что собирать id ей не нужно. Всё, что не подходит, молча отбрасывается.
 */
export function applyClientChoice(
  raw: unknown,
  classification: PhotoClassification,
  chosen: unknown,
): PhotoClassification {
  const config = validatePhotoConfig(raw);
  if (!config || !Array.isArray(chosen)) return classification;
  const values = { ...classification.values };
  const possible = { ...classification.possible };
  const uncertain = new Set(classification.uncertain ?? []);
  let applied = false;
  for (const token of chosen) {
    if (typeof token !== "string") continue;
    const [criterionId, optionId] = token.split(":");
    const criterion = config.criteria.find((c) => c.id === criterionId);
    if (!criterion || criterionShot(criterion) !== "reference") continue;
    if (!criterion.options.some((o) => o.id === optionId)) continue;
    values[criterionId] = optionId;
    possible[criterionId] = [optionId];
    uncertain.delete(criterionId);
    applied = true;
  }
  return applied
    ? { ...classification, values, possible, uncertain: [...uncertain] }
    : classification;
}

/**
 * Забыть всё, что распознано для одного из снимков. Нужна, когда фото одно, а услуге нужны два:
 * признаки второго снимка с этого фото брать нельзя, даже если распознавание их «увидело».
 */
export function forgetShot(
  raw: unknown,
  classification: PhotoClassification,
  shot: PhotoShot,
): PhotoClassification {
  const config = validatePhotoConfig(raw);
  if (!config) return classification;
  const ids = config.criteria.filter((c) => criterionShot(c) === shot).map((c) => c.id);
  if (!ids.length) return classification;
  const values = { ...classification.values };
  const possible = { ...classification.possible };
  for (const id of ids) {
    delete values[id];
    delete possible[id];
  }
  return {
    ...classification,
    values,
    possible,
    uncertain: [...new Set([...(classification.uncertain ?? []), ...ids])],
  };
}

/** Распознанное — словами владельца: { "Длина волос": "До лопаток" }. */
export function seenLabels(
  raw: unknown,
  selected: Record<string, string | null>,
): Record<string, string> {
  const config = validatePhotoConfig(raw);
  if (!config) return {};
  const out: Record<string, string> = {};
  for (const c of config.criteria) {
    const option = c.options.find((o) => o.id === selected[c.id]);
    if (option) out[c.label] = option.label;
  }
  return out;
}

/**
 * Итог оценки по фото:
 * - exact — всё видно, точная цена;
 * - range — что-то видно не до конца: ориентировочная вилка от самого дешёвого до самого дорогого
 *   варианта, которые фото не исключает, и самая вероятная цена внутри неё;
 * - choice — нет примера желаемого результата: цена каждого варианта на выбор (вилкой, если и
 *   текущее состояние видно не до конца);
 * - needs — оценить нечего: фото не про эту услугу или не хватает нескольких примеров.
 */
export type PhotoEstimate =
  | { kind: "exact"; price: number; selected: Record<string, string> }
  | {
      kind: "range";
      min: number;
      max: number;
      likely: number;
      selected: Record<string, string>;
      /** Названия признаков, которые фото не определило до конца, — ради них можно переснять. */
      unsure: string[];
    }
  | {
      kind: "choice";
      criterion: string;
      options: { choice: string; label: string; min: number; max: number }[];
      unsure: string[];
    }
  | {
      kind: "needs";
      /** irrelevant — фото не про эту услугу; reference — нет нескольких примеров сразу. */
      reason: "irrelevant" | "reference";
      needs: string[];
      needShots: PhotoShot[];
    }
  | { kind: "error"; error: string };

/**
 * Оценивает ЛЮБОЕ фото, которое относится к услуге. Клиенты шлют то, что есть: темно, под углом,
 * кадр обрезан, волосы видны наполовину. Раньше каждый неуверенный признак означал «пришлите фото
 * получше» — и в живом тесте клиентка трижды слышала «сфотографируйте волосы до пояса», так и не
 * узнав цену. Теперь неуверенность превращается в честную вилку по правилам салона: считаются все
 * варианты, которые фото не исключает, и ничего сверх них.
 *
 * Невидимое не выдумывается. Признак, о котором фото не говорит совсем, берётся во всём диапазоне
 * его вариантов — вилка шире, но честная. Исключение — желаемый результат (дизайн, объём): это
 * выбор клиента, поэтому вместо вилки — варианты с ценами.
 */
export function photoEstimate(
  raw: unknown,
  classification: PhotoClassification,
  service: { price: number; price_max: number },
): PhotoEstimate {
  const config = validatePhotoConfig(raw);
  if (!config) return { kind: "error", error: "photo_rules_not_configured" };
  if (!classification.relevant)
    return {
      kind: "needs",
      reason: "irrelevant",
      needs: ["Фото не относится к выбранной услуге — попросите подходящее фото."],
      needShots: photoShotsNeeded(config),
    };
  const candidates = new Map<string, PhotoOption[]>();
  const selected: Record<string, string> = {};
  const unsure: string[] = [];
  const missingReference: PhotoCriterion[] = [];
  for (const criterion of config.criteria) {
    const best = criterion.options.find((o) => o.id === classification.values?.[criterion.id]);
    if (!best || classification.uncertain?.includes(criterion.id)) {
      if (criterionShot(criterion) === "reference") missingReference.push(criterion);
      else {
        candidates.set(criterion.id, criterion.options);
        unsure.push(criterion.label);
      }
      continue;
    }
    selected[criterion.id] = best.id;
    const ids = classification.possible?.[criterion.id];
    const possible = Array.isArray(ids)
      ? criterion.options.filter((o) => o.id === best.id || ids.includes(o.id))
      : [best];
    candidates.set(criterion.id, possible);
    if (possible.length > 1) unsure.push(criterion.label);
  }
  if (missingReference.length > 1)
    return {
      kind: "needs",
      reason: "reference",
      needs: missingReference.map((c) => c.label),
      needShots: ["reference"],
    };

  // Цена при выборе по одному варианту на признак: «Цена» — полная стоимость, доплаты сверху.
  const priceOf = (pick: (c: PhotoCriterion, options: PhotoOption[]) => PhotoOption) => {
    let base: number | null = null;
    let surcharges = 0;
    for (const criterion of config.criteria) {
      const options = candidates.get(criterion.id);
      if (!options) continue;
      const option = pick(criterion, options);
      if (criterion.mode === "base") base = option.amount;
      else surcharges += option.amount;
    }
    return (base ?? service.price) + surcharges;
  };
  const cheapest = (_: PhotoCriterion, options: PhotoOption[]) =>
    options.reduce((a, b) => (b.amount < a.amount ? b : a));
  const dearest = (_: PhotoCriterion, options: PhotoOption[]) =>
    options.reduce((a, b) => (b.amount > a.amount ? b : a));
  const likeliest = (c: PhotoCriterion, options: PhotoOption[]) =>
    options.find((o) => o.id === selected[c.id]) ?? cheapest(c, options);
  const inCatalog = (price: number) =>
    Number.isFinite(price) && price >= service.price && price <= service.price_max;
  const outside = { kind: "error" as const, error: "photo_price_outside_service_range" };

  if (missingReference.length === 1) {
    const criterion = missingReference[0];
    const options: { choice: string; label: string; min: number; max: number }[] = [];
    for (const option of criterion.options) {
      candidates.set(criterion.id, [option]);
      const min = priceOf(cheapest);
      const max = priceOf(dearest);
      if (!inCatalog(min) || !inCatalog(max)) return outside;
      options.push({ choice: `${criterion.id}:${option.id}`, label: option.label, min, max });
    }
    return { kind: "choice", criterion: criterion.label, options, unsure };
  }

  const min = priceOf(cheapest);
  const max = priceOf(dearest);
  if (!inCatalog(min) || !inCatalog(max)) return outside;
  if (min === max) return { kind: "exact", price: min, selected };
  return { kind: "range", min, max, likely: priceOf(likeliest), selected, unsure };
}

/**
 * Какие цены получит клиент — таблицей, для кабинета. Строки — критерий «Цена» (или первая
 * доплата, если «Цены» нет), столбцы — следующая доплата. Владелец видит «Ниже лопаток + Очень
 * густая = 7000» до того, как это услышит клиент, и сразу замечает комбинации вне прайса.
 */
export type PhotoPriceTable = {
  rowTitle: string;
  rows: string[];
  colTitle: string | null;
  cols: string[];
  /** prices[строка][столбец]. Без второго критерия — один столбец. */
  prices: number[][];
  /** Критерии сверх двух: к цене из таблицы прибавляется их доплата от min до max. */
  extras: { label: string; min: number; max: number }[];
};

export function photoPriceTable(raw: unknown, service: { price: number }): PhotoPriceTable | null {
  const config = validatePhotoConfig(raw);
  if (!config) return null;
  const base = config.criteria.find((c) => c.mode === "base");
  const surcharges = config.criteria.filter((c) => c.mode === "surcharge");
  const rowCriterion = base ?? surcharges[0];
  const colCriterion = base ? surcharges[0] : surcharges[1];
  const extras = surcharges.filter((c) => c !== rowCriterion && c !== colCriterion);
  const cheapest = (c: PhotoCriterion) => Math.min(...c.options.map((o) => o.amount));
  const extraMin = extras.reduce((sum, c) => sum + cheapest(c), 0);
  const start = (o: PhotoOption) => (base ? o.amount : service.price + o.amount);
  return {
    rowTitle: rowCriterion.label,
    rows: rowCriterion.options.map((o) => o.label),
    colTitle: colCriterion?.label ?? null,
    cols: colCriterion?.options.map((o) => o.label) ?? [],
    prices: rowCriterion.options.map((r) =>
      (colCriterion?.options ?? [null]).map((c) => start(r) + (c?.amount ?? 0) + extraMin),
    ),
    extras: extras.map((c) => ({
      label: c.label,
      min: cheapest(c),
      max: Math.max(...c.options.map((o) => o.amount)),
    })),
  };
}

export function photoRuleRangeError(
  raw: unknown,
  service: { price: number; price_max: number },
): string | null {
  const config = validatePhotoConfig(raw);
  if (!config) return "Заполните варианты и не используйте два критерия с полной ценой";
  const base = config.criteria.find((c) => c.mode === "base");
  const surcharges = config.criteria.filter((c) => c.mode === "surcharge");
  const min =
    (base ? Math.min(...base.options.map((o) => o.amount)) : service.price) +
    surcharges.reduce((sum, c) => sum + Math.min(...c.options.map((o) => o.amount)), 0);
  const max =
    (base ? Math.max(...base.options.map((o) => o.amount)) : service.price) +
    surcharges.reduce((sum, c) => sum + Math.max(...c.options.map((o) => o.amount)), 0);
  return min < service.price || max > service.price_max
    ? `Возможные цены ${min}–${max} выходят за прайс услуги ${service.price}–${service.price_max}`
    : null;
}

export function photoBookingPrice(
  quote: { serviceId: string; price: number; at: number } | null,
  serviceId: string,
  requested: unknown,
  now = Date.now(),
): { price: number | null } | { error: string } {
  const value = requested == null ? null : Number(requested);
  if (value != null && !Number.isFinite(value)) return { error: "invalid_price_override" };
  if (
    !quote ||
    quote.serviceId !== serviceId ||
    !Number.isFinite(quote.price) ||
    now - quote.at > 3_600_000 ||
    now < quote.at
  )
    return { price: value };
  if (value != null && value !== quote.price) return { error: "photo_quote_price_mismatch" };
  return { price: quote.price };
}
