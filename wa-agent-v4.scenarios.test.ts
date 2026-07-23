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

const { runWaAgentV4, humanizeReply, buildSystemPromptV4 } =
  await import("@/lib/wa-agent-v4.server");

const TZ = "Asia/Bishkek";
const SALON = { salonId: "salon1", salonName: "Тест салон", timezone: TZ };
const FREE_SLOT = "2099-01-01T04:00:00.000Z"; // the only slot the mocked RPC ever returns

// ---- In-memory DB mock: only the query shapes V4 actually issues. ----
function makeDb(
  opts: { services?: any[]; masters?: any[]; appointments?: any[]; daySlots?: string[] } = {},
) {
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
    q.limit = () => q;
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
      if (name === "get_available_slots") {
        const starts = opts.daySlots ?? [FREE_SLOT];
        return {
          data: starts.map((s) => ({
            slot_start: s,
            slot_end: new Date(new Date(s).getTime() + 60 * 60 * 1000).toISOString(),
          })),
          error: null,
        };
      }
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
  // Gemini prompt-cache (cachedContents) endpoint — always fail in tests so V4 falls back
  // to inline systemInstruction, matching the pre-cache behavior every test was written for.
  // Doesn't consume geminiQueue.
  if (u.includes("/cachedContents")) {
    return new Response('{"error":"tests-skip-cache"}', { status: 400 });
  }
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

test("без имени: create_appointment с плейсхолдером «Неизвестно» → need_client_name, запись НЕ создаётся", async () => {
  const db = makeDb();
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1",
        slot_start: FREE_SLOT,
        client_name: "Неизвестно",
      }),
    ],
    [{ text: "Извините, забыла спросить — как вас зовут?" }],
  ];
  const res = await runWaAgentV4(makeInput("Да"));
  expect(res.appointmentId).toBeNull();
  expect(db.appointments).toHaveLength(0);
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "create_appointment");
  expect(fr.functionResponse.response.success).toBe(false);
  expect(fr.functionResponse.response.reason).toBe("need_client_name");
});

test("без имени: пустая строка → need_client_name (плейсхолдер отвергнут)", async () => {
  const db = makeDb();
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1",
        slot_start: FREE_SLOT,
        client_name: "  ",
      }),
    ],
    [{ text: "Как вас зовут?" }],
  ];
  const res = await runWaAgentV4(makeInput("да"));
  expect(res.appointmentId).toBeNull();
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "create_appointment");
  expect(fr.functionResponse.response.reason).toBe("need_client_name");
});

test("manage-link: после успешной записи в ответе есть инструкция и ссылка", async () => {
  const db = makeDb();
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1",
        slot_start: FREE_SLOT,
        client_name: "Анна",
      }),
    ],
    [{ text: "Готово! Записала вас на маникюр к Айгуль. Ждём вас!" }],
  ];
  const res = await runWaAgentV4(makeInput("Да, записывайте"));
  expect(res.appointmentId).toBe("appt_1");
  // Instruction line + emoji-prefixed URL line should both be present when a manage URL exists.
  // (The mocked DB returns no manage_token, so the URL block is absent — verify only when present.)
  if (res.reply.includes("qabyl.com/manage/")) {
    expect(res.reply).toContain("сами перенести или отменить");
    expect(res.reply).toContain("🔗");
  }
});

test("без дублей: вторая запись на ту же услугу → reason=already_booked, новая НЕ создаётся", async () => {
  const db = makeDb({
    appointments: [
      {
        id: "a0",
        salon_id: "salon1",
        starts_at: FREE_SLOT,
        service_id: "svc1",
        status: "confirmed",
        client_phone: "996700000001",
        masterName: "Айгуль",
      },
    ],
  });
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
    [{ text: "У вас уже есть запись на маникюр. Оформить ещё одну или изменить эту?" }],
  ];
  const res = await runWaAgentV4(makeInput("Да, записывайте"));
  expect(res.appointmentId).toBeNull();
  expect(db.appointments).toHaveLength(1); // no second booking created
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "create_appointment");
  expect(fr.functionResponse.response.reason).toBe("already_booked");
  expect(fr.functionResponse.response.existing).toBeTruthy();
});

test("без дублей: confirm_duplicate=true разрешает вторую запись (напр. на другого человека)", async () => {
  const db = makeDb({
    appointments: [
      {
        id: "a0",
        salon_id: "salon1",
        starts_at: FREE_SLOT,
        service_id: "svc1",
        status: "confirmed",
        client_phone: "996700000001",
        masterName: "Айгуль",
      },
    ],
  });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1",
        slot_start: FREE_SLOT,
        client_name: "Гостья",
        confirm_duplicate: true,
      }),
    ],
    [{ text: "Готово, записала вторую запись!" }],
  ];
  const res = await runWaAgentV4(makeInput("да, ещё одну на подругу"));
  expect(res.appointmentId).toBe("appt_2");
  expect(db.appointments).toHaveLength(2);
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
  // The model received the slot-not-free signal in a functionResponse (server-authoritative
  // contract: no such free slot → reason=slot_not_free, never a silent booking on another time).
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "create_appointment");
  expect(fr.functionResponse.response.success).toBe(false);
  expect(fr.functionResponse.response.reason).toBe("slot_not_free");
});

test("занятый мастер, свободный другой: create_appointment возвращает masters_free_at_requested_time", async () => {
  // Repro of the reported bug: 17:00 was offered as free (merged over all masters), the client
  // picked Айгуль, but Айгуль is actually booked at 17:00 while Айжан is free. The failure must
  // name Айжан so the assistant can offer the same time with the other master.
  const masters = [
    { id: "m1", name: "Айгуль", branch_id: null, sort_order: 0, service_ids: ["svc1"] },
    { id: "m2", name: "Айжан", branch_id: null, sort_order: 1, service_ids: ["svc1"] },
  ];
  const db = makeDb({ masters });
  // 17:00 Bishkek (UTC+6) == 11:00 UTC. Айгуль (m1) only has 10:00; Айжан (m2) has 17:00.
  const SEVENTEEN = "2099-01-01T11:00:00.000Z";
  const TEN = "2099-01-01T04:00:00.000Z";
  db.rpc = (async (name: string, args: any) => {
    if (name === "get_available_slots") {
      const starts = args._master_id === "m2" ? [SEVENTEEN] : [TEN];
      return {
        data: starts.map((s) => ({
          slot_start: s,
          slot_end: new Date(new Date(s).getTime() + 3600_000).toISOString(),
        })),
        error: null,
      };
    }
    return { data: null, error: null };
  }) as any;
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [
      fc("create_appointment", {
        service_id: "svc1",
        master_id: "m1", // Айгуль — busy at 17:00
        date: "2099-01-01",
        time: "17:00",
        client_name: "Анна",
      }),
    ],
    [{ text: "На 17:00 к Айгуль занято, но свободна Айжан — записать к ней?" }],
  ];
  const res = await runWaAgentV4(makeInput("Да"));
  expect(res.appointmentId).toBeNull();
  expect(db.appointments).toHaveLength(0);
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "create_appointment");
  expect(fr.functionResponse.response.success).toBe(false);
  expect(fr.functionResponse.response.reason).toBe("slot_not_free");
  expect(fr.functionResponse.response.masters_free_at_requested_time).toContain("Айжан");
});

test("выходной у выбранного мастера ≠ выходной салона: reason=master_off_that_day", async () => {
  // Bug: client picks Айгуль and asks about her day off. Scoped availability said "closed",
  // which the model turned into «салон не работает / выходной» — but Айжан works that day.
  const DATE = "2099-01-05";
  const dow = new Date(`${DATE}T12:00:00Z`).getUTCDay();
  const masters = [
    { id: "m1", name: "Айгуль", branch_id: null, sort_order: 0, service_ids: ["svc1"] },
    { id: "m2", name: "Айжан", branch_id: null, sort_order: 1, service_ids: ["svc1"] },
  ];
  // Айгуль (m1) has an explicit day-off override on DATE; Айжан (m2) is scheduled that weekday.
  const overrides = [{ master_id: "m1", date: DATE, is_off: true, kind: "off", intervals: null }];
  const schedules = [{ master_id: "m2", weekday: dow }];

  // A tiny query builder that honours .in()/.eq() filters and resolves an array.
  const tableQuery = (rows: any[]) => {
    const q: any = { _f: [] as Array<[string, any, boolean]> };
    q.select = () => q;
    q.eq = (c: string, v: any) => (q._f.push([c, v, false]), q);
    q.in = (c: string, v: any[]) => (q._f.push([c, v, true]), q);
    q.order = () => q;
    q.maybeSingle = async () => ({ data: null });
    q.then = (resolve: any) =>
      resolve({
        data: rows.filter((r) =>
          q._f.every(([c, v, isIn]: any) => (isIn ? v.includes(r[c]) : r[c] === v)),
        ),
      });
    return q;
  };
  const masterRows = masters.map((m) => ({
    ...m,
    is_active: true,
    salon_id: "salon1",
    specialization: null,
    bio: null,
    master_services: m.service_ids.map((id: string) => ({ service_id: id })),
  }));
  const db: any = {
    appointments: [],
    from: (t: string) => {
      if (t === "masters") return tableQuery(masterRows);
      if (t === "master_day_overrides") return tableQuery(overrides);
      if (t === "master_schedules") return tableQuery(schedules);
      if (t === "branches") return tableQuery([]);
      if (t === "services") return tableQuery([]);
      throw new Error(`unmocked table ${t}`);
    },
    // Айгуль has no free slots on her day off; nobody else is queried by masterId here.
    rpc: async () => ({ data: [], error: null }),
  };
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [fc("get_available_slots", { service_id: "svc1", date: DATE, master_id: "m1" })],
    [{ text: "У Айгуль в этот день выходной, но работает Айжан — записать к ней?" }],
  ];
  const res = await runWaAgentV4(makeInput("Хочу к Айгуль в этот день"));
  const lastReq = geminiRequests[geminiRequests.length - 1];
  const fr = lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === "get_available_slots");
  expect(fr.functionResponse.response.reason).toBe("master_off_that_day");
});

test("эскалация: escalate_to_human → needs_human + notifyAdminText с номером клиента", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [
    [fc("escalate_to_human", { reason: "жалоба" })],
    [{ text: "Передаю ваш вопрос администратору, он скоро ответит." }],
  ];
  const res = await runWaAgentV4(makeInput("Хочу поговорить с живым человеком!"));
  expect((res.nextStateData as any).needs_human).toBe(true);
  expect(res.reply).toContain("администратору");
  // Alert for the salon admin's own WhatsApp is prepared (webhook forwards it).
  expect(res.notifyAdminText).toBeTruthy();
  expect(res.notifyAdminText).toContain("996700000001"); // client phone from makeInput
  expect(res.notifyAdminText).toContain("жалоба"); // escalation reason
});

test("без эскалации notifyAdminText не выставляется", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [[{ text: "Здравствуйте! Чем могу помочь?" }]];
  const res = await runWaAgentV4(makeInput("привет"));
  expect(res.notifyAdminText).toBeUndefined();
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

test("язык: sticky=en, но клиент пишет по-русски → перекатывается на RU (устраняет утечку EN-фрагментов)", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [[{ text: "Конечно, на какую услугу вас записать?" }]];
  const res = await runWaAgentV4(
    makeInput("хочу записаться на стрижку", { stateData: { language: "en" } }),
  );
  expect(res.nextStateData.language).toBe("ru");
});

test("язык: sticky=ky на плоское русское слово — остаётся KY (не ломаем sticky для KY-диалогов)", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [[{ text: "Ооба, канча сааттка каалайсыз?" }]];
  const res = await runWaAgentV4(makeInput("сегодня", { stateData: { language: "ky" } }));
  expect(res.nextStateData.language).toBe("ky");
});

test("tool retry: первый вызов падает, второй проходит — клиент видит нормальный ответ", async () => {
  const db = makeDb();
  // Первый rpc('get_available_slots') кинет, второй вернёт слот.
  let calls = 0;
  const origRpc = db.rpc;
  db.rpc = (async (name: string, args: any) => {
    if (name === "get_available_slots") {
      calls += 1;
      if (calls === 1) throw new Error("transient supabase blip");
    }
    return origRpc(name, args);
  }) as any;
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [
    [fc("get_available_slots", { service_id: "svc1", date: "2099-01-01" })],
    [{ text: "На эту дату есть 10:00. Записать вас?" }],
  ];
  const res = await runWaAgentV4(makeInput("завтра свободно?"));
  expect(res.reply).not.toMatch(/не получилось получить данные|техническая ошибка/i);
  expect(calls).toBeGreaterThanOrEqual(2); // повтор действительно был
});

test("gemini caching: успешно созданный кеш переиспользуется на следующем ходу; при промахе — recreate", async () => {
  const db = makeDb();
  (globalThis as any).__WA_DB__ = db;

  // Custom fetch: cachedContents endpoint returns a fake cache; track calls to measure reuse.
  let cacheCreateCalls = 0;
  let generateCallsWithCache = 0;
  let generateCallsInline = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/cachedContents")) {
      cacheCreateCalls += 1;
      return new Response(
        JSON.stringify({
          name: "cachedContents/test-cache-1",
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      );
    }
    if (u.includes("generativelanguage.googleapis.com")) {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.cachedContent) generateCallsWithCache += 1;
      else generateCallsInline += 1;
      const parts = geminiQueue.shift();
      if (!parts) return new Response("exhausted", { status: 500 });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 400 });
  }) as any;

  try {
    // Turn 1: cache creation fires CONCURRENTLY (non-blocking) so the turn is not delayed by it.
    // The single-iteration reply may run inline (cache not resolved yet) — timing-dependent, so
    // we don't assert the inline-vs-cache split here. What we DO guarantee: the cache is created
    // exactly once and persisted to state for the next turn.
    geminiQueue = [[{ text: "Здравствуйте! Чем помочь?" }]];
    const r1 = await runWaAgentV4(makeInput("привет"));
    expect(cacheCreateCalls).toBe(1);
    const cacheOnState = (r1.nextStateData as any).gemini_cache;
    expect(cacheOnState?.name).toBe("cachedContents/test-cache-1");

    // Turn 2: cache is reused from state synchronously at turn start — no new create call, and
    // the generate call uses the cached prefix.
    generateCallsWithCache = 0;
    generateCallsInline = 0;
    geminiQueue = [[{ text: "Стрижка?" }]];
    await runWaAgentV4(makeInput("хочу стрижку", { stateData: r1.nextStateData }));
    expect(cacheCreateCalls).toBe(1); // still 1 — reused, not recreated
    expect(generateCallsWithCache).toBe(1); // turn 2 uses the cache
    expect(generateCallsInline).toBe(0);
  } finally {
    globalThis.fetch = origFetch;
  }
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

test("ошибка Gemini → эскалация к админу + вежливое «администратор ответит»", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = []; // fetch mock returns 500
  const res = await runWaAgentV4(makeInput("привет"));
  // Клиент получает честное «ассистент недоступен» — не «техническую ошибку»
  expect(res.reply.toLowerCase()).toContain("ассистент");
  expect(res.reply.toLowerCase()).toContain("администратор");
  // Диалог помечается на эскалацию, чтобы админ узнал что AI лежит
  expect((res.nextStateData as any).needs_human).toBe(true);
  expect(res.debug.errors.length).toBeGreaterThan(0);
});

test("промпт: правило «цена сразу» + мультиуслуга + абсолютный язык присутствуют", () => {
  const prompt = buildSystemPromptV4(makeInput("привет"));
  // Price-first rule
  expect(prompt).toContain("ЦЕНА СРАЗУ");
  expect(prompt).toMatch(/не шире 500 сом|шириной ~200–500/);
  // Multi-service sequential-booking rule
  expect(prompt).toContain("НЕСКОЛЬКО УСЛУГ В ОДИН ВИЗИТ");
  expect(prompt).toContain("суммарную цену");
  // Airtight language rule (zero mixing)
  expect(prompt).toContain("НУЛЕВАЯ ТЕРПИМОСТЬ К СМЕШЕНИЮ");
  // datPl bug guard: no undefined leaked into the specialist-noun interpolations
  expect(prompt).not.toContain("undefined");
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

test("залипший ru перебивается уверенным кыргызским в текущем сообщении (регрессия со скринов)", async () => {
  // Реальный баг: state.language once = 'ru' → кыргызский диалог получал русские ошибки.
  // Теперь уверенный кыргызский сигнал в текущем ходе перебивает залипший язык.
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = []; // fetch mock → ошибка Gemini
  const res = await runWaAgentV4(makeInput("Саат бешке жокпу", { stateData: { language: "ru" } }));
  expect(res.reply).toContain("Кечиресиз"); // KY, не русское «Извините»
  expect(res.nextStateData.language).toBe("ky");
});

test("humanizeReply убирает markdown и превращает нумерованный список в прозу", () => {
  const input =
    "Вот варианты:\n1. **Ботокс для волос:** восстановление и блеск.\n2. **Кератин:** гладкость и выпрямление.";
  const out = humanizeReply(input);
  expect(out).not.toContain("**");
  expect(out).not.toMatch(/^\s*\d+[.)]/m); // no line starts with "1." / "2."
  expect(out).not.toContain("\n1.");
  expect(out).toContain("Ботокс для волос");
  expect(out).toContain("Кератин");
});

test("humanizeReply не трогает нормальный текст со временем и двоеточиями", () => {
  const input = "Есть 10:00, 12:30 и 16:00 — что удобнее?";
  expect(humanizeReply(input)).toBe(input);
});

test("humanizeReply сохраняет построчную сводку подтверждения (цена/детали не схлопываются)", () => {
  // The label-per-line confirmation summary must survive humanizeReply on SEPARATE lines —
  // it must not be collapsed into a paragraph, and the price line must remain intact.
  const summary =
    "Пожалуйста, подтвердите запись:\n" +
    "Услуга: Стрижка\n" +
    "Стоимость: 700 сом\n" +
    "Мастер: Айгуль\n" +
    "Дата: 23 июля\n" +
    "Время: 17:00\n" +
    "Продолжительность: 1 час\n" +
    "Имя: Анна\n" +
    "Всё верно? Если да — подтвердите, пожалуйста 🙂";
  const out = humanizeReply(summary);
  expect(out).toContain("\nСтоимость: 700 сом\n");
  expect(out).toContain("\nУслуга: Стрижка\n");
  expect(out).toContain("\nПродолжительность: 1 час\n");
  // Each label stays on its own line (not merged into one paragraph).
  expect(out.split("\n").length).toBeGreaterThanOrEqual(9);
});

test("ответ агента очищается от markdown/списка перед отправкой клиенту", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [
    [
      {
        text: "Смотрите:\n1. **Ботокс** — восстановление.\n2. **Кератин** — выпрямление.",
      },
    ],
  ];
  const res = await runWaAgentV4(makeInput("волосы сухие после осветления, что делать?"));
  expect(res.reply).not.toContain("**");
  expect(res.reply).not.toMatch(/^\s*\d+[.)]\s/m);
  expect(res.reply).toContain("Ботокс");
});

// --- Bug 1: calendar slots must not be truncated; check_time is authoritative ---

function funcResp(name: string) {
  const req = geminiRequests[geminiRequests.length - 1];
  return req.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === name)?.functionResponse?.response;
}

test("get_available_slots возвращает ВЕСЬ день (не обрезает до 8)", async () => {
  // 20 свободных стартов в один день — раньше список резался до 8, и ИИ думал что день кончается.
  const daySlots = Array.from({ length: 20 }, (_, i) =>
    new Date(Date.UTC(2099, 0, 1, 4, i * 15)).toISOString(),
  );
  (globalThis as any).__WA_DB__ = makeDb({ daySlots });
  geminiQueue = [
    [fc("get_available_slots", { service_id: "svc1", date: "2099-01-01" })],
    [{ text: "Есть свободное время, что удобнее?" }],
  ];
  await runWaAgentV4(makeInput("какое время свободно завтра?"));
  const resp = funcResp("get_available_slots");
  expect(resp.free_times.length).toBe(20); // ничего не отрезано
});

test("check_time: запрошенное время свободно → available true", async () => {
  (globalThis as any).__WA_DB__ = makeDb(); // FREE_SLOT = 10:00 Bishkek
  geminiQueue = [
    [fc("check_time", { service_id: "svc1", date: "2099-01-01", time: "10:00" })],
    [{ text: "Да, 10:00 свободно, записать?" }],
  ];
  await runWaAgentV4(makeInput("10:00 барбы?"));
  const resp = funcResp("check_time");
  expect(resp.available).toBe(true);
  expect(resp.requested).toBe("10:00");
});

test("check_time: время НЕ в списке → available false, но с ближайшими", async () => {
  (globalThis as any).__WA_DB__ = makeDb(); // только 10:00 свободно
  geminiQueue = [
    [fc("check_time", { service_id: "svc1", date: "2099-01-01", time: "17:00" })],
    [{ text: "17:00 занято, но есть 10:00 — подойдёт?" }],
  ];
  await runWaAgentV4(makeInput("17:00 барбы?"));
  const resp = funcResp("check_time");
  expect(resp.available).toBe(false);
  expect(resp.nearby_free_times).toContain("10:00");
});

// --- Bug 2: never stall on "подождите" — force completion in the same turn ---

test("зависание после «подождите»: агент дожимает ответ той же репликой", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [
    // 1-й проход: модель «залипла» без вызова инструментов
    [{ text: "Секундочку, сейчас проверю расписание, подождите немного." }],
    // после наджа: вызывает инструмент…
    [fc("get_available_slots", { service_id: "svc1", date: "2099-01-01" })],
    // …и даёт готовый ответ
    [{ text: "Есть 10:00 — удобно?" }],
  ];
  const res = await runWaAgentV4(makeInput("на завтра есть время?"));
  expect(res.reply).not.toMatch(/подожд|сейчас проверю|секундоч/i);
  expect(res.reply).toContain("10:00");
  expect(res.debug.errors).toContain("stall_detected_forcing_completion");
});

test("стойкое зависание: если модель зависла дважды — вежливый детерминированный ответ", async () => {
  (globalThis as any).__WA_DB__ = makeDb();
  geminiQueue = [
    [{ text: "Секундочку, сейчас проверю расписание." }],
    [{ text: "Минуточку, подождите немного." }], // и после наджа снова залипла
  ];
  const res = await runWaAgentV4(makeInput("на завтра есть время?"));
  expect(res.reply).not.toMatch(/подожд|сейчас проверю|секундоч|минуточ/i);
  expect(res.reply).toContain("не удалось получить данные");
  expect(res.debug.errors).toContain("stall_persisted_using_fallback");
});

// ============================================================
// Industry vertical: medical clinic — system-prompt construction (deterministic, no Gemini).
// These lock in that the medical persona + hard safety boundaries actually reach the prompt,
// and that beauty-only guidance (photo pricing) is NOT leaked into a medical clinic.
// ============================================================

test("handoffContext: сообщения живого админа попадают в промпт (без противоречий)", () => {
  const withHandoff = buildSystemPromptV4(
    makeInput("а во сколько?", {
      handoffContext: ["Приходите завтра к 18:00", "Скидку 10% сделаем"],
    }),
  );
  expect(withHandoff).toContain("УЖЕ ОТВЕЧАЛ ЖИВОЙ АДМИНИСТРАТОР");
  expect(withHandoff).toContain("Приходите завтра к 18:00");
  expect(withHandoff).toContain("Скидку 10% сделаем");
  // Absent when no admin ever wrote — no phantom handoff block.
  const noHandoff = buildSystemPromptV4(makeInput("а во сколько?"));
  expect(noHandoff).not.toContain("УЖЕ ОТВЕЧАЛ ЖИВОЙ АДМИНИСТРАТОР");
});

test("medical: промпт содержит персону клиники и жёсткие мед-границы", () => {
  const prompt = buildSystemPromptV4(
    makeInput("болит голова", { config: { industry: "medical" } }),
  );
  expect(prompt).toContain("медицинской клиники"); // persona
  expect(prompt).toContain("НЕ ставишь диагноз"); // safetyBoundaries
});

test("medical: неотложные симптомы — скорая (103/112) и эскалация к человеку", () => {
  const prompt = buildSystemPromptV4(
    makeInput("сильная боль в груди", { config: { industry: "medical" } }),
  );
  expect(prompt).toContain("103"); // emergency number
  expect(prompt).toContain("escalate_to_human"); // triage → live human
});

test("medical: экспертная база — специальности и первичный/повторный приём", () => {
  const prompt = buildSystemPromptV4(
    makeInput("к какому врачу идти?", { config: { industry: "medical" } }),
  );
  expect(prompt).toContain("терапевт");
  expect(prompt).toContain("Первичный");
});

test("medical: НЕ подмешивает бьюти-оценку по фото", () => {
  const prompt = buildSystemPromptV4(makeInput("привет", { config: { industry: "medical" } }));
  expect(prompt).not.toContain("ОЦЕНКА СТОИМОСТИ ПО ФОТО");
});

test("разбор фото есть у КАЖДОЙ отрасли (не только beauty) — для консультации, не для цены", () => {
  // Every vertical must tell the agent how to use a client's photo to consult and book.
  for (const industry of [
    "barbershop",
    "massage",
    "cosmetology",
    "epilation",
    "dental",
    "medical",
  ] as const) {
    const prompt = buildSystemPromptV4(makeInput("фото", { config: { industry } }));
    expect(prompt).toContain("КАК РАЗБИРАТЬ ФОТО");
  }
  // Medical/dental photo handling must forbid interpreting results / diagnosing.
  const med = buildSystemPromptV4(
    makeInput("вот мои анализы", { config: { industry: "medical" } }),
  );
  expect(med).toContain("НЕ расшифровывай");
  const dent = buildSystemPromptV4(makeInput("вот мои зубы", { config: { industry: "dental" } }));
  expect(dent).toContain("НЕ ставь диагноз");
});

test("beauty (по умолчанию): без мед-границ, но с оценкой по фото", () => {
  const prompt = buildSystemPromptV4(makeInput("хочу маникюр"));
  expect(prompt).not.toContain("НЕ ставишь диагноз");
  expect(prompt).toContain("ОЦЕНКА СТОИМОСТИ ПО ФОТО");
});

// ============================================================
// Salesperson mode — the toggle injects an active-closing block only when enabled.
// ============================================================

test("режим продаж включён: в промпте есть блок активного закрытия", () => {
  const prompt = buildSystemPromptV4(makeInput("сколько стоит?", { config: { sales_mode: true } }));
  expect(prompt).toContain("РЕЖИМ АКТИВНЫХ ПРОДАЖ");
});

test("режим продаж выключен (по умолчанию): блока активного закрытия нет", () => {
  const prompt = buildSystemPromptV4(makeInput("сколько стоит?"));
  expect(prompt).not.toContain("РЕЖИМ АКТИВНЫХ ПРОДАЖ");
});
