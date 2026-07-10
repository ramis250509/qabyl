// Smoke tests for runWaAgentV3 — the state machine actually wired into production
// (src/routes/api/public/wa.$salonId.ts calls runWaAgentV3, not the older runWaAgent
// tested by wa-agent.scenarios.test.ts). That suite gives zero coverage of V3; this file
// exercises the highest-risk V3 behavior added in this session: the first-message menu
// always showing (no smart auto-skip), cancel/reschedule of an existing appointment, and
// photo pricing confidence retry/escalation.
//
// Run: bun test wa-agent-v3.scenarios.test.ts
import { test, expect, mock } from "bun:test";

const dbProxy = new Proxy({} as any, {
  get(_t, prop) {
    const db = (globalThis as any).__WA_DB__;
    return db[prop];
  },
});
mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: dbProxy }));

process.env.GEMINI_API_KEY = "test-key";

const { runWaAgentV3 } = await import("@/lib/wa-agent.server");

const TZ = "Asia/Bishkek";
const SALON = { salonId: "salon1", salonName: "Тест салон", timezone: TZ };
const CONFIG = { greeting: null, tone_instructions: null, pricing_rules: null, languages: ["ru"] };

// ---- Minimal generic in-memory table mock: only the query shapes V3 actually issues. ----
function makeDb(opts: {
  services?: any[];
  masters?: any[];
  appointments?: any[];
  aiAssistant?: any;
  aiServiceOverrides?: any[];
  visionResponses?: Array<{ price: number; explanation: string; confidence: string }>;
}) {
  const services = opts.services ?? [];
  const masters = opts.masters ?? [];
  const appointments = opts.appointments ?? [];
  const aiAssistant = opts.aiAssistant ?? null;
  const aiServiceOverrides = opts.aiServiceOverrides ?? [];

  function servicesQuery() {
    const q: any = { _filters: [] };
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
      resolve({ data: masters.map((m) => ({ ...m, master_services: m.service_ids.map((id: string) => ({ service_id: id })) })) });
    return q;
  }
  function aiAssistantQuery() {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: aiAssistant });
    return q;
  }
  function aiOverridesQuery() {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.then = (resolve: any) => resolve({ data: aiServiceOverrides });
    return q;
  }
  function appointmentsQuery() {
    const q: any = { _update: null, _eqs: [] as Array<[string, any]> };
    q.select = () => q;
    q.eq = (col: string, val: any) => { q._eqs.push([col, val]); return q; };
    q.gte = () => q;
    q.order = () => q;
    q.update = (patch: any) => { q._update = patch; return q; };
    q.maybeSingle = async () => {
      const idFilter = q._eqs.find(([c]: any) => c === "id");
      const row = appointments.find((a) => a.id === idFilter?.[1]);
      return { data: row ? { ...row, services: { name: row.serviceName } } : null };
    };
    q.then = (resolve: any) => {
      if (q._update) {
        const idFilter = q._eqs.find(([c]: any) => c === "id");
        const row = appointments.find((a) => a.id === idFilter?.[1]);
        if (row) Object.assign(row, q._update);
        resolve({ error: null });
        return;
      }
      const filtered = appointments.filter((a) =>
        q._eqs.every(([c, v]: any) => a[c] === v) && a.status === "confirmed",
      );
      resolve({ data: filtered.map((a) => ({ ...a, services: { name: a.serviceName } })) });
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
      if (name === "get_available_slots") return { data: opts.masters ? [{ slot_start: "2099-01-01T04:00:00.000Z", slot_end: "2099-01-01T04:30:00.000Z" }] : [] };
      if (name === "reschedule_appointment") {
        const row = appointments.find((a) => a.id === args._appointment_id);
        if (row) { row.starts_at = args._new_starts_at; }
        return { data: args._appointment_id, error: null };
      }
      if (name === "create_appointment") {
        const id = `appt_${appointments.length + 1}`;
        appointments.push({
          id, starts_at: args._starts_at, service_id: args._service_id, master_id: args._master_id,
          salon_id: SALON.salonId, client_phone: args._client_phone, status: "confirmed",
          serviceName: services.find((s) => s.id === args._service_id)?.name ?? "?",
        });
        return { data: id, error: null };
      }
      return { data: null, error: null };
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "http://img/x.jpg" } }) }) },
  };
}

const origFetch = globalThis.fetch;
let visionQueue: Array<{ price: number; explanation: string; confidence: string }> = [];
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) {
    let body: any = {};
    try { body = JSON.parse(init?.body ?? "{}"); } catch {}
    const hasImage = (body?.contents?.[0]?.parts ?? []).some((p: any) => p?.inline_data);
    if (hasImage) {
      const next = visionQueue.shift() ?? { price: 1000, explanation: "ok", confidence: "high" };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] }, finishReason: "STOP" }] }), { status: 200 });
    }
    return new Response("no", { status: 400 }); // greeting translation etc. fall back deterministically
  }
  if (u.startsWith("http://img/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("no", { status: 400 });
}) as any;

function msg(text: string, opts: { selectedId?: string; image?: boolean } = {}) {
  return [{
    id: "m1", direction: "in" as const, kind: (opts.image ? "image" : "text") as any,
    text_body: text, media_signed_url: opts.image ? "http://img/x.jpg" : null,
    media_path: opts.image ? "p/x.jpg" : null, created_at: new Date().toISOString(),
    selected_id: opts.selectedId ?? null,
  }];
}

const SERVICE = { id: "svc1", name: "Маникюр", category: "Ногти", price: 1000, price_max: null, price_type: "fixed", duration_min: 60 };

test("V3: first message always shows the full service menu, even naming a service", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE, { ...SERVICE, id: "svc2", name: "Педикюр" }] });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Хочу записаться на маникюр"),
    branches: [], selectedBranchId: null,
    state: "idle", stateData: {},
  } as any);
  expect(res.nextState).toBe("awaiting_service");
  expect(res.interactiveMessage?.kind).toBe("list");
  // Both services show up — no auto-narrowing to just "Маникюр".
  const titles = (res.interactiveMessage as any)?.sections?.flatMap((s: any) => s.rows.map((r: any) => r.title)) ?? [];
  expect(titles.length).toBe(2);
});

test("V3: cancel intent with one upcoming appointment jumps straight to cancel-confirm", async () => {
  const appt = { id: "appt1", starts_at: "2099-01-01T04:00:00.000Z", service_id: "svc1", master_id: "m1", salon_id: "salon1", client_phone: "996700000000", status: "confirmed", serviceName: "Маникюр" };
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE], appointments: [appt] });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Хочу отменить свою запись"),
    branches: [], selectedBranchId: null,
    state: "idle", stateData: {},
  } as any);
  // "отменить" is explicit → skip the action menu, go straight to the yes/no confirm.
  expect(res.nextState).toBe("awaiting_manage_confirm");
  expect((res.nextStateData as any).v3.managing_appointment_id).toBe("appt1");
  expect((res.nextStateData as any).v3.managing_action).toBe("cancel");
});

test("V3: confirming cancel marks the appointment cancelled", async () => {
  const appt = { id: "appt1", starts_at: "2099-01-01T04:00:00.000Z", service_id: "svc1", master_id: "m1", salon_id: "salon1", client_phone: "996700000000", status: "confirmed", serviceName: "Маникюр" };
  const db = makeDb({ services: [SERVICE], appointments: [appt] });
  (globalThis as any).__WA_DB__ = db;
  const state_data: any = { language: "ru", v3: { managing_appointment_id: "appt1", managing_appointment_label: "Маникюр — ..." } };
  const afterAction = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("отменить", { selectedId: "manage_cancel" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_manage_action", stateData: state_data,
  } as any);
  expect(afterAction.nextState).toBe("awaiting_manage_confirm");

  const afterConfirm = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("да", { selectedId: "confirm_yes" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_manage_confirm", stateData: afterAction.nextStateData,
  } as any);
  expect(afterConfirm.nextState).toBe("done");
  expect(appt.status).toBe("cancelled");
});

test("V3: low-confidence photo asks for a retry, then escalates to admin on the 2nd attempt", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [{ ...SERVICE, price_type: "range", price: 500, price_max: 1500 }] });
  visionQueue = [
    { price: 800, explanation: "неясно", confidence: "low" },
    { price: 800, explanation: "всё ещё неясно", confidence: "low" },
  ];
  const baseState: any = { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр", price_type: "range", price_min: 500, price_max: 1500 } };

  const first = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { image: true }),
    branches: [], selectedBranchId: null,
    state: "awaiting_photo", stateData: baseState,
  } as any);
  expect(first.nextState).toBe("awaiting_photo");
  expect((first.nextStateData as any).v3.photo_attempts).toBe(1);
  expect(first.notifyAdmin).toBeUndefined();

  const second = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { image: true }),
    branches: [], selectedBranchId: null,
    state: "awaiting_photo", stateData: first.nextStateData,
  } as any);
  expect(second.nextState).toBe("done");
  expect(second.notifyAdmin?.mediaUrl).toBe("http://img/x.jpg");
});

test("V3: a bare greeting mid-dialog restarts the conversation with a fresh menu", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE, { ...SERVICE, id: "svc2", name: "Педикюр" }] });
  const midState: any = { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр", date: "2099-01-02" } };
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Здравствуйте"),
    branches: [], selectedBranchId: null,
    state: "awaiting_date_choice", stateData: midState,
  } as any);
  expect(res.debug.actions).toContain("greeting_restart");
  // Draft wiped — no stale service/date carried into the restarted dialog.
  expect((res.nextStateData as any).v3.service_id).toBeUndefined();
  expect((res.nextStateData as any).v3.date).toBeUndefined();
  // Fresh service menu shown again.
  expect(res.interactiveMessage?.kind).toBe("list");
});

test("V3: a Kyrgyz greeting mid-dialog also restarts the conversation", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const midState: any = { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр", date: "2099-01-02" } };
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Ассалам алейкум"),
    branches: [], selectedBranchId: null,
    state: "awaiting_slot_choice", stateData: midState,
  } as any);
  expect(res.debug.actions).toContain("greeting_restart");
  expect((res.nextStateData as any).v3.service_id).toBeUndefined();
});

test("V3: a greeting WITH content mixed in does NOT restart (keeps the flow)", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const midState: any = { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр" } };
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Здравствуйте, хочу маникюр"),
    branches: [], selectedBranchId: null,
    state: "awaiting_date_choice", stateData: midState,
  } as any);
  expect(res.debug.actions).not.toContain("greeting_restart");
});

test("V3: slot list is grouped by part of day with a section header", async () => {
  (globalThis as any).__WA_DB__ = makeDb({
    services: [SERVICE],
    masters: [{ id: "m1", name: "Анна", branch_id: null, sort_order: 0, service_ids: ["svc1"] }],
  });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "date_2099-01-01" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_date_choice",
    stateData: { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр", price_type: "fixed" } },
  } as any);
  expect(res.nextState).toBe("awaiting_slot_choice");
  expect(res.interactiveMessage?.kind).toBe("list");
  const sections = (res.interactiveMessage as any).sections;
  // 04:00 UTC = 10:00 Asia/Bishkek → grouped under the "Утром" header, rowId maps to slots_cache[0].
  expect(sections[0].title).toBe("Утром");
  expect(sections[0].rows[0].rowId).toBe("slot_0");
});

test("V3: a slot that has since passed is rejected and fresh times are shown", async () => {
  (globalThis as any).__WA_DB__ = makeDb({
    services: [SERVICE],
    masters: [{ id: "m1", name: "Анна", branch_id: null, sort_order: 0, service_ids: ["svc1"] }],
  });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "slot_0" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_slot_choice",
    stateData: { language: "ru", v3: {
      service_id: "svc1", service_name: "Маникюр", date: "2099-01-01",
      // A stale cached slot in the past — must not be bookable.
      slots_cache: [{ start: "2020-01-01T04:00:00.000Z", end: "2020-01-01T05:00:00.000Z", masterIds: ["m1"] }],
    } },
  } as any);
  // Past slot rejected → stays on slot choice with fresh future times, NOT advancing to the name step.
  expect(res.nextState).toBe("awaiting_slot_choice");
  expect(res.reply).toContain("прошло");
});

test("V3: ad lead (greeting + vague inquiry) gets the configured greeting + full service list", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE, { ...SERVICE, id: "svc2", name: "Педикюр" }] });
  const res = await runWaAgentV3({
    salon: SALON,
    config: { ...CONFIG, greeting: "Добро пожаловать в наш салон! Сейчас акция." },
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Здравствуйте, можно узнать об этом поподробнее"),
    branches: [], selectedBranchId: null,
    state: "idle", stateData: {},
  } as any);
  // Always the admin-configured greeting up front, then the full service list.
  expect(res.reply).toContain("Добро пожаловать");
  expect(res.nextState).toBe("awaiting_service");
  expect(res.interactiveMessage?.kind).toBe("list");
});

test("V3: greeting + vague inquiry MID-FLOW restarts to greeting + menu", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const res = await runWaAgentV3({
    salon: SALON,
    config: { ...CONFIG, greeting: "Добро пожаловать!" },
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Здравствуйте, расскажите поподробнее"),
    branches: [], selectedBranchId: null,
    state: "awaiting_date_choice",
    stateData: { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр", date: "2099-01-02" } },
  } as any);
  expect(res.debug.actions).toContain("greeting_restart");
  expect(res.reply).toContain("Добро пожаловать");
  expect((res.nextStateData as any).v3.service_id).toBeUndefined();
});

test("V3: greeting + a CONCRETE service request does NOT restart (keeps the request)", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const res = await runWaAgentV3({
    salon: SALON,
    config: { ...CONFIG, greeting: "Добро пожаловать!" },
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("Здравствуйте, хочу записаться на маникюр 15 числа"),
    branches: [], selectedBranchId: null,
    state: "awaiting_date_choice",
    stateData: { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр" } },
  } as any);
  expect(res.debug.actions).not.toContain("greeting_restart");
});

test("V3: booking success attaches Перенести/Отменить buttons for the just-created appointment", async () => {
  (globalThis as any).__WA_DB__ = makeDb({
    services: [SERVICE],
    masters: [{ id: "m1", name: "Анна", branch_id: null, sort_order: 0, service_ids: ["svc1"] }],
  });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("да", { selectedId: "confirm_yes" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_final_confirm",
    stateData: { language: "ru", v3: {
      service_id: "svc1", service_name: "Маникюр", date: "2099-01-01",
      slot_start: "2099-01-01T04:00:00.000Z", slot_end: "2099-01-01T04:30:00.000Z",
      master_id: "m1", master_name: "Анна", client_name: "Аяна",
    } },
  } as any);
  expect(res.nextState).toBe("done");
  expect(res.appointmentId).toBeTruthy();
  expect(res.interactiveMessage?.kind).toBe("buttons");
  const ids = (res.interactiveMessage as any).buttons.map((b: any) => b.id);
  expect(ids).toEqual(["postbook_reschedule", "postbook_cancel", "postbook_change"]);
  const v3 = (res.nextStateData as any).v3;
  expect(v3.managing_appointment_id).toBe(res.appointmentId);
  expect(v3.managing_appointment_starts_at).toBe("2099-01-01T04:00:00.000Z");
});

test("V3: booking success includes the salon/branch address", async () => {
  (globalThis as any).__WA_DB__ = makeDb({
    services: [SERVICE],
    masters: [{ id: "m1", name: "Анна", branch_id: null, sort_order: 0, service_ids: ["svc1"] }],
  });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("да", { selectedId: "confirm_yes" }),
    branches: [{ id: "b1", name: "Центр", address: "ул. Киевская, 95" }],
    selectedBranchId: "b1",
    state: "awaiting_final_confirm",
    stateData: { language: "ru", v3: {
      service_id: "svc1", service_name: "Маникюр", date: "2099-01-01",
      slot_start: "2099-01-01T04:00:00.000Z", slot_end: "2099-01-01T04:30:00.000Z",
      master_id: "m1", master_name: "Анна", client_name: "Аяна", branch_id: "b1",
    } },
  } as any);
  expect(res.reply).toContain("ул. Киевская, 95");
});

test("V3: tapping 'Отменить запись' after booking goes straight to cancel-confirm", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "postbook_cancel" }),
    branches: [], selectedBranchId: null,
    state: "done",
    stateData: { language: "ru", v3: {
      managing_appointment_id: "appt_1",
      managing_appointment_label: "Маникюр — 1 января, 10:00",
      managing_service_id: "svc1", managing_master_id: "m1",
      managing_appointment_starts_at: "2099-01-01T04:00:00.000Z",
    } },
  } as any);
  expect(res.nextState).toBe("awaiting_manage_confirm");
  expect((res.nextStateData as any).v3.managing_action).toBe("cancel");
});

test("V3: tapping 'Перенести запись' after booking starts the reschedule date flow", async () => {
  (globalThis as any).__WA_DB__ = makeDb({
    services: [SERVICE],
    masters: [{ id: "m1", name: "Анна", branch_id: null, sort_order: 0, service_ids: ["svc1"] }],
  });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "postbook_reschedule" }),
    branches: [], selectedBranchId: null,
    state: "done",
    stateData: { language: "ru", v3: {
      managing_appointment_id: "appt_1",
      managing_appointment_label: "Маникюр — 1 января, 10:00",
      managing_service_id: "svc1", managing_master_id: "m1",
      managing_appointment_starts_at: "2099-01-01T04:00:00.000Z",
    } },
  } as any);
  expect(res.nextState).toBe("awaiting_reschedule_date");
});

test("V3: tapping 'Изменить запись' cancels then re-shows the service menu", async () => {
  const appt = { id: "appt_1", starts_at: "2099-01-01T04:00:00.000Z", service_id: "svc1", master_id: "m1", salon_id: "salon1", client_phone: "996700000000", status: "confirmed", serviceName: "Маникюр" };
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE, { ...SERVICE, id: "svc2", name: "Педикюр" }], appointments: [appt] });
  const afterTap = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "postbook_change" }),
    branches: [], selectedBranchId: null,
    state: "done",
    stateData: { language: "ru", v3: {
      managing_appointment_id: "appt_1",
      managing_appointment_label: "Маникюр — 1 января, 10:00",
      managing_service_id: "svc1", managing_master_id: "m1",
      managing_appointment_starts_at: "2099-01-01T04:00:00.000Z",
    } },
  } as any);
  expect(afterTap.nextState).toBe("awaiting_manage_confirm");
  expect((afterTap.nextStateData as any).v3.managing_action).toBe("cancel_and_rebook");

  const afterConfirm = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("да", { selectedId: "confirm_yes" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_manage_confirm", stateData: afterTap.nextStateData,
  } as any);
  expect(appt.status).toBe("cancelled");
  expect(afterConfirm.nextState).toBe("awaiting_service");
  expect(afterConfirm.interactiveMessage?.kind).toBe("list");
});

test("V3: 'Назад' from date-choice returns to the full service list", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE, { ...SERVICE, id: "svc2", name: "Педикюр" }] });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "back" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_date_choice",
    stateData: { language: "ru", v3: { service_id: "svc1", service_name: "Маникюр", date: "2099-01-02" } },
  } as any);
  expect(res.nextState).toBe("awaiting_service");
  expect((res.nextStateData as any).v3.service_id).toBeUndefined();
});

test("V3: 'Назад' from slot-choice returns to date-choice, clearing the chosen date", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "back" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_slot_choice",
    stateData: { language: "ru", v3: {
      service_id: "svc1", service_name: "Маникюр", date: "2099-01-02",
      slots_cache: [{ start: "2099-01-02T04:00:00.000Z", end: "2099-01-02T04:30:00.000Z", masterIds: ["m1"] }],
    } },
  } as any);
  expect(res.nextState).toBe("awaiting_date_choice");
  expect((res.nextStateData as any).v3.date).toBeUndefined();
  expect((res.nextStateData as any).v3.service_id).toBe("svc1"); // service kept, only date cleared
});

test("V3: 'Назад' from name-entry returns to slot-choice using the cached slots", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ services: [SERVICE] });
  const res = await runWaAgentV3({
    salon: SALON, config: CONFIG,
    client: { phone: "996700000000", name: "Аяна" },
    history: [], lastMessages: msg("", { selectedId: "back" }),
    branches: [], selectedBranchId: null,
    state: "awaiting_name",
    stateData: { language: "ru", v3: {
      service_id: "svc1", service_name: "Маникюр", date: "2099-01-02",
      slot_start: "2099-01-02T04:00:00.000Z", slot_end: "2099-01-02T04:30:00.000Z",
      master_id: "m1", master_name: "Анна",
      slots_cache: [{ start: "2099-01-02T04:00:00.000Z", end: "2099-01-02T04:30:00.000Z", masterIds: ["m1"] }],
    } },
  } as any);
  expect(res.nextState).toBe("awaiting_slot_choice");
  expect((res.nextStateData as any).v3.master_id).toBeUndefined();
  expect(res.interactiveMessage?.kind).toBe("list");
});

test("cleanup: restore fetch", () => {
  globalThis.fetch = origFetch;
  expect(true).toBe(true);
});
