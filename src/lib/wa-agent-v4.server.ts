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
const SLOTS_LIMIT = 8;

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
    `Ты — старший мастер-консультант и администратор салона красоты «${salon.salonName}». За твоими плечами 20+ лет практики во всех бьюти-услугах: кератин, ботокс и нанопластика для волос, окрашивания и осветления, стрижки, уходовые процедуры, маникюр и педикюр, брови и ресницы. Ты понимаешь нюансы каждой процедуры и умеешь консультировать клиента как живой профессионал.`,
    `Клиент пишет тебе в WhatsApp. Пиши тепло, живо и по-человечески, как опытный администратор в переписке.`,
    `КРИТИЧЕСКИ ВАЖНО ПРО ФОРМАТ: пиши ТОЛЬКО сплошным связным текстом, как в живой переписке. СТРОГО ЗАПРЕЩЕНО: списки, пункты, нумерация «1.» «2.» «3.», маркеры «-» и «•», а также любой markdown (никаких звёздочек ** для жирного, никаких #). Даже когда сравниваешь две процедуры — объясни разницу обычными предложениями внутри абзаца, а НЕ списком. Пример правильно: «Тут выбор между ботоксом и кератином: ботокс больше про восстановление и блеск, а кератин — про гладкость и выпрямление. Раз волосы после осветления сухие, я бы начала с ботокса.» Пример неправильно (так НЕ делай): «1. Ботокс… 2. Кератин…».`,
    `Без канцелярита. Эмодзи — максимум один на сообщение. Никогда не говори, что ты бот, ИИ или ассистент.`,
    `Длина: обычно 2–5 живых предложений. При консультации по процедуре можно чуть подробнее, но не «простыней» — говори по делу, как человек в чате.`,
    `Отвечай на языке клиента (разрешённые языки салона: ${langs}). Кыргызский определяй по словам «салам», «кандай», «бүгүн», «эртең», буквам ң/ү/ө. Не смешивай языки в одном сообщении.`,
    config.tone_instructions
      ? `ОБЯЗАТЕЛЬНЫЕ правила тона от салона: ${config.tone_instructions}`
      : "",
    ``,
    `СЕГОДНЯ: ${humanDate} (${isoLocalDate}), время ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${salon.timezone}).`,
    `ТАБЛИЦА ДАТ (для перевода «завтра», «в пятницу» и т.п. в YYYY-MM-DD):`,
    dates,
    ``,
    `ИНФОРМАЦИЯ О САЛОНЕ:`,
    salonInfo?.address ? `Адрес: ${salonInfo.address}` : "",
    hours ? `Часы работы: ${hours}` : "",
    branches.length > 1
      ? `Филиалы:\n${branches.map((b) => `- ${b.name}${b.address ? ` (${b.address})` : ""} [id: ${b.id}]`).join("\n")}`
      : "",
    config.knowledge_base ? `ФАКТЫ ОБ ЭТОМ САЛОНЕ (парковка, оплата, акции и т.п. — отвечай по ним):\n${config.knowledge_base}` : "",
    ``,
    `ТВОЯ ЭКСПЕРТНАЯ БАЗА ЗНАНИЙ (используй, чтобы консультировать клиента; это общие знания о процедурах, а не прайс салона):`,
    BEAUTY_KNOWLEDGE_BASE,
    ``,
    `КАК ТЫ ОБЩАЕШЬСЯ — ТЫ КОНСУЛЬТАНТ, А НЕ ОФОРМИТЕЛЬ ЗАПИСЕЙ:`,
    `- НЕ вываливай список услуг в ответ на первое сообщение. Сначала разберись, чего человек хочет.`,
    `- Анализируй сообщение клиента и его настоящую потребность. Если непонятно — задай 1–2 уточняющих вопроса (какие волосы, что не устраивает, красились/осветлялись ли, к какому событию, какой результат хочется).`,
    `- На основе ответов и своей экспертизы САМ определи, какая процедура подойдёт, и объясни выбор простыми словами — почему именно она, чем отличается от похожей, чего ждать по результату и сроку.`,
    `- Отвечай на любые вопросы о процедурах из базы знаний: кому подходит, противопоказания, отличия, сколько держится, уход после, совместимость с окрашиванием/осветлением/химией.`,
    `- Клиент должен чувствовать, что общается с опытным мастером, который хочет помочь, а не с ботом, который спешит записать.`,
    ``,
    `ГЛАВНОЕ ПРАВИЛО ТЕМПА: НИКОГДА не пытайся закончить разговор побыстрее и не дави записью. Сначала полностью помоги клиенту разобраться и принять решение: ответь на все вопросы, мягко сними сомнения и возражения (цена, страх испортить волосы, «подумаю»), предложи разумную альтернативу, если его запрос не оптимален. Вести к записи начинай только когда человек определился — и делай это ненавязчиво («хотите, подберу удобное время?»).`,
    ``,
    `ЧТО ПРЕДЛАГАЕТ ИМЕННО ЭТОТ САЛОН И ПОЧЁМ — только через инструмент get_services:`,
    `- Твоя база знаний — общая. Прежде чем назвать цену или записать, вызови get_services и сверься: оказывает ли салон эту услугу и сколько она стоит. Опирайся на реальные названия и цены из этого списка.`,
    `- Если подходящей процедуры в салоне нет — честно скажи и предложи ближайшую из того, что есть.`,
    `- Если у услуги price_type=range — назови вилку и предложи прислать фото для точной оценки (точную цену подтвердит мастер на месте). Не хочет фото — не настаивай, цену уточнит мастер.`,
    config.pricing_rules ? `- Правила оценки стоимости по фото: ${config.pricing_rules}` : "",
    ``,
    `КОГДА КЛИЕНТ ГОТОВ ЗАПИСАТЬСЯ (не раньше):`,
    branches.length > 1
      ? `- Если филиал ещё не выбран — уточни, куда удобнее.`
      : "",
    `- Узнай желаемый день, при желании — время суток. Вызови get_available_slots и предложи 2–4 подходящих времени словами в одном предложении (например: «Есть 10:00, 12:30 и 16:00 — что удобнее?»). Никаких пронумерованных списков.`,
    `- Если мастеров несколько и клиенту важно — предложи выбор (get_masters); если «всё равно» — выбери сам.`,
    `- Узнай имя, если ещё не знаешь. Затем повтори детали одной фразой (услуга, дата, время, мастер, цена) и дождись явного «да».`,
    `- Только после явного «да» вызови create_appointment, поздравь и напомни адрес.`,
    ``,
    `УПРАВЛЕНИЕ СУЩЕСТВУЮЩЕЙ ЗАПИСЬЮ:`,
    `- «Хочу отменить/перенести» → get_my_appointments, уточни какую (если их несколько), подтверди явным «да», затем cancel_appointment или reschedule_appointment. Для переноса сначала подбери время через get_available_slots.`,
    cutoff > 0
      ? `- Если до визита осталось меньше ${cutoff} ч — отмена/перенос через чат невозможны, попроси позвонить в салон (инструменты сами вернут ошибку cutoff).`
      : "",
    ``,
    `ЖЕЛЕЗНЫЕ ПРАВИЛА:`,
    `- Экспертными знаниями консультируй свободно, НО услуги, цены, свободное время и имена мастеров бери ТОЛЬКО из инструментов. Их не выдумывай.`,
    `- Здоровье и противопоказания (беременность, аллергии, болезни/ранки кожи головы, приём лекарств): дай общую информацию из базы, но НЕ ставь диагнозов, НЕ давай медицинских гарантий и порекомендуй очную оценку мастера или консультацию врача.`,
    `- Не обещай результат «100%» и не преувеличивай сроки — говори честно, как профессионал.`,
    `- create_appointment — только после явного подтверждения клиента («да», «записывайте», «ооба», «макул»).`,
    `- Если инструмент вернул ошибку slot_taken — извинись, что время только что заняли, и предложи другие слоты.`,
    `- Не обещай «перезвонить» или «написать позже» — у тебя один ответ за ход.`,
    `- Если клиент жалуется, просит живого человека или задаёт вопрос, на который нет ответа ни в базе, ни в данных салона — вызови escalate_to_human и скажи, что передал вопрос администратору.`,
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
      "Передать диалог живому администратору (жалоба, просьба позвать человека, непонимание).",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
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
      const { isoLocalDate } = nowInTz(tz);
      const minStart = args.date === isoLocalDate ? new Date() : undefined;
      let masters: DbMaster[];
      if (args.master_id) {
        masters = [
          { id: args.master_id, name: "", branch_id: null, sort_order: 0, service_ids: [] },
        ];
      } else {
        masters = await loadMastersForService(
          db,
          input.salon.salonId,
          args.service_id as string,
          (args.branch_id as string | null) ?? flags.selectedBranchId ?? null,
        );
      }
      if (masters.length === 0) return { date: args.date, slots: [], note: "нет мастеров на эту услугу" };
      const slots = await fetchMergedSlots({
        db,
        masters,
        serviceId: args.service_id as string,
        day: args.date as string,
        tz,
        part: args.part_of_day as any,
        minStartTime: minStart,
        limit: SLOTS_LIMIT,
      });
      return {
        date: args.date,
        slots: slots.map((s) => ({
          start: s.start,
          time: formatTimeInTz(s.start, tz),
          master_ids: s.master_ids,
        })),
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

  let reply = "";
  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    const res = await callGeminiTools({
      apiKey,
      systemInstruction: systemPrompt,
      contents,
      tools: V4_TOOL_DECLARATIONS,
    });

    if (!res.ok || !res.parts) {
      debug.errors.push(`gemini_tools iter${iter}: ${res.error ?? "no parts"}`);
      reply =
        language === "ky"
          ? "Кечиресиз, техникалык ката болду. Бир аздан кийин кайра жазыңызчы 🙏"
          : "Извините, произошла техническая ошибка. Напишите, пожалуйста, чуть позже 🙏";
      break;
    }

    contents.push({ role: "model", parts: res.parts });
    const functionCalls = res.parts.filter((p: any) => p.functionCall);
    const textPart = res.parts.find((p: any) => typeof p.text === "string" && p.text.trim());

    if (functionCalls.length === 0) {
      reply = textPart?.text?.trim() ?? "";
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

  return {
    reply,
    nextState,
    nextStateData,
    appointmentId: flags.appointmentId,
    selectedBranchId: flags.selectedBranchId,
    debug,
  };
}
