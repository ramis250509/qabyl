// WhatsApp assistant V4 — conversational LLM agent with tool calling (server-only).
//
// Unlike V3 (Gemini classifies intent → rigid TS state machine renders numbered menus),
// V4 lets Gemini 2.5 Flash drive the whole dialog like a human admin would, while every
// FACT (services, prices, free slots, bookings) comes only from tools executed by
// deterministic TS code against the DB. The model physically can't book a slot that
// doesn't exist: create_appointment re-validates availability server-side and the
// create_appointment RPC rejects overlaps.
//
// Rollout is gated per salon by salon_ai_assistant.engine ('v3' default | 'v4') — see
// the webhook (src/routes/api/public/wa.$salonId.ts). V3 code paths are untouched.

import {
  callGeminiTools,
  confidentLanguage,
  detectLanguage,
  fetchMergedSlots,
  formatDateInTz,
  formatTimeInTz,
  loadAiVisibleServicesForSalon,
  loadMastersForService,
  nowInTz,
  buildDateMap,
  type DbMaster,
  type GeminiV2Content,
  type WaAgentInput,
  type WaAgentResult,
  type WaAgentState,
  type WaAgentStateData,
} from "@/lib/wa-agent.server";
import { INDUSTRY_EXPERT } from "@/lib/wa-industries.server";
import { INDUSTRIES_META, normalizeIndustry, type IndustryKey } from "@/lib/industries";

type AdminClient = Awaited<ReturnType<typeof getAdmin>>;
async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const MAX_TOOL_ITERS = 8;
const HISTORY_CAP = 30; // Gemini contents kept in state_data.v4_history between turns
const PHOTO_NOTES_CAP = 6; // structured photo analyses kept in state_data.photo_notes
// The agent must see the WHOLE day's free start-times, not a truncated head of the list.
// A capped list (was 8) made the model think a full working day ended at 11:45 and wrongly
// tell clients that later times like 17:00 were "занято". 64 covers any realistic salon day
// even at 15-minute granularity; the model is told to SHOW only a few, well-spaced options.
const DAY_SLOT_CAP = 64;

// ============================================================
// System prompt
// ============================================================

const DAY_LABELS_RU: Record<string, string> = {
  mon: "пн",
  tue: "вт",
  wed: "ср",
  thu: "чт",
  fri: "пт",
  sat: "сб",
  sun: "вс",
};

function renderWorkingHours(wh: Record<string, string> | null | undefined): string {
  if (!wh) return "";
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const lines = order
    .filter((d) => wh[d])
    .map((d) => `${DAY_LABELS_RU[d]}: ${wh[d]}`)
    .join(", ");
  return lines;
}

// Ответы владельца на вопросы «книги знаний» отрасли → строки «Вопрос: ответ»
// для системного промпта. Пустые ответы пропускаются.
function renderKnowledgeAnswers(
  industryKey: IndustryKey,
  answers: Record<string, string> | null | undefined,
): string {
  if (!answers) return "";
  return INDUSTRIES_META[industryKey].questions
    .map((q) => {
      const v = answers[q.id]?.trim();
      return v ? `${q.label}: ${v}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Дефолтные бьюти-примеры коротких реплик (используются, если у отрасли нет
// собственных consultationScenarios).
const BEAUTY_SCENARIOS = [
  `- «Канча болот?», «Канчадан кератин жасайсыздар?», «Канчадар», «Сколько? Примерно» → спрашивают цену. Для range-услуги назови вилку из get_services и предложи прислать фото для точной оценки.`,
  `- «Кератин 2500 болобу э», «за 2500 сделаете?» → называют свою цифру. Сверься с get_services: если попадает в вилку — подтверди мягко, если ниже — тактично объясни реальную вилку, не споря.`,
  `- «Кератин зыяндуулугу кандай», «вредно ли» → вопрос о вреде/безопасности: ответь коротко и честно из базы знаний.`,
  `- «Бүгүнкүгө барбы окошко?», «на сегодня есть окошко?», «Саат 17:00?» → спрашивают о свободном времени/конкретном часе: если услуга ясна — вызови get_available_slots и ответь; если не ясна — уточни услугу одним вопросом.`,
  `- «Макул, азыр таштаймын», «сейчас скину» → клиент сейчас пришлёт фото: коротко подтверди («Хорошо, жду фото 🙂») и жди следующего сообщения.`,
  `- «Менин эки кызымдыкы тармал, 16–18 жашта» → консультация по детям/нескольким людям: учти возраст и факты салона (напр. детский возраст, длительность), уточни детали при необходимости.`,
  `- ФОТО БЕЗ ТЕКСТА → это почти всегда волосы/ногти для оценки. Оцени по фото (см. ниже) для обсуждаемой услуги; если услуга ещё не ясна — коротко спроси, что хочет сделать.`,
].join("\n");

// Prior photo analyses (state_data.photo_notes) → a compact recap for the prompt so the model
// "remembers" what it saw on earlier photos even though the pixels are gone from history.
function renderPhotoNotes(notes: PhotoNote[] | undefined): string {
  if (!notes?.length) return "";
  return notes
    .slice(-PHOTO_NOTES_CAP)
    .map((n) => {
      const bits = [
        n.summary,
        n.service_hint ? `услуга: ${n.service_hint}` : "",
        n.issues?.length ? `нюансы: ${n.issues.join(", ")}` : "",
        n.price_band ? `оценка: ${n.price_band}` : "",
        n.needs?.length ? `не хватает: ${n.needs.join(", ")}` : "",
      ].filter(Boolean);
      return `- [${n.kind}] ${bits.join("; ")}`;
    })
    .join("\n");
}

function buildSystemPromptV4(input: WaAgentInput, closedDates: string[] = []): string {
  const { salon, config, branches, salonInfo } = input;
  const { isoLocalDate, humanDate, hour, minute } = nowInTz(salon.timezone);
  const industryKey = normalizeIndustry(config.industry);
  const ind = INDUSTRY_EXPERT[industryKey];
  const knowledgeBook = renderKnowledgeAnswers(industryKey, config.knowledge_answers);
  const dateMap = buildDateMap(salon.timezone, 14);
  const dates = dateMap.map((d) => `${d.iso} = ${d.relative} (${d.label})`).join("\n");
  // Upcoming whole-salon days-off (from master_day_overrides) with human labels, so the
  // assistant can say «в этот день у нас выходной» immediately — without first asking for a
  // service just to discover the day is closed.
  const closedSet = new Set(closedDates);
  const closedLine = dateMap
    .filter((d) => closedSet.has(d.iso))
    .map((d) => `${d.label} (${d.iso})`)
    .join("; ");
  const hours = renderWorkingHours(salonInfo?.working_hours);
  const langs = (config.languages?.length ? config.languages : ["ru"]).join(", ");
  const cutoff = config.manage_cutoff_hours ?? 0;

  const lines: string[] = [
    ind.persona(salon.salonName),
    ``,
    `ФОРМАТ (СТРОГО): только сплошной связный текст. ЗАПРЕЩЕНЫ списки, пункты, нумерация «1.» «2.» «3.», маркеры «-»/«•» и любой markdown (никаких ** и #). Даже сравнивая две процедуры — пиши обычными предложениями, а не списком. Неправильно: «1. Ботокс… 2. Кератин…». Правильно: «Ботокс — про восстановление и блеск, а кератин — про гладкость. После осветления я бы начала с ботокса.»`,
    `ДЛИНА (ВАЖНО): пиши коротко, как человек в чате. Обычно 1–3 коротких предложения. Если достаточно одного предложения — отвечай одним. Длинные объяснения дроби на короткие мысли, не строчи «простынёй».`,
    `Даже объясняя процедуру («что такое кератин?») — уложись в 2–3 живых предложения по сути и предложи спросить детали, а НЕ выдавай абзац-лекцию. Клиент в мессенджере не читает длинные тексты.`,
    `Тепло и по-человечески, без канцелярита. Эмодзи — максимум один на сообщение (часто лучше без). Никогда не говори, что ты бот, ИИ или ассистент.`,
    ``,
    `МОЛЧАЛИВОЕ ВЫПОЛНЕНИЕ (КРИТИЧЕСКИ ВАЖНО): никогда не пиши клиенту, что ты сейчас что-то проверяешь/смотришь/уточняешь. ЗАПРЕЩЕНЫ фразы «сейчас проверю», «подождите», «минуточку», «секундочку», «дайте гляну», «азыр текшерип көрөйүн», «бир аз күтө туруңуз». Вместо этого СНАЧАЛА молча выполни все нужные вызовы инструментов (календарь, свободные окна, цена, анализ фото, любые запросы), дождись результата — и только потом отправь клиенту ГОТОВЫЙ ответ. Пусть это займёт на пару секунд дольше — клиент должен видеть результат, а не процесс. У тебя один ответ за ход, поэтому «подождите» = клиент останется без ответа. Так делать нельзя.`,
    `ЕСЛИ ИНСТРУМЕНТ ВЕРНУЛ ОШИБКУ: не молчи. Вежливо скажи, например «Извините, сейчас не получилось получить данные расписания — попробуйте, пожалуйста, через минуту, или я передам ваш запрос администратору», и при необходимости вызови escalate_to_human. Никогда не оставляй клиента без ответа после начала обработки.`,
    `ЯЗЫК: отвечай на языке ПОСЛЕДНЕГО сообщения клиента (языки салона: ${langs}). Клиент сменил язык (например с кыргызского на русский или обратно) — сразу переключаешься и ты. Кыргызский узнавай по «салам», «кандай», «канча», «болобу», «жасайсыз», «бүгүн», «эртең», «эже», «байке», буквам ң/ү/ө; в т.ч. латиницей. Не смешивай языки в одном сообщении.`,
    `ОБРАЩЕНИЕ: всегда на «Вы», даже если клиент пишет на «ты» — это вежливый стиль администратора. В кыргызском используй вежливые формы (сиз, -ңыз/-ңиз/-ыңыз), в других языках — аналогичную вежливую форму, если она есть в языке.`,
    config.tone_instructions
      ? `ОБЯЗАТЕЛЬНЫЕ правила тона от салона: ${config.tone_instructions}`
      : "",
    ``,
    `СЕГОДНЯ: ${humanDate} (${isoLocalDate}), время ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${salon.timezone}).`,
    `ТАБЛИЦА ДАТ (перевод «завтра», «в пятницу», «бүгүнкүгө» в YYYY-MM-DD):`,
    dates,
    closedLine
      ? `ВЫХОДНЫЕ ДНИ (салон НЕ работает, записать нельзя): ${closedLine}. Если клиент просит запись на такой день — сразу скажи, что в этот день выходной, и предложи ближайший рабочий день. НЕ спрашивай услугу и НЕ говори «занято» для этих дат.`
      : "",
    ``,
    `ИНФОРМАЦИЯ О САЛОНЕ:`,
    salonInfo?.address ? `Адрес: ${salonInfo.address}` : "",
    hours ? `Часы работы: ${hours}` : "",
    branches.length > 1
      ? `Филиалы:\n${branches.map((b) => `- ${b.name}${b.address ? ` (${b.address})` : ""} [id: ${b.id}]`).join("\n")}`
      : "",
    knowledgeBook
      ? `ЧТО ВЛАДЕЛЕЦ РАССКАЗАЛ ОБ ЭТОМ БИЗНЕСЕ (используй эти факты естественно, когда уместно; не зачитывай списком):\n${knowledgeBook}`
      : "",
    config.knowledge_base
      ? `ДОПОЛНИТЕЛЬНЫЕ ФАКТЫ О БИЗНЕСЕ (правила, гарантия, материалы, акции):\n${config.knowledge_base}`
      : "",
    config.client_addressing?.trim()
      ? `КАК К ТЕБЕ ОБРАЩАЮТСЯ КЛИЕНТЫ: ${config.client_addressing.trim().replace(/\s*\n\s*/g, ", ")}. Если клиент пишет одно из этих слов (или похожее обращение) — он обращается ИМЕННО К ТЕБЕ, администратору. Не переспрашивай «к кому вы обращаетесь?» и не проси уточнить — просто продолжай диалог естественно. Сам эти слова в ответах использовать не обязан.`
      : "",
    ``,
    `ТВОЯ ЭКСПЕРТНАЯ БАЗА ЗНАНИЙ (общие знания об услугах этой сферы для консультации, это НЕ прайс салона):`,
    ind.knowledgeBase,
    ``,
    `ТЫ КОНСУЛЬТАНТ, А НЕ ОФОРМИТЕЛЬ ЗАПИСЕЙ:`,
    `- НЕ вываливай список услуг на первое сообщение. Сначала пойми, что человеку нужно.`,
    `- Если запрос неполный — задай 1 короткий уточняющий вопрос по сути (что именно нужно, важные детали запроса). Не заваливай вопросами.`,
    `- Сам определи подходящую услугу и коротко объясни выбор. Отвечай на вопросы из базы знаний: кому подходит, противопоказания, отличия, сроки, уход, совместимость.`,
    `- Темп: не дави записью и не спеши закончить. Сними сомнения и возражения (цена, безопасность, «подумаю»), и лишь когда клиент определился — ненавязчиво предложи подобрать время.`,
    `- С ПЕРВОГО сообщения определи цель клиента (узнать цену, подобрать услугу, записаться, перенести или отменить запись, узнать свободное время, консультация, оценка по фото, вопрос о процедуре) и сразу веди подходящий сценарий, не переспрашивая лишнего.`,
    `- ПОМНИ ВЕСЬ КОНТЕКСТ диалога: имя, дату, время, услугу, длину/тип волос, присланные фото и любые уже названные детали. НИКОГДА не переспрашивай то, что клиент уже сообщил.`,
    `- ПАМЯТЬ О ФОТО: когда клиент присылает фото — проанализируй его как мастер и СРАЗУ вызови remember_photo (kind, summary, при оценке price_band, при необходимости issues/needs). Пиксели фото исчезают после этого хода, поэтому если не сохранишь — потеряешь. Ниже в блоке «РАЗБОР РАНЕЕ ПРИСЛАННЫХ ФОТО» вернётся то, что ты уже видел — опирайся на него и НЕ проси то же фото снова.`,
    ...(renderPhotoNotes((input.stateData as any)?.photo_notes)
      ? [
          `РАЗБОР РАНЕЕ ПРИСЛАННЫХ ФОТО (ты это уже видел, помни это):`,
          renderPhotoNotes((input.stateData as any)?.photo_notes),
        ]
      : []),
    `- ГЛАВНАЯ ЦЕЛЬ — помочь клиенту записаться. Мягко и естественно веди к записи, когда это уместно, но без навязчивых продаж и давления.`,
    `- Ты администратор ИМЕННО «${salon.salonName}»: опирайся на факты, стиль, акции, гарантию и материалы этого салона. Клиент должен чувствовать, что пишет живому админу этого салона, а не общему боту.`,
    `- Пиши естественно, как опытный администратор: без шаблонных и роботизированных фраз, без повторов и канцелярита.`,
    ``,
    `КОРОТКИЕ И РАЗГОВОРНЫЕ СООБЩЕНИЯ — понимай их как живой админ (примеры):`,
    ind.consultationScenarios ?? BEAUTY_SCENARIOS,
    ``,
    ...(ind.usesPhotoPricing
      ? [
          `ОЦЕНКА СТОИМОСТИ ПО ФОТО — работай как мастер с 20-летним опытом, а НЕ выдавай среднее число:`,
          `- Сначала узнай вилку услуги из get_services (price_type=range даёт минимум и максимум). Оценка обязана лежать внутри этой вилки.`,
          `- Определяй цену по тому, что видно на фото: длина волос, густота, объём, степень повреждения и пористость, следы прошлых окрашиваний/осветлений, сложность работы, предполагаемый расход состава и время работы мастера. Короткие/тонкие волосы — ближе к нижней границе; длинные/густые/повреждённые — ближе к верхней.`,
          `- Назови УЗКИЙ диапазон (в идеале шириной ~200–500 сом), а не всю вилку и не ровную середину. Говори как живой мастер, естественно. Пример стиля: «Ийинден болсо 3200–3700 эсептесеңиз болот, эже» / «По фото где-то 3200–3500 сом получится».`,
          `- Всегда добавляй, что точную цену мастер подтвердит на месте (волосы вживую видно точнее).`,
        ]
      : [
          `ЦЕНА: называй цены и вилки ТОЛЬКО из get_services. Фиксированная цена — назови её; вилка — назови диапазон и объясни, от чего зависит итог (используй факты о бизнесе). Точную стоимость подтвердит специалист на месте (а для медицинских услуг — после осмотра); так и говори, не выдумывай точную цифру.`,
        ]),
    config.pricing_rules ? `- Дополнительные правила по цене от бизнеса (учитывай их): ${config.pricing_rules}` : "",
    ``,
    `ЦЕНЫ, УСЛУГИ, ВРЕМЯ, МАСТЕРА — только из инструментов:`,
    `- Перед тем как назвать цену или записать — вызови get_services и опирайся на реальные названия/цены. Услуги, слоты, имена мастеров НЕ выдумывай.`,
    `- Если нужной процедуры в салоне нет — честно скажи и предложи ближайшую из имеющихся.`,
    ``,
    `КОГДА КЛИЕНТ ГОТОВ ЗАПИСАТЬСЯ (не раньше):`,
    branches.length > 1 ? `- Если филиал не выбран — уточни, куда удобнее.` : "",
    `- РАБОТА С КАЛЕНДАРЁМ (СТРОГО): о свободном времени говори ТОЛЬКО по данным инструментов, никогда не угадывай. Спросил про день — вызови get_available_slots на эту дату. Клиент назвал КОНКРЕТНЫЙ час («17:00 барбы?») — вызови check_time на эту дату и час и ответь по факту. НИКОГДА не говори, что время занято, пока не проверил его инструментом; если инструмент показал время свободным — оно свободно.`,
    `- check_time возвращает reason: ok (свободно, можно записывать) / time_taken (это время уже занято — предложи из nearby_free_times) / outside_hours (в это время салон/мастер уже не работает или процедура не успеет закончиться — НЕ говори «занято»; скажи, что на этот час не получится, и предложи времена из nearby_free_times) / closed_that_day (выходной) / fully_booked (весь день занят). Никогда не называй «outside_hours» занятостью.`,
    `- get_available_slots возвращает ПОЛНЫЙ список свободных времён начала на дату (учитывает длительность процедуры и занятость) плюс поле reason. reason=closed_that_day → в этот день салон НЕ работает (выходной): так и скажи и предложи другой день, НЕ говори «занято». reason=fully_booked → на эту дату всё занято, предложи ближайший день. reason=part_unavailable → на запрошенную часть дня (утро/день/вечер) окошек нет, НО в этот же день есть другое время: предложи эти времена из free_times («вечером всё занято, но есть днём в 14:00 или 16:00»), НЕ говори «всё занято» и НЕ перескакивай на другой день. Никогда не выдавай «выходной» за «занято» и наоборот.`,
    `- ВРЕМЯ ЗАКРЫТИЯ (СТРОГО): никогда не предлагай и не подтверждай время, если услуга не успеет закончиться до закрытия салона. Пример: салон работает до 20:00, услуга длится 3 часа — значит запись возможна не позже 17:00, а 18:00/19:00 предлагать нельзя. Не считай это в уме — get_available_slots уже отфильтровал такие времена, предлагай ТОЛЬКО из его ответа. Если клиент сам просит время, которое не помещается до закрытия, мягко объясни и предложи ближайшее подходящее из get_available_slots (в т.ч. на другой день).`,
    `- Клиенту показывай не весь список, а 2–4 удобно РАЗНЕСЁННЫХ варианта (например утро, день, вечер), а не подряд через 15 минут. Пример: «Есть 10:00, 13:00 и 16:00 — что удобнее?»`,
    `- Мастеров несколько и клиенту важно — предложи выбор (get_masters). Если у мастеров указана specialization/bio_short — рекомендуй по сильной стороне («по сложному окрашиванию лучше Айгерим, по маникюру — Нургуль»). «Всё равно» — выбери сам и назови, кого записал.`,
    `- ЦЕНЫ: get_services даёт price_min, price_max (числа) и price_label. Для услуги с диапазоном называй вилку (price_label) и говори, что точную цену подтвердит мастер; если согласовали конкретную сумму — передай её в create_appointment как price_override (сервер сам удержит её в пределах price_min…price_max). Никогда не называй цену вне вилки и не считай стоимость «на глаз» без этих чисел.`,
    `- Узнай имя (если не знаешь), повтори детали одной фразой (услуга, дата, время, мастер, цена) и дождись явного «да». Только тогда вызови create_appointment, коротко поздравь и напомни адрес.`,
    `- ВРЕМЯ ЗАПИСИ (СТРОГО): в create_appointment/reschedule_appointment передавай время как date + time (HH:MM, напр. 11:00) — НИКОГДА не вычисляй и не пиши ISO/таймстемпы сам, сервер сам подберёт точный слот. Если инструмент вернул reason=slot_not_free — это время уже заняли, предложи клиенту времена из поля nearest и переспроси; НИКОГДА не подставляй другое время молча (клиент просил 11:00 — не записывай на другое без его согласия).`,
    `- ДЛЯ КОГО ЗАПИСЬ: если клиент записывает не себя, а другого (дочку, маму, подругу — «кызымды жазам», «на дочь»), в client_name пиши имя ТОГО, КОГО записывают, а не имя клиента. Спроси имя именно этого человека («А как зовут дочку?»), не переспрашивай про клиента. Держи в голове ранее упомянутые детали (возраст ребёнка и т.п.) — не теряй их.`,
    `- НИКОГДА не пиши «сейчас проверю», «подождите», «минуточку». У тебя один ответ за ход: сразу вызови инструменты и дай готовый ответ (свободное время, либо что времени нет, либо что не получилось получить расписание). Диалог не должен обрываться на «подождите».`,
    ``,
    `УПРАВЛЕНИЕ ЗАПИСЬЮ: «отменить/перенести» → get_my_appointments, уточни какую, подтверди «да», затем cancel_appointment / reschedule_appointment (для переноса сперва подбери время).`,
    cutoff > 0
      ? `Если до визита меньше ${cutoff} ч — отмена/перенос через чат невозможны, попроси позвонить в салон.`
      : "",
    ``,
    `ЖЕЛЕЗНЫЕ ПРАВИЛА:`,
    `- Не выдумывай факты. Если не уверен в ответе или вопрос сложный/нестандартный — лучше передай администратору, чем сочини.`,
    `- ГАРАНТИЯ/СРОКИ: точную гарантию салона называй ТОЛЬКО если она есть в фактах о салоне выше. Не придумывай срок гарантии. И следи за логикой: гарантия не может быть длиннее, чем держится результат (напр. если кератин держится 3–5 месяцев, гарантия в «10 месяцев» — бессмыслица). Если салон не задал гарантию — честно скажи, что условия уточнит мастер, не выдумывай цифру.`,
    `- Здоровье и противопоказания (беременность, аллергии, заболевания, приём лекарств и т.п.): дай общую информацию из базы знаний, но без диагнозов и без медицинских гарантий; порекомендуй очную оценку специалиста или врача.`,
    `- Не обещай «100%» результат и не преувеличивай сроки.`,
    `- create_appointment — только после явного «да» («да», «записывайте», «ооба», «макул»).`,
    `- reason=slot_not_free при записи → извинись, что время только что заняли, и предложи времена из nearest.`,
    `- Не обещай «перезвонить»/«написать позже» — у тебя один ответ за ход.`,
    `- ЭСКАЛАЦИЯ: если клиент жалуется, конфликтует, просит живого человека, ситуация нестандартная или ты НЕ уверен в ответе — вызови escalate_to_human (в reason кратко опиши суть) и вежливо скажи, что передаёшь диалог администратору салона, он скоро ответит. Не придумывай ответ вместо этого.`,
    `- НО обычные вопросы о процедурах, ценах, времени и записи решай сам — уверенно, по базе знаний и инструментам. Эскалация только для действительно сложных/спорных случаев, не по мелочам.`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ============================================================
// Tool declarations
// ============================================================

const V4_TOOL_DECLARATIONS = [
  {
    name: "get_services",
    description:
      "Список услуг салона с ценами и длительностью. Вызывай перед любым ответом про услуги/цены.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_masters",
    description:
      "Мастера, выполняющие услугу, с их специализацией (specialization) и кратким био (bio_short) — используй их, чтобы рекомендовать подходящего мастера.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        branch_id: { type: "string", description: "ID филиала (если выбран)" },
      },
      required: ["service_id"],
    },
  },
  {
    name: "get_available_slots",
    description:
      "Полный (НЕ обрезанный) список свободных времён начала на дату. Клиенту показывай 2–4 удобно расставленных варианта. Возвращает reason, если свободного времени нет: closed_that_day (выходной) / fully_booked (весь день занят) / part_unavailable (запрошенная часть дня занята, но в этот же день есть другое время — оно в free_times).",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD из таблицы дат" },
        master_id: { type: "string", description: "Конкретный мастер (необязательно)" },
        branch_id: { type: "string", description: "ID филиала (если выбран)" },
        part_of_day: {
          type: "string",
          enum: ["morning", "afternoon", "evening"],
          description: "Фильтр: утро (<12), день (12–17), вечер (>17)",
        },
      },
      required: ["service_id", "date"],
    },
  },
  {
    name: "check_time",
    description:
      "Проверить, свободно ли КОНКРЕТНОЕ время на дату (когда клиент называет час, напр. «17:00 барбы?»). Возвращает точный ответ да/нет из календаря и ближайшие свободные времена. Всегда используй это, прежде чем сказать, что время занято.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD из таблицы дат" },
        time: { type: "string", description: "Час в формате HH:MM, напр. 17:00" },
        master_id: { type: "string", description: "Конкретный мастер (необязательно)" },
        branch_id: { type: "string", description: "ID филиала (если выбран)" },
      },
      required: ["service_id", "date", "time"],
    },
  },
  {
    name: "create_appointment",
    description:
      "Создать запись. Вызывать ТОЛЬКО после явного «да» клиента на озвученные детали. Время передавай как date + time (НЕ ISO/таймстемп) — сервер сам подберёт точный слот. Если вернётся reason=slot_not_free — предложи клиенту времена из nearest, не подставляй другое время сам.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        master_id: { type: "string" },
        date: { type: "string", description: "Дата YYYY-MM-DD из таблицы дат" },
        time: { type: "string", description: "Время начала в формате HH:MM, напр. 11:00" },
        client_name: { type: "string" },
        branch_id: { type: "string" },
        price_override: { type: "number", description: "Согласованная цена для range-услуг" },
      },
      required: ["service_id", "master_id", "date", "time", "client_name"],
    },
  },
  {
    name: "get_my_appointments",
    description: "Предстоящие записи этого клиента (для отмены/переноса).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "cancel_appointment",
    description: "Отменить запись клиента. Только после явного подтверждения.",
    parameters: {
      type: "object",
      properties: { appointment_id: { type: "string" } },
      required: ["appointment_id"],
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Перенести запись на новое время (и при необходимости к другому мастеру). Только после явного подтверждения. Время передавай как new_date + new_time (НЕ ISO). При reason=slot_not_free — предложи времена из nearest.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        new_date: { type: "string", description: "Новая дата YYYY-MM-DD" },
        new_time: { type: "string", description: "Новое время HH:MM" },
        new_master_id: { type: "string", description: "Только если мастер меняется" },
      },
      required: ["appointment_id", "new_date", "new_time"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Передать диалог живому администратору салона. Вызывай при жалобе, конфликте, просьбе позвать человека, нестандартной/сложной ситуации ИЛИ когда ты не уверен в ответе. Лучше передать, чем выдумать.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Кратко суть для администратора (что хочет клиент / в чём затык)",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "remember_photo",
    description:
      "Сохрани разбор ПРИСЛАННОГО клиентом фото, чтобы не потерять его на следующих ходах (пиксели фото пропадают после этого хода). Вызывай СРАЗУ, как проанализировал фото. На последующих ходах сохранённый разбор вернётся тебе в контексте — не проси то же фото повторно.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Что на фото: hair | nails | lashes | brows | face | other",
        },
        summary: {
          type: "string",
          description: "Что ты как мастер видишь на фото (длина, густота, состояние, желаемый результат)",
        },
        service_hint: { type: "string", description: "К какой услуге относится фото" },
        issues: {
          type: "array",
          items: { type: "string" },
          description: "Замеченные проблемы/риски (повреждение, противопоказания)",
        },
        needs: {
          type: "array",
          items: { type: "string" },
          description: "Каких доп. фото/данных ещё не хватает (только реально нужное)",
        },
        price_band: {
          type: "string",
          description: "Узкий диапазон цены по фото (если оценивал), напр. «3200–3500 сом»",
        },
      },
      required: ["kind", "summary"],
    },
  },
];

// ============================================================
// Tool executor — deterministic TS against the DB
// ============================================================

export type PhotoNote = {
  ts: string; // ISO instant the analysis was made
  kind: string; // hair | nails | lashes | brows | face | other
  summary: string; // what the master sees on the photo
  service_hint?: string; // which service it points to
  issues?: string[]; // damage / contraindications noticed
  needs?: string[]; // extra photos or info still needed
  price_band?: string; // narrow estimate, e.g. "3200–3500 сом"
};

type V4RunFlags = {
  appointmentId: string | null;
  selectedBranchId: string | null;
  needsHuman: boolean;
  escalateReason: string | null;
  photoNotes: PhotoNote[]; // structured photo analyses persisted across turns
};

// Normalize a loose clock string ("11", "11:0", "11.00", "11 00") → "HH:MM" or null.
export function normHHMM(t: string): string | null {
  const m = String(t ?? "").match(/(\d{1,2})[:.\s]*(\d{2})?/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Weekday for a YYYY-MM-DD, 0=Sunday..6=Saturday — matches Postgres EXTRACT(DOW) used by the
// get_available_slots SQL, so TS and SQL agree on which day a date is.
function dowOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

// AUTHORITATIVE "is this date a working day for this service?" — mirrors the schedule logic of
// the get_available_slots SQL (per-date master_day_overrides off/workday, weekly master_schedules,
// branch working_hours) so we can tell «выходной» apart from «всё занято». This is the FIX for
// the day-off bug: a one-off day-off is stored as master_day_overrides(kind='off') for every
// master (see SalonDayOverridesCard), NOT in salons.working_hours — so the old classifyEmptyDay,
// which only read the weekly salons.working_hours map, wrongly reported "fully_booked".
// Bookings are intentionally ignored here: this answers "is anyone scheduled to work at all?".
export async function isDayWorkableForService(opts: {
  db: AdminClient;
  input: WaAgentInput;
  serviceId: string;
  date: string;
  branchId?: string | null;
}): Promise<boolean> {
  try {
    const branchId = opts.branchId ?? opts.input.selectedBranchId ?? null;
    const masters = await loadMastersForService(
      opts.db,
      opts.input.salon.salonId,
      opts.serviceId,
      branchId,
    );
    if (masters.length === 0) return false;
    const dow = dowOf(opts.date);
    const ids = masters.map((m) => m.id);

    const [overridesRes, schedRes] = await Promise.all([
      opts.db
        .from("master_day_overrides")
        .select("master_id, is_off, kind, intervals")
        .in("master_id", ids)
        .eq("date", opts.date),
      opts.db
        .from("master_schedules")
        .select("master_id")
        .in("master_id", ids)
        .eq("weekday", dow),
    ]);
    const overrides = new Map<string, any>();
    for (const o of ((overridesRes as any).data as any[]) ?? []) overrides.set(o.master_id, o);
    const scheduled = new Set<string>();
    for (const s of ((schedRes as any).data as any[]) ?? []) scheduled.add(s.master_id);

    // Branch closed that weekday? branches.working_hours is keyed by numeric dow with an
    // array-of-intervals value; an empty array means closed. null/absent = no constraint.
    if (branchId) {
      const { data: b } = await opts.db
        .from("branches")
        .select("working_hours")
        .eq("id", branchId)
        .maybeSingle();
      const wh = (b as any)?.working_hours;
      if (wh && typeof wh === "object") {
        const iv = wh[String(dow)];
        if (Array.isArray(iv) && iv.length === 0) return false;
      }
    }

    for (const m of masters) {
      const ov = overrides.get(m.id);
      if (ov && (ov.is_off || ov.kind === "off")) continue; // this master off this date
      const workdayOverride =
        ov && ov.kind === "workday" && Array.isArray(ov.intervals) && ov.intervals.length > 0;
      if (workdayOverride || scheduled.has(m.id)) return true; // at least one master works
    }
    return false;
  } catch {
    // On any query failure, don't wrongly claim "выходной" — fall back to "fully_booked".
    return true;
  }
}

// Dates in the next `days` on which the WHOLE salon is closed (one-off days-off applied to all
// masters via SalonDayOverridesCard → master_day_overrides note='salon_bulk', kind='off').
// Injected into the prompt so the assistant can announce «выходной» BEFORE a service is chosen,
// instead of asking "на какую услугу?" for a day it can't book at all.
export async function loadSalonClosedDates(
  db: AdminClient,
  salonId: string,
  fromIso: string,
  days: number,
): Promise<string[]> {
  try {
    const to = new Date(`${fromIso}T12:00:00Z`);
    to.setUTCDate(to.getUTCDate() + days);
    const toIso = to.toISOString().slice(0, 10);
    // salon_bulk offs are written per-master; confirm the date is off for EVERY active master
    // so we never mislabel a single master's day-off as a whole-salon closure.
    const [offsRes, mastersRes] = await Promise.all([
      db
        .from("master_day_overrides")
        .select("date, master_id")
        .eq("note", "salon_bulk")
        .eq("kind", "off")
        .gte("date", fromIso)
        .lte("date", toIso),
      db.from("masters").select("id").eq("salon_id", salonId).eq("is_active", true),
    ]);
    const activeIds = new Set(((mastersRes as any).data as any[])?.map((m) => m.id) ?? []);
    if (activeIds.size === 0) return [];
    const byDate = new Map<string, Set<string>>();
    for (const r of ((offsRes as any).data as any[]) ?? []) {
      if (!activeIds.has(r.master_id)) continue;
      const set = byDate.get(r.date) ?? new Set<string>();
      set.add(r.master_id);
      byDate.set(r.date, set);
    }
    return [...byDate.entries()]
      .filter(([, set]) => set.size >= activeIds.size)
      .map(([date]) => date)
      .sort();
  } catch {
    return [];
  }
}

// Kept for tests / legacy: weekly-map based day-off guess. Superseded by isDayWorkableForService
// for live reason codes. working_hours is keyed mon..sun with values like "10:00–20:00"/"Выходной".
export function classifyEmptyDay(
  date: string,
  wh: Record<string, string> | null | undefined,
): "closed_that_day" | "fully_booked" {
  if (!wh) return "fully_booked"; // hours unknown → don't wrongly claim closed
  const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const v = wh[keys[dowOf(date)]];
  if (!v || /выход|closed|off|не\s*работ|дем\s*алыс|дэм\s*алыс|жабык/i.test(v)) {
    return "closed_that_day";
  }
  return "fully_booked";
}

// Clamp an AI-agreed price into the service's real [min, max]. Fixed-price services pin to
// their exact price; range services keep the agreed value but never below min / above max.
// Server-authoritative: the model cannot book a price outside what the salon configured.
export async function clampPriceOverride(
  db: AdminClient,
  salonId: string,
  serviceId: string,
  price: number,
): Promise<number> {
  if (!Number.isFinite(price)) return price;
  const { data } = await db
    .from("services")
    .select("price, price_max, price_type")
    .eq("salon_id", salonId)
    .eq("id", serviceId)
    .maybeSingle();
  if (!data) return price;
  const min = Number((data as any).price);
  if ((data as any).price_type !== "range") return Number.isFinite(min) ? min : price;
  const max = Number((data as any).price_max);
  let p = price;
  if (Number.isFinite(min)) p = Math.max(p, min);
  if (Number.isFinite(max)) p = Math.min(p, max);
  return p;
}

// THE single converter "requested clock time → real free slot". The server owns this:
// the LLM only passes date + HH:MM, and TS finds the exact matching slot in the live
// calendar. The model never supplies a timestamp — that was the 11:00→17:00 bug (a naive
// ...T11:00:00Z is 17:00 in UTC+6 Bishkek). A slot is booked ONLY if its own local time
// equals what the client asked for, so we can never silently move the client's time.
export async function resolveRequestedSlot(opts: {
  db: AdminClient;
  input: WaAgentInput;
  serviceId: string;
  masterId?: string | null;
  branchId?: string | null;
  date: string;
  time?: string | null;
  slotStartIso?: string | null; // legacy fallback, always re-validated against real slots
}): Promise<{
  ok: boolean;
  slotStart?: string;
  masterIds?: string[];
  nearest: string[];
  reason?: "slot_not_free" | "bad_time";
}> {
  const tz = opts.input.salon.timezone;
  const slots = await loadFreeSlotsForDay({
    db: opts.db,
    input: opts.input,
    serviceId: opts.serviceId,
    date: opts.date,
    masterId: opts.masterId ?? undefined,
    branchId: opts.branchId ?? undefined,
  });
  const nearest = slots.map((s) => formatTimeInTz(s.start, tz)).slice(0, 6);

  // Legacy path: model passed only an ISO. Accept ONLY if it matches a real free slot's
  // exact instant (blocks a fabricated / tz-shifted timestamp from being booked).
  if (opts.slotStartIso && !opts.time) {
    const target = new Date(opts.slotStartIso).getTime();
    const hit = slots.find((s) => new Date(s.start).getTime() === target);
    return hit
      ? { ok: true, slotStart: hit.start, masterIds: hit.master_ids, nearest }
      : { ok: false, nearest, reason: "slot_not_free" };
  }

  const hhmm = normHHMM(opts.time ?? "");
  if (!hhmm) return { ok: false, nearest, reason: "bad_time" };
  const hit = slots.find((s) => formatTimeInTz(s.start, tz) === hhmm);
  return hit
    ? { ok: true, slotStart: hit.start, masterIds: hit.master_ids, nearest }
    : { ok: false, nearest, reason: "slot_not_free" };
}

// Load the FULL list of free start-times for a service on a date (all masters merged, or a
// specific master). Used by both get_available_slots and check_time so both see the same
// authoritative, non-truncated calendar data. "today" excludes past times.
async function loadFreeSlotsForDay(opts: {
  db: AdminClient;
  input: WaAgentInput;
  serviceId: string;
  date: string;
  part?: "morning" | "afternoon" | "evening";
  masterId?: string | null;
  branchId?: string | null;
}): Promise<Awaited<ReturnType<typeof fetchMergedSlots>>> {
  const tz = opts.input.salon.timezone;
  const { isoLocalDate } = nowInTz(tz);
  const minStart = opts.date === isoLocalDate ? new Date() : undefined;
  let masters: DbMaster[];
  if (opts.masterId) {
    masters = [{ id: opts.masterId, name: "", branch_id: null, sort_order: 0, service_ids: [] }];
  } else {
    masters = await loadMastersForService(
      opts.db,
      opts.input.salon.salonId,
      opts.serviceId,
      opts.branchId ?? opts.input.selectedBranchId ?? null,
    );
  }
  if (masters.length === 0) return [];
  return fetchMergedSlots({
    db: opts.db,
    masters,
    serviceId: opts.serviceId,
    day: opts.date,
    tz,
    part: opts.part,
    minStartTime: minStart,
    limit: DAY_SLOT_CAP,
  });
}

export async function executeV4Tool(
  name: string,
  args: Record<string, any>,
  input: WaAgentInput,
  db: AdminClient,
  flags: V4RunFlags,
): Promise<any> {
  const tz = input.salon.timezone;
  const cutoffHours = input.config.manage_cutoff_hours ?? 0;
  const withinCutoff = (startsAt: string) =>
    cutoffHours > 0 &&
    new Date(startsAt).getTime() - Date.now() < cutoffHours * 60 * 60 * 1000;

  switch (name) {
    case "get_services": {
      const services = await loadAiVisibleServicesForSalon(db, input.salon.salonId);
      return {
        services: services.map((s: any) => {
          const isRange = s.price_type === "range";
          return {
            id: s.id,
            name: s.name,
            category: s.category,
            // Numeric bounds so the model never parses a price out of a string. For a range
            // service, any agreed price MUST stay within [price_min, price_max] (see the
            // price_override clamp on booking). For a fixed price, min == max.
            price_min: s.price,
            price_max: isRange ? s.price_max : s.price,
            price_type: s.price_type,
            price_label: isRange ? `${s.price}–${s.price_max} сом` : `${s.price} сом`,
            duration_min: s.duration_min,
          };
        }),
      };
    }

    case "get_masters": {
      const masters = await loadMastersForService(
        db,
        input.salon.salonId,
        args.service_id as string,
        (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
      );
      return {
        masters: masters.map((m) => ({
          id: m.id,
          name: m.name,
          // Specialization / short bio let the assistant recommend by strength ("по сложному
          // окрашиванию — Айгерим"). Trim bio so the tool payload stays small.
          specialization: m.specialization || null,
          bio_short: m.bio ? String(m.bio).slice(0, 200) : null,
        })),
      };
    }

    case "get_available_slots": {
      const part = args.part_of_day as "morning" | "afternoon" | "evening" | undefined;
      const commonArgs = {
        db,
        input,
        serviceId: args.service_id as string,
        date: args.date as string,
        masterId: (args.master_id as string) || undefined,
        branchId: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
      };
      let slots = await loadFreeSlotsForDay({ ...commonArgs, part });
      let reason: string;
      if (slots.length > 0) {
        reason = "ok";
      } else if (part) {
        // Part-of-day (утро/день/вечер) filter came back empty. Before saying "занято",
        // check the rest of the day: if the salon is open at other hours, this is NOT a full
        // day / day-off — it's just this part. Return those other times so the assistant offers
        // the SAME day instead of jumping to another date (scenario-3 bug).
        const daySlots = await loadFreeSlotsForDay({ ...commonArgs });
        if (daySlots.length > 0) {
          reason = "part_unavailable";
          slots = daySlots; // surface the day's other free times
        } else {
          // Whole day empty: is it a day-off (schedule) or a booked-out working day?
          reason = (await isDayWorkableForService(commonArgs))
            ? "fully_booked"
            : "closed_that_day";
        }
      } else {
        reason = (await isDayWorkableForService(commonArgs))
          ? "fully_booked"
          : "closed_that_day";
      }
      const times = slots.map((s) => formatTimeInTz(s.start, tz));
      const partRu =
        part === "morning" ? "утром" : part === "afternoon" ? "днём" : "вечером";
      return {
        date: args.date,
        reason, // ok | part_unavailable | closed_that_day | fully_booked
        // Full, non-truncated list of free start-times for this date. If a time is NOT here,
        // it is genuinely unavailable (booked or doesn't fit the service duration).
        free_times: times,
        slots: slots.map((s) => ({
          start: s.start,
          time: formatTimeInTz(s.start, tz),
          master_ids: s.master_ids,
        })),
        note:
          reason === "closed_that_day"
            ? "В этот день салон не работает (выходной). Предложи другой день — не говори «занято»."
            : reason === "fully_booked"
              ? "На эту дату всё занято. Предложи ближайший другой день."
              : reason === "part_unavailable"
                ? `${partRu.charAt(0).toUpperCase() + partRu.slice(1)} на эту дату свободных окошек нет, но в этот же день есть другое время (см. free_times). Предложи их — НЕ говори «всё занято» и не перескакивай на другой день.`
                : "Это ПОЛНЫЙ список свободных времён начала на эту дату. Клиенту покажи 2–4 удобно расставленных варианта, а не все подряд.",
      };
    }

    case "check_time": {
      // Definitive yes/no for a specific requested time (e.g. «17:00 барбы?»). Never guess —
      // this returns the truth from the calendar, plus nearby free times if it's taken.
      const hhmm = normHHMM(String(args.time ?? ""));
      if (!hhmm) return { available: false, error: "не понял время" };
      const slots = await loadFreeSlotsForDay({
        db,
        input,
        serviceId: args.service_id as string,
        date: args.date as string,
        masterId: (args.master_id as string) || undefined,
        branchId: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
      });
      const times = slots.map((s) => formatTimeInTz(s.start, tz));
      const hit = slots.find((s) => formatTimeInTz(s.start, tz) === hhmm);
      // Tell apart four cases so the assistant never falsely says «занято»:
      //  - ok            → time is free
      //  - closed_that_day → nobody works that date (day-off)
      //  - fully_booked  → working day, but no free slot at all
      //  - outside_hours → there ARE free slots, but the asked time is beyond the window
      //                    (past closing / service doesn't fit) — NOT booked
      //  - time_taken    → free slots exist on both sides, so the asked time is a real gap (booked)
      let reason: string;
      if (hit) {
        reason = "ok";
      } else if (slots.length === 0) {
        reason = (await isDayWorkableForService({
          db,
          input,
          serviceId: args.service_id as string,
          date: args.date as string,
          branchId: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
        }))
          ? "fully_booked"
          : "closed_that_day";
      } else {
        // HH:MM strings are zero-padded, so lexicographic compare == chronological.
        const outside = hhmm > times[times.length - 1] || hhmm < times[0];
        reason = outside ? "outside_hours" : "time_taken";
      }
      return {
        requested: hhmm,
        date: args.date,
        available: Boolean(hit),
        reason, // ok | time_taken | outside_hours | closed_that_day | fully_booked
        ...(hit ? { slot_start: hit.start, master_ids: hit.master_ids } : {}),
        nearby_free_times: times.slice(0, 8),
      };
    }

    case "create_appointment": {
      // Server owns the clock→instant conversion. The model passes date + HH:MM; we find the
      // matching real free slot. (Legacy: it may still pass slot_start — re-validated too.)
      const resolved = await resolveRequestedSlot({
        db,
        input,
        serviceId: args.service_id as string,
        masterId: args.master_id as string,
        branchId: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
        date: (args.date as string) ?? String(args.slot_start ?? "").slice(0, 10),
        time: (args.time as string) ?? null,
        slotStartIso: (args.slot_start as string) ?? null,
      });
      if (!resolved.ok) {
        return { success: false, reason: resolved.reason ?? "slot_not_free", nearest: resolved.nearest };
      }
      const rpcArgs: any = {
        _salon_id: input.salon.salonId,
        _master_id: args.master_id,
        _service_id: args.service_id,
        _starts_at: resolved.slotStart,
        _client_name: args.client_name,
        _client_phone: input.client.phone,
        _client_notes: null,
        _branch_id: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
        _addon_ids: [],
        _source: "ai_assistant",
      };
      if (args.price_override != null) {
        // Clamp the agreed price into the service's [min, max] range so the model can never
        // book below the floor or above the ceiling of a range-priced service.
        rpcArgs._price_override = await clampPriceOverride(
          db,
          input.salon.salonId,
          args.service_id as string,
          Number(args.price_override),
        );
      }
      const { data: newId, error } = await db.rpc("create_appointment", rpcArgs);
      if (error) return { success: false, error: error.message };
      flags.appointmentId = newId as string;
      if (args.branch_id) flags.selectedBranchId = args.branch_id as string;
      return { success: true, appointment_id: newId };
    }

    case "get_my_appointments": {
      const { data } = await db
        .from("appointments")
        .select("id, starts_at, services(name), masters(name)")
        .eq("salon_id", input.salon.salonId)
        .eq("client_phone", input.client.phone)
        .eq("status", "confirmed")
        .gte("starts_at", new Date().toISOString())
        .order("starts_at");
      return {
        appointments: (data ?? []).map((a: any) => ({
          id: a.id,
          service: a.services?.name ?? "?",
          master: a.masters?.name ?? "?",
          date: formatDateInTz(a.starts_at, tz),
          time: formatTimeInTz(a.starts_at, tz),
          starts_at: a.starts_at,
        })),
      };
    }

    case "cancel_appointment": {
      const { data: appt } = await db
        .from("appointments")
        .select("id, starts_at, client_phone")
        .eq("id", args.appointment_id)
        .eq("client_phone", input.client.phone)
        .maybeSingle();
      if (!appt) return { success: false, error: "not_found" };
      if (withinCutoff((appt as any).starts_at))
        return { success: false, error: "cutoff", cutoff_hours: cutoffHours };
      const { error } = await db
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", args.appointment_id)
        .eq("client_phone", input.client.phone);
      if (error) return { success: false, error: error.message };
      return { success: true };
    }

    case "reschedule_appointment": {
      const { data: appt } = await db
        .from("appointments")
        .select("id, starts_at, master_id, service_id, client_phone")
        .eq("id", args.appointment_id)
        .eq("client_phone", input.client.phone)
        .maybeSingle();
      if (!appt) return { success: false, error: "not_found" };
      if (withinCutoff((appt as any).starts_at))
        return { success: false, error: "cutoff", cutoff_hours: cutoffHours };
      const targetMaster = (args.new_master_id as string) || (appt as any).master_id;
      const resolved = await resolveRequestedSlot({
        db,
        input,
        serviceId: (appt as any).service_id,
        masterId: targetMaster,
        branchId: flags.selectedBranchId ?? null,
        date: (args.new_date as string) ?? String(args.new_slot_start ?? "").slice(0, 10),
        time: (args.new_time as string) ?? null,
        slotStartIso: (args.new_slot_start as string) ?? null,
      });
      if (!resolved.ok) {
        return { success: false, reason: resolved.reason ?? "slot_not_free", nearest: resolved.nearest };
      }
      const movingMaster =
        args.new_master_id && args.new_master_id !== (appt as any).master_id;
      const { error } = movingMaster
        ? await db.rpc("reschedule_appointment_v2" as any, {
            _appointment_id: args.appointment_id,
            _new_starts_at: resolved.slotStart,
            _new_master_id: args.new_master_id,
          } as any)
        : await db.rpc("reschedule_appointment" as any, {
            _appointment_id: args.appointment_id,
            _new_starts_at: resolved.slotStart,
          } as any);
      if (error) return { success: false, error: error.message };
      return { success: true };
    }

    case "escalate_to_human": {
      flags.needsHuman = true;
      flags.escalateReason = (args.reason as string) || "клиенту нужна помощь администратора";
      return { success: true, note: "Диалог помечен для живого администратора." };
    }

    case "remember_photo": {
      const note: PhotoNote = {
        ts: new Date().toISOString(),
        kind: String(args.kind ?? "other"),
        summary: String(args.summary ?? "").slice(0, 500),
        ...(args.service_hint ? { service_hint: String(args.service_hint).slice(0, 120) } : {}),
        ...(Array.isArray(args.issues) ? { issues: args.issues.map(String).slice(0, 6) } : {}),
        ...(Array.isArray(args.needs) ? { needs: args.needs.map(String).slice(0, 6) } : {}),
        ...(args.price_band ? { price_band: String(args.price_band).slice(0, 60) } : {}),
      };
      flags.photoNotes.push(note);
      return { success: true, note: "Разбор фото сохранён — вернётся тебе в контексте на след. ходах." };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ============================================================
// Agent loop
// ============================================================

// Does the reply already open with some greeting? Used to avoid double-greeting when we
// prepend the salon's template on first contact.
const REPLY_GREETING_RE =
  /^\s*(здрав|привет|добр|салам|саламат|ассал|ваалейкум|hello|hi\b|hey\b)/iu;

// Guarantee the client never sees markdown or a numbered/bulleted "menu", no matter how the
// model formats its answer. The prompt forbids both, but LLMs reliably slip into "1. …\n2. …"
// and **bold** the moment they compare two options — and WhatsApp doesn't render ** anyway, so
// it would show up as literal asterisks. This strips markdown emphasis and rewrites list items
// into flowing prose (the owner's explicit requirement: no "1./2./3." and no menus).
export function humanizeReply(raw: string): string {
  let t = (raw ?? "").replace(/\r\n/g, "\n");
  // Markdown emphasis / code / headings that WhatsApp doesn't render.
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1"); // **bold**
  t = t.replace(/__([^_]+)__/g, "$1"); // __bold__
  t = t.replace(/`+([^`]+)`+/g, "$1"); // `code`
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // # heading
  // Collapse list items (ordered or bulleted) into a single flowing paragraph so it reads like
  // a person talking, not a menu. A run of adjacent list lines is joined with a space.
  const listRe = /^\s*(?:\d{1,2}[.)]|[-*•·▪‣]|—)\s+/;
  const lines = t.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) {
      out.push(buffer.join(" "));
      buffer = [];
    }
  };
  for (const line of lines) {
    if (listRe.test(line)) buffer.push(line.replace(listRe, "").trim());
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runWaAgentV4(input: WaAgentInput): Promise<WaAgentResult> {
  const db = await getAdmin();
  const apiKey = process.env.GEMINI_API_KEY ?? "";

  const debug: WaAgentResult["debug"] = { actions: [], errors: [] };
  const priorPhotoNotes: PhotoNote[] = Array.isArray((input.stateData as any).photo_notes)
    ? ((input.stateData as any).photo_notes as PhotoNote[])
    : [];
  const flags: V4RunFlags = {
    appointmentId: null,
    selectedBranchId: input.selectedBranchId,
    needsHuman: false,
    escalateReason: null,
    photoNotes: [...priorPhotoNotes],
  };

  const v4History: GeminiV2Content[] = ((input.stateData as any).v4_history ??
    []) as GeminiV2Content[];
  const isFirstTurn = v4History.length === 0;

  // Language: sticky from state, BUT refresh whenever THIS turn carries a confident signal.
  // Without the refresh, one early "ru" detection stuck forever — so a fully Kyrgyz booking
  // dialog still got Russian fallback/error messages (as seen in real screenshots). A confident
  // signal in the current text (Kyrgyz letters/words, or plain Latin) always wins over the
  // sticky value; only when the turn is ambiguous do we keep what we had.
  const lastText = input.lastMessages
    .map((m) => m.text_body ?? "")
    .filter(Boolean)
    .join(" ");
  const stickyLang = input.stateData.language as "ru" | "ky" | "en" | undefined;
  const language: "ru" | "ky" | "en" = confidentLanguage(lastText)
    ? detectLanguage(lastText)
    : (stickyLang ?? detectLanguage(lastText));

  // ---- Build user parts (text + inline images)
  const clientParts: any[] = [];
  for (const m of input.lastMessages) {
    if (m.kind === "image" && m.media_signed_url) {
      try {
        const r = await fetch(m.media_signed_url);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          const base64 =
            typeof Buffer !== "undefined"
              ? Buffer.from(ab).toString("base64")
              : (() => {
                  const bytes = new Uint8Array(ab);
                  let bin = "";
                  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                  return btoa(bin);
                })();
          if (m.text_body) clientParts.push({ text: m.text_body });
          clientParts.push({
            inlineData: { mimeType: m.media_mime ?? "image/jpeg", data: base64 },
          });
        } else if (m.text_body) {
          clientParts.push({ text: m.text_body });
        }
      } catch (e: any) {
        debug.errors.push(`image_fetch: ${e?.message ?? String(e)}`);
        if (m.text_body) clientParts.push({ text: m.text_body });
      }
    } else if (m.text_body) {
      clientParts.push({ text: m.text_body });
    }
  }

  if (clientParts.length === 0) {
    return {
      reply: "",
      nextState: (input.state === "done" ? "done" : "collecting") as WaAgentState,
      nextStateData: input.stateData,
      appointmentId: null,
      selectedBranchId: flags.selectedBranchId,
      debug,
    };
  }

  const closedDates = await loadSalonClosedDates(
    db,
    input.salon.salonId,
    nowInTz(input.salon.timezone).isoLocalDate,
    14,
  );
  const systemPrompt = buildSystemPromptV4(input, closedDates);
  const contents: GeminiV2Content[] = [...v4History, { role: "user", parts: clientParts }];

  // One agentic pass: loop tool-calls until the model returns a plain-text reply. Mutates
  // `contents`, `debug` and `flags`. Returned separately so we can run a second pass if the
  // model stalls (see below).
  const runToolLoop = async (): Promise<string> => {
    let r = "";
    for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
      const res = await callGeminiTools({
        apiKey,
        systemInstruction: systemPrompt,
        contents,
        tools: V4_TOOL_DECLARATIONS,
      });

      if (!res.ok || !res.parts) {
        debug.errors.push(`gemini_tools iter${iter}: ${res.error ?? "no parts"}`);
        r =
          language === "ky"
            ? "Кечиресиз, техникалык ката болду. Бир аздан кийин кайра жазыңызчы 🙏"
            : language === "en"
              ? "Sorry, a technical error occurred. Please write again in a moment 🙏"
              : "Извините, произошла техническая ошибка. Напишите, пожалуйста, чуть позже 🙏";
        break;
      }

      contents.push({ role: "model", parts: res.parts });
      const functionCalls = res.parts.filter((p: any) => p.functionCall);
      const textPart = res.parts.find((p: any) => typeof p.text === "string" && p.text.trim());

      if (functionCalls.length === 0) {
        r = textPart?.text?.trim() ?? "";
        break;
      }

      const toolResults: any[] = [];
      for (const part of functionCalls) {
        const { name, args } = part.functionCall as { name: string; args: Record<string, any> };
        debug.actions.push(`tool:${name}`);
        try {
          const result = await executeV4Tool(name, args ?? {}, input, db, flags);
          toolResults.push({ functionResponse: { name, response: result } });
        } catch (e: any) {
          debug.errors.push(`tool_${name}: ${e?.message ?? String(e)}`);
          toolResults.push({
            functionResponse: { name, response: { error: e?.message ?? "failed" } },
          });
        }
      }
      contents.push({ role: "user", parts: toolResults });
    }
    return r;
  };

  let reply = await runToolLoop();

  // The client must NEVER see "сейчас проверю, подождите" and then silence. The model must do
  // all tool work silently and answer with the finished result. If it instead emits a bare
  // "wait/checking" message without answering, the turn would end and leave the client hanging
  // (we send one message per webhook turn). Detect that stall and force a second pass that must
  // finish the job in the same turn. Fires on ANY such stall, regardless of which tools ran.
  const STALL_RE =
    /(сейчас\s+(проверю|гляну|узна|посмотрю)|проверю\s+(распис|кален|свобод|нали)|секундоч|минуточ|минутку|подожд|ожидайте|одну\s+секунд|азыр\s+(текшер|кара)|текшерип\s+көр|күтө\s+тур|бир\s+аз\s+күт|let me check|checking the|one moment|hold on|bear with)/i;
  if (reply && STALL_RE.test(reply)) {
    debug.errors.push("stall_detected_forcing_completion");
    contents.push({
      role: "user",
      parts: [
        {
          text: "СИСТЕМА: НЕ пиши «подожди», «сейчас проверю», «минуточку». Прямо сейчас молча вызови все нужные инструменты (get_available_slots / check_time / get_services и т.п.) и пришли клиенту ГОТОВЫЙ ответ одним сообщением. Если инструмент вернул ошибку — вежливо извинись и предложи попробовать позже или передать администратору.",
        },
      ],
    });
    const retry = await runToolLoop();
    if (retry) reply = retry;
    // Still stalling after the nudge → never leave the client hanging: send a graceful,
    // deterministic message instead of a bare "подождите".
    if (!reply || STALL_RE.test(reply)) {
      debug.errors.push("stall_persisted_using_fallback");
      reply =
        language === "ky"
          ? "Кечиресиз, азыр маалыматты ала алган жокмын. Бир аздан кийин кайра жазып көрүңүз, же сурооңузду администраторго өткөрүп берейин."
          : language === "en"
            ? "Sorry, I couldn't fetch the data just now. Please try again in a minute, or I can pass your request to the salon admin."
            : "К сожалению, сейчас не удалось получить данные. Попробуйте, пожалуйста, ещё раз через минуту — или я передам ваш запрос администратору.";
    }
  }

  if (!reply) {
    debug.errors.push("no text reply after tool loop");
    reply =
      language === "ky"
        ? "Кечиресиз, дагы бир жолу жазыңызчы."
        : "Извините, напишите, пожалуйста, ещё раз.";
  }

  // Strip markdown and any numbered/bulleted menu the model may have produced (see humanizeReply).
  reply = humanizeReply(reply);

  // First contact: the salon's configured greeting template ALWAYS opens the conversation
  // (owner requirement) — prepend it unless the model already greeted with it.
  const greeting = input.config.greeting?.trim();
  if (isFirstTurn && greeting && !reply.includes(greeting) && !REPLY_GREETING_RE.test(reply)) {
    reply = `${greeting}\n\n${reply}`;
  }

  // Persist Gemini history without inline images (keep the DB row small).
  const historyToSave = contents.slice(-HISTORY_CAP).map((c) => ({
    ...c,
    parts: c.parts.map((p: any) => (p.inlineData ? { text: "[фото]" } : p)),
  }));

  const nextState: WaAgentState = flags.appointmentId ? "done" : "collecting";
  const nextStateData: WaAgentStateData = {
    language,
    greeted: true,
    ...(flags.needsHuman ? { needs_human: true } : {}),
    ...({ v4_history: historyToSave } as any),
    // Keep the most recent photo analyses so a follow-up ("а сколько за это?") a turn later
    // still has the master's read of the image even though the pixels are gone.
    ...(flags.photoNotes.length ? ({ photo_notes: flags.photoNotes.slice(-PHOTO_NOTES_CAP) } as any) : {}),
  };

  // On escalation, hand the webhook a plain-text alert for the salon admin's own WhatsApp
  // (owner_notify_phone). Includes the client's number so the admin can jump straight in.
  const notifyAdminText = flags.needsHuman
    ? (() => {
        const t = nowInTz(input.salon.timezone);
        const when = `${t.humanDate}, ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
        // Компактная история последних реплик (клиент/админ), фото помечаем как [фото].
        const historyLines = contents
          .map((c: any) => {
            const txt = (c.parts ?? [])
              .map((p: any) => (p.inlineData ? "[фото]" : (p.text ?? "")))
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            return txt ? `${c.role === "model" ? "Админ" : "Клиент"}: ${txt.slice(0, 180)}` : "";
          })
          .filter(Boolean)
          .slice(-6)
          .join("\n");
        return (
          `🔔 ИИ-администратор передаёт вам диалог — нужна ваша помощь.\n` +
          `👤 Клиент: +${input.client.phone}${input.client.name ? ` (${input.client.name})` : ""}\n` +
          `📌 Причина: ${flags.escalateReason ?? "нужна помощь"}\n` +
          `🕒 Время: ${when}\n\n` +
          (historyLines ? `💬 Последние сообщения:\n${historyLines}\n\n` : "") +
          `Откройте WhatsApp и ответьте клиенту — бот на паузе.`
        );
      })()
    : undefined;

  return {
    reply,
    nextState,
    nextStateData,
    appointmentId: flags.appointmentId,
    selectedBranchId: flags.selectedBranchId,
    debug,
    ...(notifyAdminText ? { notifyAdminText } : {}),
  };
}
