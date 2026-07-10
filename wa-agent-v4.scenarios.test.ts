// Smoke tests for runWaAgentV4 — the LLM tool-calling agent (engine flag
// salon_ai_assistant.engine = 'v4'). Gemini is mocked with scripted functionCall
// chains, the DB with the same in-memory table mock style as wa-agent-v3.scenarios.test.ts,
// so these tests verify the deterministic side: tool execution, slot re-validation,
// cutoff enforcement, escalation flag, greeting prepend and history persistence.
//
// Run: bun test wa-agent-v4.scenarios.test.ts
import { test, expect, mock, beforeEach } from "bun:test";

const dbProxy = new Proxy({} as any, {
  get(_t, prop) {
    const db = (globalThis as any).__WA_DB__;
    return db[prop];
  },
});
mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: dbProxy }));

process.env.GEMINI_API_KEY = "test-key";

const { runWaAgentV4 } = await import("@/lib/wa-agent-v4.server");

const TZ = "Asia/Bishkek";
const SALON = { salonId: "salon1", salonName: "Тест салон", timezone: TZ };
const FREE_SLOT = "2099-01-01T04:00:00.000Z"; // the only slot the mocked RPC ever returns

// ---- In-memory DB mock: only the query shapes V4 actually issues. ----
function makeDb(opts: { services?: any[]; masters?: any[]; appointments?: any[] } = {}) {
  const services = opts.services ?? [
    {
      id: "svc1",
      name: "Маникюр",
      category: null,
      price: 1000,
      price_max: null,
      price_type: "fixed",
      duration_min: 60,
      is_active: true,
    },
  ];
  const masters = opts.masters ?? [
    { id: "m1", name: "Айгуль", branch_id: null, sort_order: 0, service_ids: ["svc1"] },
  ];
  const appointments = opts.appointments ?? [];

  function servicesQuery() {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.then = (resolve: any) => resolve({ data: services.filter((s) => s.is_active !== false) });
    return q;
  }
  function mastersQuery() {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.then = (resolve: any) =>
      resolve({
        data: masters.map((m) => ({
          ...m,
          master_services: m.service_ids.map((id: string) => ({ service_id: id })),
        })),
      });
    return q;
  }
  function aiAssistantQuery() {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: null });
    return q;
  }
  function aiOverridesQuery() {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.then = (resolve: any) => resolve({ data: [] });
    return q;
  }
  function appointmentsQuery() {
    const q: any = { _update: null as any, _eqs: [] as Array<[string, any]> };
    q.select = () => q;
    q.eq = (col: string, val: any) => {
      q._eqs.push([col, val]);
      return q;
    };
    q.gte = () => q;
    q.order = () => q;
    q.update = (patch: any) => {
      q._update = patch;
      return q;
    };
    q.maybeSingle = async () => {
      const idFilter = q._eqs.find(([c]: any) => c === "id");
      const row = appointments.find((a) => a.id === idFilter?.[1]);
      return { data: row ? { ...row } : null };
    };
    q.then = (resolve: any) => {
      if (q._update) {
        const idFilter = q._eqs.find(([c]: any) => c === "id");
        const row = appointments.find((a) => a.id === idFilter?.[1]);
        if (row) Object.assign(row, q._update);
        resolve({ error: null });
        return;
      }
      const filtered = appointments.filter(
        (a) =>
          q._eqs.every(([c, v]: any) => c === "status" || a[c] === v) && a.status === "confirmed",
      );
      resolve({
        data: filtered.map((a) => ({
          ...a,
          services: { name: a.serviceName ?? "?" },
          masters: { name: a.masterName ?? "?" },
        })),
      });
    };
    return q;
  }

  return {
    appointments,
    from: (table: string) => {
      if (table === "services") return servicesQuery();
      if (table === "masters") return mastersQuery();
      if (table === "salon_ai_assistant") return aiAssistantQuery();
      if (table === "ai_service_overrides") return aiOverridesQuery();
      if (table === "appointments") return appointmentsQuery();
      throw new Error(`unmocked table ${table}`);
    },
    rpc: async (name: string, args: any) => {
      if (name === "get_available_slots")
        return {
          data: [{ slot_start: FREE_SLOT, slot_end: "2099-01-01T05:00:00.000Z" }],
          error: null,
        };
      if (name === "create_appointment") {
        const id = `appt_${appointments.length + 1}`;
        appointments.push({
          id,
          starts_at: args._starts_at,
          service_id: args._service_id,
          master_id: args._master_id,
          salon_id: SALON.salonId,
          client_phone: args._client_phone,
          status: "confirmed",
          serviceName: services.find((s) => s.id === args._service_id)?.name ?? "?",
          masterName: masters.find((m) => m.id === args._master_id)?.name ?? "?",
        });
        return { data: id, error: null };
      }
      if (name === "reschedule_appointment" || name === "reschedule_appointment_v2") {
        const row = appointments.find((a) => a.id === args._appointment_id);
        if (row) {
          row.starts_at = args._new_starts_at;
          if (args._new_master_id) row.master_id = args._new_master_id;
        }
        return { data: args._appointment_id, error: null };
      }
      return { data: null, error: null };
    },
  };
}

// ---- Gemini fetch mock: pops scripted parts-arrays per generateContent call. ----
let geminiQueue: any[][] = [];
let geminiRequests: any[] = [];
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) {
    try {
      geminiRequests.push(JSON.parse(init?.body ?? "{}"));
    } catch {}
    const parts = geminiQueue.shift();
    if (!parts) return new Response("exhausted", { status: 500 });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }),
      { status: 200 },
    );
  }
  return new Response("no", { status: 400 });
}) as any;

beforeEach(() => {
  geminiQueue = [];
  geminiRequests = [];
});

const fc = (name: string, args: Record<string, any> = {}) => ({ functionCall: { name, args } });

function makeInput(text: string, over: Partial<any> = {}) {
  return {
    salon: SALON,
    config: {
      greeting: null,
      tone_instructions: null,
      pricing_rules: null,
      languages: ["ru", "ky"],
      manage_cutoff_hours: 0,
      knowledge_base: null,
      ...(over.config ?? {}),
    },
    client: { phone: "996700000001", name: "Тест" },
    history: [],
    lastMessages: [
      {
        id: "msg1",
        direction: "in" as const,
        kind: "text" as const,
        text_body: text,
        created_at: new Date().toISOString(),
      },
    ],
    branches: [],
    selectedBranchId: null,
    state: "idle" as const,
    stateData: {},
    salonInfo: { working_hours: { mon: "10:00–20:00" }, address: "ул. Тестовая 1" },
    ...over,
    ...(over.config ? { config: { ...over.config } } : {}),
  } as any;
}

// ============================================================

test("полный цикл: tools get_services → get_available_slots → текст-вопрос клиенту", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [
    [fc("get_services")],
    [fc("get_available_slots", { service_id: "svc1", date: "2099-01-01" })],
    [{ text: "Есть свободное время в 10:00 — записать вас?" }],
  ];
  const res = await runWaAgentV4(makeInput("Хочу маникюр завтра"));
  expect(res.reply).toContain("10:00");
  expect(res.debug.actions).toContain("tool:get_services");
  expect(res.debug.actions).toContain("tool:get_available_slots");
  expect(res.appointmentId).toBeNull();
  expect(res.nextState).toBe("collecting");
  // Tool responses fed back to Gemini as functionResponse parts
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionResponse);
  expect(fr.length).toBeGreaterThan(0);
});

test("create_appointment после «да»: запись создаётся, nextState=done", async () => {
  const db = makeDb();
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1",
        slot_start: FREE_SLOT,
        client_name: "Рамис",
      }),
    ],
    [{ text: "Готово! Записала вас на маникюр. Ждём вас!" }],
  ];
  const res = await runWaAgentV4(makeInput("Да, записывайте"));
  expect(res.appointmentId).toBe("appt_1");
  expect(res.nextState).toBe("done");
  expect(db.appointments).toHaveLength(1);
  expect(db.appointments[0].client_phone).toBe("996700000001");
});

test("занятый слот: create_appointment на несуществующее время → slot_taken, запись НЕ создаётся", async () => {
  const db = makeDb();
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1",
        slot_start: "2099-01-01T09:00:00.000Z", // not the slot the RPC offers
        client_name: "Рамис",
      }),
    ],
    [{ text: "Ой, это время только что заняли. Есть 10:00 — подойдёт?" }],
  ];
  const res = await runWaAgentV4(makeInput("Да"));
  expect(res.appointmentId).toBeNull();
  expect(db.appointments).toHaveLength(0);
  // The model received the slot_taken error in a functionResponse
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "create_appointment");
  expect(fr.functionResponse.response.error).toBe("slot_taken");
});

test("эскалация: escalate_to_human → needs_human в nextStateData", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [
    [fc("escalate_to_human", { reason: "жалоба" })],
    [{ text: "Передаю ваш вопрос администратору, он скоро ответит." }],
  ];
  const res = await runWaAgentV4(makeInput("Хочу поговорить с живым человеком!"));
  expect((res.nextStateData as any).needs_human).toBe(true);
  expect(res.reply).toContain("администратору");
});

test("шаблонное приветствие салона добавляется к первому ответу", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [[{ text: "На какую услугу вас записать?" }]];
  const res = await runWaAgentV4(
    makeInput("хочу записаться", {
      config: {
        greeting: "Добро пожаловать в Тест салон! 💫",
        tone_instructions: null,
        pricing_rules: null,
        languages: ["ru"],
        manage_cutoff_hours: 0,
        knowledge_base: null,
      },
    }),
  );
  expect(res.reply.startsWith("Добро пожаловать в Тест салон! 💫")).toBe(true);
  expect(res.reply).toContain("На какую услугу");
});

test("приветствие НЕ дублируется, если модель уже поздоровалась", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [[{ text: "Здравствуйте! На какую услугу вас записать?" }]];
  const res = await runWaAgentV4(
    makeInput("привет", {
      config: {
        greeting: "Добро пожаловать!",
        tone_instructions: null,
        pricing_rules: null,
        languages: ["ru"],
        manage_cutoff_hours: 0,
        knowledge_base: null,
      },
    }),
  );
  expect(res.reply).toBe("Здравствуйте! На какую услугу вас записать?");
});

test("отмена записи: get_my_appointments → cancel_appointment", async () => {
  const db = makeDb({
    appointments: [
      {
        id: "appt_9",
        starts_at: "2099-02-01T05:00:00.000Z",
        salon_id: SALON.salonId,
        client_phone: "996700000001",
        master_id: "m1",
        service_id: "svc1",
        status: "confirmed",
        serviceName: "Маникюр",
        masterName: "Айгуль",
      },
    ],
  });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [fc("get_my_appointments")],
    [fc("cancel_appointment", { appointment_id: "appt_9" })],
    [{ text: "Запись отменена. Будем рады видеть вас снова!" }],
  ];
  const res = await runWaAgentV4(makeInput("Отмените мою запись, да, подтверждаю"));
  expect(db.appointments[0].status).toBe("cancelled");
  expect(res.reply).toContain("отменена");
});

test("cutoff: отмена ближе дедлайна запрещена, статус не меняется", async () => {
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // визит через 2ч
  const db = makeDb({
    appointments: [
      {
        id: "appt_9",
        starts_at: soon,
        salon_id: SALON.salonId,
        client_phone: "996700000001",
        master_id: "m1",
        service_id: "svc1",
        status: "confirmed",
        serviceName: "Маникюр",
        masterName: "Айгуль",
      },
    ],
  });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [fc("cancel_appointment", { appointment_id: "appt_9" })],
    [{ text: "К сожалению, отменить через чат уже нельзя — позвоните в салон, пожалуйста." }],
  ];
  const res = await runWaAgentV4(
    makeInput("отмените запись", {
      config: {
        greeting: null,
        tone_instructions: null,
        pricing_rules: null,
        languages: ["ru"],
        manage_cutoff_hours: 24,
        knowledge_base: null,
      },
    }),
  );
  expect(db.appointments[0].status).toBe("confirmed"); // untouched
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "cancel_appointment");
  expect(fr.functionResponse.response.error).toBe("cutoff");
  expect(res.reply).toContain("позвоните");
});

test("перенос записи: reschedule_appointment двигает starts_at", async () => {
  const db = makeDb({
    appointments: [
      {
        id: "appt_9",
        starts_at: "2099-02-01T05:00:00.000Z",
        salon_id: SALON.salonId,
        client_phone: "996700000001",
        master_id: "m1",
        service_id: "svc1",
        status: "confirmed",
        serviceName: "Маникюр",
        masterName: "Айгуль",
      },
    ],
  });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [fc("reschedule_appointment", { appointment_id: "appt_9", new_slot_start: FREE_SLOT })],
    [{ text: "Перенесла вашу запись. До встречи!" }],
  ];
  const res = await runWaAgentV4(makeInput("перенесите на 10 утра, да"));
  expect(db.appointments[0].starts_at).toBe(FREE_SLOT);
  expect(res.reply).toContain("Перенесла");
});

test("ошибка Gemini → вежливое сообщение об ошибке, состояние не падает", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = []; // fetch mock returns 500
  const res = await runWaAgentV4(makeInput("привет"));
  expect(res.reply).toContain("техническая ошибка");
  expect(res.debug.errors.length).toBeGreaterThan(0);
});

test("история v4_history сохраняется и передаётся в следующий ход", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [[{ text: "На какую услугу вас записать?" }]];
  const first = await runWaAgentV4(makeInput("привет"));
  const hist = (first.nextStateData as any).v4_history;
  expect(Array.isArray(hist)).toBe(true);
  expect(hist.length).toBe(2); // user turn + model turn

  geminiQueue = [[{ text: "Отлично, на маникюр!" }]];
  const second = await runWaAgentV4(
    makeInput("маникюр", { stateData: { v4_history: hist, language: "ru" } }),
  );
  // Gemini received the prior turns + the new message
  const req = geminiRequests[geminiRequests.length - 1];
  expect(req.contents.length).toBe(3);
  expect((second.nextStateData as any).v4_history.length).toBe(4);
});

test("кыргызский: язык из state сохраняется, ошибка Gemini отвечает по-кыргызски", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [];
  const res = await runWaAgentV4(makeInput("салам", { stateData: { language: "ky" } }));
  expect(res.reply).toContain("Кечиресиз");
});
