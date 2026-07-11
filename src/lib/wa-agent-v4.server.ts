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
import { BEAUTY_KNOWLEDGE_BASE } from "@/lib/wa-beauty-knowledge";

type AdminClient = Awaited<ReturnType<typeof getAdmin>>;
async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const MAX_TOOL_ITERS = 8;
const HISTORY_CAP = 30; // Gemini contents kept in state_data.v4_history between turns
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

function buildSystemPromptV4(input: WaAgentInput): string {
  const { salon, config, branches, salonInfo } = input;
  const { isoLocalDate, humanDate, hour, minute } = nowInTz(salon.timezone);
  const dates = buildDateMap(salon.timezone, 14)
    .map((d) => `${d.iso} = ${d.relative} (${d.label})`)
    .join("\n");
  const hours = renderWorkingHours(salonInfo?.working_hours);
  const langs = (config.languages?.length ? config.languages : ["ru"]).join(", ");
  const cutoff = config.manage_cutoff_hours ?? 0;

  const lines: string[] = [
    `Ты — старший мастер-консультант и администратор салона красоты «${salon.salonName}» с 20+ годами практики во всех бьюти-услугах (кератин, ботокс и нанопластика для волос, окрашивания и осветления, стрижки, уходы, маникюр и педикюр, брови и ресницы). Клиент пишет тебе в WhatsApp. Твоя задача — вести себя как живой опытный администратор, которого невозможно отличить от человека.`,
    ``,
    `ФОРМАТ (СТРОГО): только сплошной связный текст. ЗАПРЕЩЕНЫ списки, пункты, нумерация «1.» «2.» «3.», маркеры «-»/«•» и любой markdown (никаких ** и #). Даже сравнивая две процедуры — пиши обычными предложениями, а не списком. Неправильно: «1. Ботокс… 2. Кератин…». Правильно: «Ботокс — про восстановление и блеск, а кератин — про гладкость. После осветления я бы начала с ботокса.»`,
    `ДЛИНА (ВАЖНО): пиши коротко, как человек в чате. Обычно 1–3 коротких предложения. Если достаточно одного предложения — отвечай одним. Длинные объяснения дроби на короткие мысли, не строчи «простынёй».`,
    `Тепло и по-человечески, без канцелярита. Эмодзи — максимум один на сообщение (часто лучше без). Никогда не говори, что ты бот, ИИ или ассистент.`,
    `Отвечай на языке клиента (языки салона: ${langs}). Кыргызский узнавай по «салам», «кандай», «канча», «болобу», «жасайсыз», «бүгүн», «эртең», «эже», «байке», буквам ң/ү/ө; в т.ч. латиницей. Не смешивай языки в одном сообщении.`,
    config.tone_instructions
      ? `ОБЯЗАТЕЛЬНЫЕ правила тона от салона: ${config.tone_instructions}`
      : "",
    ``,
    `СЕГОДНЯ: ${humanDate} (${isoLocalDate}), время ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${salon.timezone}).`,
    `ТАБЛИЦА ДАТ (перевод «завтра», «в пятницу», «бүгүнкүгө» в YYYY-MM-DD):`,
    dates,
    ``,
    `ИНФОРМАЦИЯ О САЛОНЕ:`,
    salonInfo?.address ? `Адрес: ${salonInfo.address}` : "",
    hours ? `Часы работы: ${hours}` : "",
    branches.length > 1
      ? `Филиалы:\n${branches.map((b) => `- ${b.name}${b.address ? ` (${b.address})` : ""} [id: ${b.id}]`).join("\n")}`
      : "",
    config.knowledge_base
      ? `ФАКТЫ ОБ ЭТОМ САЛОНЕ (правила, гарантия, материалы, для детей, акции — используй их естественно, когда уместно):\n${config.knowledge_base}`
      : "",
    config.client_addressing?.trim()
      ? `КАК К ТЕБЕ ОБРАЩАЮТСЯ КЛИЕНТЫ: ${config.client_addressing.trim().replace(/\s*\n\s*/g, ", ")}. Если клиент пишет одно из этих слов (или похожее обращение) — он обращается ИМЕННО К ТЕБЕ, администратору. Не переспрашивай «к кому вы обращаетесь?» и не проси уточнить — просто продолжай диалог естественно. Сам эти слова в ответах использовать не обязан.`
      : "",
    ``,
    `ТВОЯ ЭКСПЕРТНАЯ БАЗА ЗНАНИЙ (общие знания о процедурах для консультации, это НЕ прайс салона):`,
    BEAUTY_KNOWLEDGE_BASE,
    ``,
    `ТЫ КОНСУЛЬТАНТ, А НЕ ОФОРМИТЕЛЬ ЗАПИСЕЙ:`,
    `- НЕ вываливай список услуг на первое сообщение. Сначала пойми, что человеку нужно.`,
    `- Если запрос неполный — задай 1 короткий уточняющий вопрос (какие волосы, длина, что не устраивает, красились/осветлялись ли). Не заваливай вопросами.`,
    `- Сам определи подходящую процедуру и коротко объясни выбор. Отвечай на вопросы о процедурах из базы: кому подходит, противопоказания, отличия, сроки, уход, совместимость.`,
    `- Темп: не дави записью и не спеши закончить. Сними сомнения и возражения (цена, «испорчу волосы», «подумаю»), и лишь когда клиент определился — ненавязчиво предложи подобрать время.`,
    ``,
    `КОРОТКИЕ И РАЗГОВОРНЫЕ СООБЩЕНИЯ — понимай их как живой админ (примеры):`,
    `- «Канча болот?», «Канчадан кератин жасайсыздар?», «Канчадар», «Сколько? Примерно» → спрашивают цену. Для range-услуги назови вилку из get_services и предложи прислать фото для точной оценки.`,
    `- «Кератин 2500 болобу э», «за 2500 сделаете?» → называют свою цифру. Сверься с get_services: если попадает в вилку — подтверди мягко, если ниже — тактично объясни реальную вилку, не споря.`,
    `- «Кератин зыяндуулугу кандай», «вредно ли» → вопрос о вреде/безопасности: ответь коротко и честно из базы знаний.`,
    `- «Бүгүнкүгө барбы окошко?», «на сегодня есть окошко?», «Саат 17:00?» → спрашивают о свободном времени/конкретном часе: если услуга ясна — вызови get_available_slots и ответь; если не ясна — уточни услугу одним вопросом.`,
    `- «Макул, азыр таштаймын», «сейчас скину» → клиент сейчас пришлёт фото: коротко подтверди («Хорошо, жду фото 🙂») и жди следующего сообщения.`,
    `- «Менин эки кызымдыкы тармал, 16–18 жашта» → консультация по детям/нескольким людям: учти возраст и факты салона (напр. детский возраст, длительность), уточни детали при необходимости.`,
    `- ФОТО БЕЗ ТЕКСТА → это почти всегда волосы/ногти для оценки. Оцени по фото (см. ниже) для обсуждаемой услуги; если услуга ещё не ясна — коротко спроси, что хочет сделать.`,
    ``,
    `ОЦЕНКА СТОИМОСТИ ПО ФОТО — работай как мастер с 20-летним опытом, а НЕ выдавай среднее число:`,
    `- Сначала узнай вилку услуги из get_services (price_type=range даёт минимум и максимум). Оценка обязана лежать внутри этой вилки.`,
    `- Определяй цену по тому, что видно на фото: длина волос, густота, объём, степень повреждения и пористость, следы прошлых окрашиваний/осветлений, сложность работы, предполагаемый расход состава и время работы мастера. Короткие/тонкие волосы — ближе к нижней границе; длинные/густые/повреждённые — ближе к верхней.`,
    `- Назови УЗКИЙ диапазон (в идеале шириной ~200–500 сом), а не всю вилку и не ровную середину. Говори как живой мастер, естественно. Пример стиля: «Ийинден болсо 3200–3700 эсептесеңиз болот, эже» / «По фото где-то 3200–3500 сом получится».`,
    `- Всегда добавляй, что точную цену мастер подтвердит на месте (волосы вживую видно точнее).`,
    config.pricing_rules ? `- Правила оценки от салона (учитывай их): ${config.pricing_rules}` : "",
    ``,
    `ЦЕНЫ, УСЛУГИ, ВРЕМЯ, МАСТЕРА — только из инструментов:`,
    `- Перед тем как назвать цену или записать — вызови get_services и опирайся на реальные названия/цены. Услуги, слоты, имена мастеров НЕ выдумывай.`,
    `- Если нужной процедуры в салоне нет — честно скажи и предложи ближайшую из имеющихся.`,
    ``,
    `КОГДА КЛИЕНТ ГОТОВ ЗАПИСАТЬСЯ (не раньше):`,
    branches.length > 1 ? `- Если филиал не выбран — уточни, куда удобнее.` : "",
    `- РАБОТА С КАЛЕНДАРЁМ (СТРОГО): о свободном времени говори ТОЛЬКО по данным инструментов, никогда не угадывай. Спросил про день — вызови get_available_slots на эту дату. Клиент назвал КОНКРЕТНЫЙ час («17:00 барбы?») — вызови check_time на эту дату и час и ответь по факту. НИКОГДА не говори, что время занято, пока не проверил его инструментом; если инструмент показал время свободным — оно свободно.`,
    `- get_available_slots возвращает ПОЛНЫЙ список свободных времён начала на дату (учитывает длительность процедуры и занятость). Если времени там нет — оно занято или не помещается по длительности.`,
    `- Клиенту показывай не весь список, а 2–4 удобно РАЗНЕСЁННЫХ варианта (например утро, день, вечер), а не подряд через 15 минут. Пример: «Есть 10:00, 13:00 и 16:00 — что удобнее?»`,
    `- Мастеров несколько и клиенту важно — предложи выбор (get_masters); «всё равно» — выбери сам.`,
    `- Узнай имя (если не знаешь), повтори детали одной фразой (услуга, дата, время, мастер, цена) и дождись явного «да». Только тогда вызови create_appointment, коротко поздравь и напомни адрес.`,
    `- НИКОГДА не пиши «сейчас проверю», «подождите», «минуточку». У тебя один ответ за ход: сразу вызови инструменты и дай готовый ответ (свободное время, либо что времени нет, либо что не получилось получить расписание). Диалог не должен обрываться на «подождите».`,
    ``,
    `УПРАВЛЕНИЕ ЗАПИСЬЮ: «отменить/перенести» → get_my_appointments, уточни какую, подтверди «да», затем cancel_appointment / reschedule_appointment (для переноса сперва подбери время).`,
    cutoff > 0
      ? `Если до визита меньше ${cutoff} ч — отмена/перенос через чат невозможны, попроси позвонить в салон.`
      : "",
    ``,
    `ЖЕЛЕЗНЫЕ ПРАВИЛА:`,
    `- Не выдумывай факты. Если не уверен в ответе или вопрос сложный/нестандартный — лучше передай администратору, чем сочини.`,
    `- Здоровье и противопоказания (беременность, аллергии, болезни/ранки кожи головы, лекарства): дай общую инфу из базы, но без диагнозов и без медицинских гарантий; порекомендуй очную оценку мастера или врача.`,
    `- Не обещай «100%» результат и не преувеличивай сроки.`,
    `- create_appointment — только после явного «да» («да», «записывайте», «ооба», «макул»).`,
    `- slot_taken → извинись, что время заняли, предложи другое.`,
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
    description: "Мастера, выполняющие услугу.",
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
    description: "Свободные слоты на дату (до 8 ближайших).",
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
      "Создать запись. Вызывать ТОЛЬКО после явного «да» клиента на озвученные детали.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        master_id: { type: "string" },
        slot_start: { type: "string", description: "ISO start из get_available_slots" },
        client_name: { type: "string" },
        branch_id: { type: "string" },
        price_override: { type: "number", description: "Согласованная цена для range-услуг" },
      },
      required: ["service_id", "master_id", "slot_start", "client_name"],
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
      "Перенести запись на новое время (и при необходимости к другому мастеру). Только после явного подтверждения.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        new_slot_start: { type: "string", description: "ISO start из get_available_slots" },
        new_master_id: { type: "string", description: "Только если мастер меняется" },
      },
      required: ["appointment_id", "new_slot_start"],
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
];

// ============================================================
// Tool executor — deterministic TS against the DB
// ============================================================

type V4RunFlags = {
  appointmentId: string | null;
  selectedBranchId: string | null;
  needsHuman: boolean;
  escalateReason: string | null;
};

// Slot must still be free for this exact master at this exact start — get_available_slots
// is the same RPC the calendar uses, so this is the authoritative availability check.
async function isSlotStillFree(
  db: AdminClient,
  masterId: string,
  serviceId: string,
  slotStartIso: string,
): Promise<boolean> {
  const day = slotStartIso.slice(0, 10);
  const { data } = await db.rpc("get_available_slots", {
    _master_id: masterId,
    _service_id: serviceId,
    _date: day,
  });
  const target = new Date(slotStartIso).getTime();
  return (data ?? []).some((s: any) => new Date(s.slot_start).getTime() === target);
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

async function executeV4Tool(
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
        services: services.map((s: any) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          price:
            s.price_type === "range" ? `${s.price}–${s.price_max} сом` : `${s.price} сом`,
          price_type: s.price_type,
          duration_min: s.duration_min,
        })),
      };
    }

    case "get_masters": {
      const masters = await loadMastersForService(
        db,
        input.salon.salonId,
        args.service_id as string,
        (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
      );
      return { masters: masters.map((m) => ({ id: m.id, name: m.name })) };
    }

    case "get_available_slots": {
      const slots = await loadFreeSlotsForDay({
        db,
        input,
        serviceId: args.service_id as string,
        date: args.date as string,
        part: args.part_of_day as any,
        masterId: (args.master_id as string) || undefined,
        branchId: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
      });
      const times = slots.map((s) => formatTimeInTz(s.start, tz));
      return {
        date: args.date,
        // Full, non-truncated list of free start-times for this date. If a time is NOT here,
        // it is genuinely unavailable (booked or doesn't fit the service duration).
        free_times: times,
        slots: slots.map((s) => ({
          start: s.start,
          time: formatTimeInTz(s.start, tz),
          master_ids: s.master_ids,
        })),
        note:
          slots.length === 0
            ? "На эту дату свободного времени нет."
            : "Это ПОЛНЫЙ список свободных времён начала на эту дату. Клиенту покажи 2–4 удобно расставленных варианта, а не все подряд.",
      };
    }

    case "check_time": {
      // Definitive yes/no for a specific requested time (e.g. «17:00 барбы?»). Never guess —
      // this returns the truth from the calendar, plus nearby free times if it's taken.
      const m = String(args.time ?? "").match(/(\d{1,2})[:.\s]*(\d{2})?/);
      if (!m) return { available: false, error: "не понял время" };
      const hhmm = `${String(Number(m[1])).padStart(2, "0")}:${m[2] ?? "00"}`;
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
      return {
        requested: hhmm,
        date: args.date,
        available: Boolean(hit),
        ...(hit ? { slot_start: hit.start, master_ids: hit.master_ids } : {}),
        nearby_free_times: times.slice(0, 8),
      };
    }

    case "create_appointment": {
      const free = await isSlotStillFree(
        db,
        args.master_id as string,
        args.service_id as string,
        args.slot_start as string,
      );
      if (!free) return { success: false, error: "slot_taken" };
      const rpcArgs: any = {
        _salon_id: input.salon.salonId,
        _master_id: args.master_id,
        _service_id: args.service_id,
        _starts_at: args.slot_start,
        _client_name: args.client_name,
        _client_phone: input.client.phone,
        _client_notes: null,
        _branch_id: (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
        _addon_ids: [],
        _source: "ai_assistant",
      };
      if (args.price_override != null) rpcArgs._price_override = args.price_override;
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
      const free = await isSlotStillFree(
        db,
        targetMaster,
        (appt as any).service_id,
        args.new_slot_start as string,
      );
      if (!free) return { success: false, error: "slot_taken" };
      const movingMaster =
        args.new_master_id && args.new_master_id !== (appt as any).master_id;
      const { error } = movingMaster
        ? await db.rpc("reschedule_appointment_v2" as any, {
            _appointment_id: args.appointment_id,
            _new_starts_at: args.new_slot_start,
            _new_master_id: args.new_master_id,
          } as any)
        : await db.rpc("reschedule_appointment" as any, {
            _appointment_id: args.appointment_id,
            _new_starts_at: args.new_slot_start,
          } as any);
      if (error) return { success: false, error: error.message };
      return { success: true };
    }

    case "escalate_to_human": {
      flags.needsHuman = true;
      flags.escalateReason = (args.reason as string) || "клиенту нужна помощь администратора";
      return { success: true, note: "Диалог помечен для живого администратора." };
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
  const flags: V4RunFlags = {
    appointmentId: null,
    selectedBranchId: input.selectedBranchId,
    needsHuman: false,
    escalateReason: null,
  };

  const v4History: GeminiV2Content[] = ((input.stateData as any).v4_history ??
    []) as GeminiV2Content[];
  const isFirstTurn = v4History.length === 0;

  // Language: keep the sticky one from state, refresh on a confident signal in this turn's text.
  const lastText = input.lastMessages
    .map((m) => m.text_body ?? "")
    .filter(Boolean)
    .join(" ");
  const language: "ru" | "ky" | "en" =
    (input.stateData.language as any) ?? detectLanguage(lastText);

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

  const systemPrompt = buildSystemPromptV4(input);
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

  // Bug fix: the model sometimes answers «сейчас проверю расписание, подождите» WITHOUT calling
  // any tool, then the turn ends — and since we send exactly one message per webhook turn, the
  // client is left hanging forever. If the reply is such a stall and no calendar/booking tool
  // actually ran, force one more pass that must finish the job in the same turn.
  const STALL_RE =
    /(сейчас проверю|проверю распис|проверю кален|секундоч|минуточ|подожд|ожидайте|одну мин|бир аз(ыраак)?|азыр текшер|текшерип көр|күтө тур|check(ing)? the schedule|one moment|hold on|let me check)/i;
  const didCalendarWork = debug.actions.some(
    (a) =>
      a.startsWith("tool:get_available_slots") ||
      a.startsWith("tool:check_time") ||
      a.startsWith("tool:create_appointment"),
  );
  if (reply && STALL_RE.test(reply) && !didCalendarWork) {
    debug.errors.push("stall_detected_forcing_completion");
    contents.push({
      role: "user",
      parts: [
        {
          text: "СИСТЕМА: не пиши «подожди» или «сейчас проверю». Прямо сейчас вызови нужные инструменты (get_available_slots или check_time) и дай клиенту конкретный ответ одним сообщением — свободное время, либо что времени нет.",
        },
      ],
    });
    const retry = await runToolLoop();
    if (retry) reply = retry;
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
  };

  // On escalation, hand the webhook a plain-text alert for the salon admin's own WhatsApp
  // (owner_notify_phone). Includes the client's number so the admin can jump straight in.
  const notifyAdminText = flags.needsHuman
    ? `🔔 ИИ-администратор передаёт вам диалог с клиентом (+${input.client.phone}${input.client.name ? `, ${input.client.name}` : ""}).\nПричина: ${flags.escalateReason ?? "нужна помощь"}.\nОткройте WhatsApp и ответьте клиенту — бот на паузе.`
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
