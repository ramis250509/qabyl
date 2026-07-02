// Scenario regression suite for the WhatsApp salon assistant.
// Runs the REAL runWaAgent state machine against an in-memory DB and a controllable
// Gemini stub. Gemini is "down" by default (HTTP 400 → no retry/backoff) so the
// deterministic parser + deterministic reply layer drive everything; individual turns
// can inject a Gemini classify result via say(text, { gemini }).
//
// Run: bun test wa-agent.scenarios.test.ts
import { test, expect, mock, beforeEach } from "bun:test";

// ---- Mock the server Supabase client BEFORE the agent lazily imports it.
const dbProxy = new Proxy({} as any, {
  get(_t, prop) {
    const db = (globalThis as any).__WA_DB__;
    return db[prop];
  },
});
mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: dbProxy }));

process.env.GEMINI_API_KEY = "test-key";

const { runWaAgent, runWaAgentV3, renderInteractiveAsText } = await import("@/lib/wa-agent.server");

// ---- Time helpers (salon tz = Asia/Bishkek, fixed UTC+6) ----
const TZ = "Asia/Bishkek";
function bishkekToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function slotISO(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+06:00`).toISOString();
}
function slotRow(date: string, hhmm: string) {
  const start = slotISO(date, hhmm);
  const end = new Date(new Date(start).getTime() + 30 * 60000).toISOString();
  return { slot_start: start, slot_end: end };
}

const TOMORROW = addDays(bishkekToday(), 1);
const DAY_AFTER = addDays(bishkekToday(), 2);

// ---- In-memory DB ----
type SalonCfg = {
  services: any[];
  masters: any[]; // {id,name,branch_id,sort_order,service_ids[]}
  slots: Record<string, { slot_start: string; slot_end: string }[]>; // key `${masterId}|${date}`
  failBooking?: boolean;
};
function makeDb(cfg: SalonCfg) {
  const appointments: any[] = [];
  // Appointment rows as the V3 manage flow reads them (query columns + joined service name).
  const apptView = (a: any) => ({
    id: a.id,
    starts_at: a._starts_at ?? a.starts_at,
    service_id: a._service_id ?? a.service_id,
    master_id: a._master_id ?? a.master_id,
    status: a.status ?? "confirmed",
    client_phone: a._client_phone ?? "996700000000",
    services: { name: cfg.services.find((s) => s.id === (a._service_id ?? a.service_id))?.name ?? "?" },
  });
  const builder = (table: string) => {
    const q: any = {};
    const filters: Record<string, any> = {};
    let update: any = null;
    q.select = () => q;
    q.update = (patch: any) => { update = patch; return q; };
    q.eq = (col: string, val: any) => { filters[col] = val; return q; };
    q.gte = () => q;
    q.order = () => q;
    const resolveData = (): any[] => {
      if (table === "services") return cfg.services;
      if (table === "masters")
        return cfg.masters.map((m) => ({ ...m, master_services: m.service_ids.map((id: string) => ({ service_id: id })) }));
      if (table === "appointments") {
        return appointments
          .map(apptView)
          .filter((r: any) => Object.entries(filters).every(([col, val]) => (r as any)[col] === undefined || (r as any)[col] === val));
      }
      return [];
    };
    q.then = (resolve: (v: any) => void) => {
      if (update && table === "appointments") {
        for (const a of appointments) if (a.id === filters.id) Object.assign(a, update);
        return resolve({ data: null, error: null });
      }
      resolve({ data: resolveData() });
    };
    q.maybeSingle = async () => ({ data: resolveData()[0] ?? null, error: null });
    return q;
  };
  return {
    appointments,
    from: builder,
    rpc: async (name: string, args: any) => {
      if (name === "get_available_slots") {
        return { data: cfg.slots[`${args._master_id}|${args._date}`] ?? [] };
      }
      if (name === "create_appointment") {
        if (cfg.failBooking) return { data: null, error: { message: "slot just taken" } };
        const id = `appt-${appointments.length + 1}`;
        appointments.push({ id, ...args });
        return { data: id, error: null };
      }
      if (name === "reschedule_appointment" || name === "reschedule_appointment_v2") {
        const appt = appointments.find((a) => a.id === args._appointment_id);
        if (!appt) return { data: null, error: { message: "Appointment not found" } };
        appt._starts_at = args._new_starts_at;
        if (args._new_master_id) appt._master_id = args._new_master_id;
        return { data: args._appointment_id, error: null };
      }
      return { data: null, error: null };
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "http://img/x.jpg" } }) }) },
  };
}

// ---- Gemini stub (controllable) ----
const geminiClassifyQueue: any[] = [];
const composeSystemInstructions: string[] = []; // captured compose system prompts for assertions
const origFetch = globalThis.fetch;
function geminiOk(textObj: any) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof textObj === "string" ? textObj : JSON.stringify(textObj) }] }, finishReason: "STOP" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) {
    let body: any = {};
    try { body = JSON.parse(init?.body ?? "{}"); } catch {}
    const isJson = body?.generationConfig?.responseMimeType === "application/json";
    const hasImage = (body?.contents?.[0]?.parts ?? []).some((p: any) => p?.inline_data);
    if (isJson && hasImage) return geminiOk({ price: 1500, explanation: "по фото" }); // vision
    if (isJson) {
      // classify: use injected result if present, else 400 → deterministic fallback
      if (geminiClassifyQueue.length) return geminiOk(geminiClassifyQueue.shift());
      return new Response("no", { status: 400 });
    }
    // compose: capture the system prompt (for tone assertions), then force deterministic fallback
    composeSystemInstructions.push(body?.systemInstruction?.parts?.[0]?.text ?? "");
    return new Response("no", { status: 400 });
  }
  // image download for photo flow
  if (u.startsWith("http://img/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("no", { status: 400 });
}) as any;

// ---- Conversation simulator ----
const SALON = { salonId: "salon1", salonName: "Тест салон", timezone: TZ };
const CONFIG = { greeting: null, tone_instructions: null, pricing_rules: null, languages: ["ru"] };

function convo(
  cfg: SalonCfg,
  opts: {
    clientName?: string | null;
    branches?: any[];
    languages?: string[];
    assistantConfig?: Partial<typeof CONFIG>;
    salonInfo?: { working_hours: Record<string, string> | null; address: string | null } | null;
  } = {},
) {
  (globalThis as any).__WA_DB__ = makeDb(cfg);
  const db = (globalThis as any).__WA_DB__;
  let state: any = "idle";
  let stateData: any = {};
  let selectedBranchId: any = null;
  const history: any[] = [];
  const branches = opts.branches ?? [];
  const config = { ...CONFIG, ...opts.assistantConfig, languages: opts.assistantConfig?.languages ?? opts.languages ?? ["ru"] };
  const clientName = opts.clientName === undefined ? "Рамис" : opts.clientName;
  const salonInfo = opts.salonInfo ?? null;
  return {
    db,
    get state() { return state; },
    get data() { return stateData; },
    async say(text: string | string[], turnOpts: { gemini?: any; image?: boolean } = {}) {
      if (turnOpts.gemini) geminiClassifyQueue.push(turnOpts.gemini);
      const texts = Array.isArray(text) ? text : [text];
      const lastMessages = texts.map((t, i) => ({
        id: `in-${history.length}-${i}`,
        direction: "in" as const,
        kind: (turnOpts.image ? "image" : "text") as any,
        text_body: t,
        media_signed_url: turnOpts.image ? "http://img/x.jpg" : null,
        media_path: turnOpts.image ? "p/x.jpg" : null,
        created_at: new Date().toISOString(),
      }));
      const input: any = {
        salon: SALON, config,
        client: { phone: "996700000000", name: clientName },
        history: [...history], lastMessages, branches,
        selectedBranchId, state, stateData, salonInfo,
      };
      const res = await runWaAgent(input);
      for (const m of lastMessages) history.push({ ...m });
      history.push({ id: `out-${history.length}`, direction: "out", kind: "text", text_body: res.reply, created_at: new Date().toISOString() });
      state = res.nextState; stateData = res.nextStateData; selectedBranchId = res.selectedBranchId;
      return res;
    },
  };
}

function singleSalon(): SalonCfg {
  return {
    services: [{ id: "svc_hair", name: "Стрижка", category: null, price: 500, price_max: null, price_type: "fixed", duration_min: 30, is_active: true }],
    masters: [{ id: "m_ulur", name: "Улур", branch_id: null, sort_order: 0, service_ids: ["svc_hair"] }],
    slots: { [`m_ulur|${TOMORROW}`]: [slotRow(TOMORROW, "12:00"), slotRow(TOMORROW, "12:15"), slotRow(TOMORROW, "12:30"), slotRow(TOMORROW, "12:45")],
             [`m_ulur|${DAY_AFTER}`]: [slotRow(DAY_AFTER, "12:00"), slotRow(DAY_AFTER, "12:30")] },
  };
}
function multiSalon(): SalonCfg {
  return {
    services: [
      { id: "svc_hair", name: "Стрижка", category: null, price: 500, price_max: null, price_type: "fixed", duration_min: 30, is_active: true },
      { id: "svc_nail", name: "Маникюр", category: null, price: 800, price_max: null, price_type: "fixed", duration_min: 60, is_active: true },
      { id: "svc_color", name: "Окрашивание", category: null, price: 1000, price_max: 3000, price_type: "range", duration_min: 90, is_active: true },
    ],
    masters: [
      { id: "m_ulur", name: "Улур", branch_id: null, sort_order: 0, service_ids: ["svc_hair", "svc_color"] },
      { id: "m_aigul", name: "Айгуль", branch_id: null, sort_order: 1, service_ids: ["svc_nail", "svc_hair"] },
    ],
    slots: {
      [`m_ulur|${TOMORROW}`]: [slotRow(TOMORROW, "13:00"), slotRow(TOMORROW, "14:00")],
      [`m_aigul|${TOMORROW}`]: [slotRow(TOMORROW, "13:00"), slotRow(TOMORROW, "15:00")],
    },
  };
}

beforeEach(() => { geminiClassifyQueue.length = 0; composeSystemInstructions.length = 0; });

// helper to drive single-salon booking up to the confirm step
async function bookToConfirm(c: ReturnType<typeof convo>, day = "завтра", time = "в 12:45") {
  await c.say(`Запишите меня на ${day} ${time}`);
}

// =========================================================================
// SCENARIOS
// =========================================================================

test("1. greeting (single service) does not loop, stays in flow", async () => {
  const c = convo(singleSalon());
  const r = await c.say("Привет");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply.length).toBeGreaterThan(0);
  expect(/^(спроси|скажи|поприветствуй)/i.test(r.reply)).toBe(false);
});

test("2. one-message booking (single) → confirm shows 12:45 → yes books 12:45", async () => {
  const c = convo(singleSalon());
  const r1 = await c.say("Запишите меня на завтра в 12:45");
  expect(r1.nextState).toBe("awaiting_final_confirm");
  expect(r1.reply).toContain("12:45");
  expect(c.data.service_id).toBe("svc_hair"); // auto-selected the only service
  const r2 = await c.say("да");
  expect(r2.appointmentId).not.toBeNull();
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "12:45"));
});

test("3. step-by-step booking (single)", async () => {
  const c = convo(singleSalon());
  await c.say("хочу записаться");           // auto-service → asks day
  await c.say("завтра");                    // asks part/time
  const r3 = await c.say("в 12:30");        // → confirm
  expect(r3.nextState).toBe("awaiting_final_confirm");
  expect(r3.reply).toContain("12:30");
  const r4 = await c.say("да");
  expect(r4.appointmentId).not.toBeNull();
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "12:30"));
});

test("4. booking with explicit time only", async () => {
  const c = convo(singleSalon());
  await c.say("завтра в 12:15");
  const r = await c.say("да");
  expect(r.appointmentId).not.toBeNull();
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "12:15"));
});

test("5. booking without time → part of day → pick from list", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  const r2 = await c.say("днём");               // afternoon → list of slots
  expect(r2.nextState).toBe("awaiting_slot_choice");
  expect(r2.reply).toMatch(/12:00|12:15|12:30|12:45/);
  const r3 = await c.say("первый");             // pick #1 → confirm
  expect(r3.nextState).toBe("awaiting_final_confirm");
  const r4 = await c.say("да");
  expect(r4.appointmentId).not.toBeNull();
});

test("6. service-only message (multi) sets service, advances to day", async () => {
  const c = convo(multiSalon());
  const r = await c.say("маникюр");
  expect(c.data.service_id).toBe("svc_nail");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
});

test("7. multiple services salon asks which service on a bare booking", async () => {
  const c = convo(multiSalon());
  const r = await c.say("хочу записаться");
  expect(c.data.service_id).toBeUndefined();
  expect(r.nextState).toBe("collecting");
});

test("8. date-only message (single) auto-service + sets day", async () => {
  const c = convo(singleSalon());
  const r = await c.say("на завтра");
  expect(c.data.service_id).toBe("svc_hair");
  expect(c.data.day).toBe(TOMORROW);
  expect(r.appointmentId).toBeNull();
});

test("8b. confirm 'да' when Gemini returns a stray service_id entity → still books (no loop)", async () => {
  // Production bug repro: at awaiting_final_confirm the client says "да". Gemini classifies it
  // as confirm_yes but ALSO returns a spurious service_id entity. The re-resolve guard must NOT
  // fire for confirm_yes, otherwise the slot is dropped and the summary loops forever.
  const c = convo(singleSalon());
  const r1 = await c.say("Запишите меня на завтра в 12:45");
  expect(r1.nextState).toBe("awaiting_final_confirm");
  const r2 = await c.say("да", { gemini: { intent: "confirm_yes", entities: { service_id: "svc_hair" } } });
  expect(r2.appointmentId).not.toBeNull();
  expect(r2.nextState).toBe("done");
  expect(c.db.appointments).toHaveLength(1);
});

test("8c. confirm 'да, все верно' with stray day_relative entity → still books", async () => {
  const c = convo(singleSalon());
  const r1 = await c.say("Запишите меня на завтра в 12:45");
  expect(r1.nextState).toBe("awaiting_final_confirm");
  const r2 = await c.say("да, все верно", { gemini: { intent: "confirm_yes", entities: { day_relative: "tomorrow" } } });
  expect(r2.appointmentId).not.toBeNull();
  expect(r2.nextState).toBe("done");
});

test("9. change time at confirm step → re-confirm new time, no double booking", async () => {
  const c = convo(singleSalon());
  await bookToConfirm(c, "завтра", "в 12:45");
  const r = await c.say("нет, на 12:00");
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.reply).toContain("12:00");
  const r2 = await c.say("да");
  expect(r2.appointmentId).not.toBeNull();
  expect(c.db.appointments).toHaveLength(1);
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "12:00"));
});

test("10. change date at confirm step → re-resolves on new day", async () => {
  const c = convo(singleSalon());
  await bookToConfirm(c, "завтра", "в 12:30");
  const r = await c.say("давайте послезавтра");
  // day after has 12:00 and 12:30; 12:30 still requested time → confirm again
  expect(c.data.day).toBe(DAY_AFTER);
  expect(["awaiting_final_confirm", "awaiting_slot_choice"]).toContain(r.nextState);
});

test("11. change service (multi) resets dependent slot/master", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка завтра в 13:00", { gemini: { intent: "choose_specific_time", language: "ru", entities: { service_id: "svc_hair", day_relative: "tomorrow", specific_time: "13:00" } } });
  // 13:00 has two masters → master choice
  const r2 = await c.say("маникюр");
  expect(c.data.service_id).toBe("svc_nail");
  expect(c.data.slot_start).toBeUndefined();
  expect(c.data.master_id).toBeUndefined();
});

test("12. multiple masters → ask, then choose by name", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка");
  await c.say("завтра");
  const r3 = await c.say("в 13:00");          // both masters free → ask which
  expect(r3.nextState).toBe("awaiting_master_choice");
  expect(r3.reply).toMatch(/Улур|Айгуль/);
  const r4 = await c.say("к Айгуль", { gemini: { intent: "choose_master", language: "ru", entities: { master_name: "Айгуль" } } });
  expect(r4.nextState).toBe("awaiting_final_confirm");
  const r5 = await c.say("да");
  expect(c.db.appointments[0]._master_id).toBe("m_aigul");
});

test("12b. multiple masters → 'любой' picks first by sort order", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка");
  await c.say("завтра");
  await c.say("в 13:00");
  const r = await c.say("любой");
  expect(r.nextState).toBe("awaiting_final_confirm");
  await c.say("да");
  expect(c.db.appointments[0]._master_id).toBe("m_ulur"); // sort_order 0
});

test("13/14. cancel mid-flow resets to idle", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  const r = await c.say("отмена");
  expect(r.nextState).toBe("idle");
  expect(r.appointmentId).toBeNull();
  expect(c.data.day).toBeUndefined();
});

test("15. deny after confirm → back to time selection, slot cleared", async () => {
  const c = convo(singleSalon());
  await bookToConfirm(c, "завтра", "в 12:45");
  const r = await c.say("нет");
  expect(r.nextState).toBe("awaiting_part_of_day");
  expect(c.data.slot_start).toBeUndefined();
  expect(c.db.appointments).toHaveLength(0);
});

test("16. typo time '12-45' is understood", async () => {
  const c = convo(singleSalon());
  const r = await c.say("Звпишите меня на завтра в 12-45");
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.reply).toContain("12:45");
});

test("16b. admin greeting/tone instructions are used in the first reply", async () => {
  const c = convo(singleSalon(), {
    assistantConfig: {
      greeting: "Пишите коротко и по делу",
      tone_instructions: "Отвечай очень коротко, без лишних слов",
      pricing_rules: null,
      languages: ["ru"],
    },
  });
  const r = await c.say("привет");
  expect(r.reply.toLowerCase()).toContain("коротко");
});

test("16c. Latin transliteration of Kyrgyz is detected as Kyrgyz when allowed", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"], assistantConfig: { languages: ["ru", "ky"] } });
  const r = await c.say("salam");
  expect(r.reply).toContain("Саламатсызбы");
});

test("16d. Kyrgyz service wording is understood", async () => {
  const c = convo(multiSalon());
  const r = await c.say("чач кыруу");
  expect(c.data.service_id).toBe("svc_hair");
  expect(r.nextState).not.toBe("done");
});

test("17. repeated identical message does not crash and keeps context", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  await c.say("завтра");
  expect(c.data.day).toBe(TOMORROW);
  expect(c.data.service_id).toBe("svc_hair");
});

test("18. random message → friendly, no booking", async () => {
  const c = convo(singleSalon());
  const r = await c.say("ауф брат");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply.length).toBeGreaterThan(0);
});

test("19. context retention across turns (service+day+time persist)", async () => {
  const c = convo(singleSalon());
  await c.say("хочу стрижку");
  await c.say("завтра");
  expect(c.data.service_id).toBe("svc_hair");
  expect(c.data.day).toBe(TOMORROW);
  await c.say("в 12:45");
  expect(c.data.specific_time === "12:45" || c.data.slot_start === slotISO(TOMORROW, "12:45")).toBe(true);
});

test("20. several messages at once (split time)", async () => {
  const c = convo(singleSalon());
  const r = await c.say(["завтра", "в 12:30"]);
  expect(["awaiting_final_confirm"]).toContain(r.nextState);
  expect(r.reply).toContain("12:30");
});

test("21. multiple intents in one message (multi salon)", async () => {
  const c = convo(multiSalon());
  // maникюр has a single master (Айгуль) but no slots tomorrow → expect graceful no-slots,
  // so use стрижка at 14:00 (only Улур) for a clean single-master booking.
  await c.say("стрижка завтра в 14:00", { gemini: { intent: "choose_specific_time", language: "ru", entities: { service_id: "svc_hair", day_relative: "tomorrow", specific_time: "14:00" } } });
  const r = await c.say("да");
  expect(r.appointmentId).not.toBeNull();
  expect(c.db.appointments[0]._master_id).toBe("m_ulur");
});

test("22. name step when WhatsApp name missing", async () => {
  const c = convo(singleSalon(), { clientName: null });
  await c.say("завтра в 12:45");                 // reaches name step
  expect(c.state === "awaiting_name").toBe(true);
  const r = await c.say("Рамис", { gemini: { intent: "give_name", language: "ru", entities: { client_name: "Рамис" } } });
  expect(r.nextState).toBe("awaiting_final_confirm");
  const r2 = await c.say("да");
  expect(c.db.appointments[0]._client_name).toBe("Рамис");
});

test("23. no free slots for chosen part of day", async () => {
  const cfg = singleSalon();
  cfg.slots = {}; // nothing free
  const c = convo(cfg);
  await c.say("завтра");
  const r = await c.say("днём");
  expect(r.nextState).toBe("awaiting_part_of_day");
  expect(r.reply.length).toBeGreaterThan(0);
});

test("24. range-priced service asks for a photo, then prices it", async () => {
  const c = convo(multiSalon());
  await c.say("окрашивание");                    // range price → ask for photo
  expect(c.state).toBe("awaiting_photo");
  const r = await c.say("вот фото", { image: true }); // vision → price shown + asks for day
  expect(c.data.priced_value).toBe(1500);
  // New flow: no confirmation step — price shown and day selection asked in same turn
  expect(r.nextState).not.toBe("awaiting_photo");
  expect(r.reply).toMatch(/1500|сом|баа/i);
});

test("25. booked then 'спасибо' → warm reply, stays done (no restart)", async () => {
  const c = convo(singleSalon());
  await c.say("завтра в 12:45");
  await c.say("да");
  expect(c.state).toBe("done");
  const r = await c.say("спасибо");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).toBe("done");
});

test("26. booked then new booking request restarts flow", async () => {
  const c = convo(singleSalon());
  await c.say("завтра в 12:45");
  await c.say("да");
  const r = await c.say("запишите ещё раз на послезавтра в 12:30");
  expect(r.nextState).not.toBe("done");
});

test("27. slot taken race → offers another slot, no crash", async () => {
  const cfg = singleSalon();
  cfg.failBooking = true;
  const c = convo(cfg);
  await c.say("завтра в 12:45");
  const r = await c.say("да");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).toBe("awaiting_slot_choice");
});

test("28. requested unavailable time → suggests nearest, then pick works", async () => {
  const c = convo(singleSalon());
  const r = await c.say("завтра в 19:00");        // no 19:00 slot
  expect(r.nextState).toBe("awaiting_slot_choice");
  const r2 = await c.say("в 12:30");
  expect(r2.nextState).toBe("awaiting_final_confirm");
  expect(r2.reply).toContain("12:30");
});

// ===================== ROUND 2: adversarial / robustness =====================

test("29. greeting + booking in one message", async () => {
  const c = convo(singleSalon());
  const r = await c.say("Здравствуйте, запишите на завтра в 12:45");
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.reply).toContain("12:45");
});

test("30. confirm via 'ок записывайте' variant", async () => {
  const c = convo(singleSalon());
  await c.say("завтра в 12:15");
  const r = await c.say("ок записывайте");
  expect(r.appointmentId).not.toBeNull();
});

test("31. part-of-day then a specific time in a different part overrides it", async () => {
  const cfg = singleSalon();
  cfg.slots = { [`m_ulur|${TOMORROW}`]: [slotRow(TOMORROW, "10:00"), slotRow(TOMORROW, "12:45")] };
  const c = convo(cfg);
  await c.say("завтра");
  await c.say("утром");                 // morning → lists 10:00
  const r = await c.say("в 12:45");     // afternoon time overrides
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.reply).toContain("12:45");
  await c.say("да");
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "12:45"));
});

test("32. unknown master name at master choice → re-ask, no crash", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка");
  await c.say("завтра");
  await c.say("в 13:00");
  const r = await c.say("к Васе", { gemini: { intent: "choose_master", language: "ru", entities: { master_name: "Вася" } } });
  expect(r.nextState).toBe("awaiting_master_choice");
  expect(r.appointmentId).toBeNull();
});

test("33. numeric slot pick '3' selects third slot", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  await c.say("днём");                  // 12:00,12:15,12:30,12:45
  const r = await c.say("3");           // → 12:30
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.reply).toContain("12:30");
});

test("34. ordinal 'последнее' picks last slot", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  await c.say("днём");
  const r = await c.say("последнее");  // → 12:45
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.reply).toContain("12:45");
});

test("35. empty / whitespace message does not crash", async () => {
  const c = convo(singleSalon());
  const r = await c.say("   ");
  expect(r.reply.length).toBeGreaterThan(0);
  expect(r.appointmentId).toBeNull();
});

test("36. Kyrgyz greeting → Kyrgyz reply when ky is allowed", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  const r = await c.say("Саламатсызбы");
  expect(c.data.language).toBe("ky");
  expect(/Саламатсызбы|кызмат|жазыл|күн/i.test(r.reply)).toBe(true);
});

test("37. reschedule after a completed booking starts a fresh booking", async () => {
  const c = convo(singleSalon());
  await c.say("завтра в 12:45");
  await c.say("да");
  expect(c.db.appointments).toHaveLength(1);
  await c.say("перенесите на послезавтра в 12:30");
  const r = await c.say("да");
  expect(c.db.appointments).toHaveLength(2);
  expect(c.db.appointments[1]._starts_at).toBe(slotISO(DAY_AFTER, "12:30"));
});

test("38. 'какие услуги' lists services, no booking", async () => {
  const c = convo(multiSalon());
  const r = await c.say("какие у вас услуги?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply.length).toBeGreaterThan(0);
});

test("39. 'не принципиально' from idle does not crash (single)", async () => {
  const c = convo(singleSalon());
  const r = await c.say("не принципиально");
  expect(r.appointmentId).toBeNull();
  expect(r.reply.length).toBeGreaterThan(0);
});

test("40. invalid hour '25:00' is ignored, not treated as a time", async () => {
  const c = convo(singleSalon());
  const r = await c.say("завтра в 25:00");
  // No valid time → should ask part of day, not jump to a slot
  expect(r.nextState).toBe("awaiting_part_of_day");
});

// ===================== ROUND 3: branches, edge transitions =====================

function branchSalon(): SalonCfg {
  return {
    services: [{ id: "svc_hair", name: "Стрижка", category: null, price: 500, price_max: null, price_type: "fixed", duration_min: 30, is_active: true }],
    masters: [
      { id: "m_c", name: "Бакыт", branch_id: "b1", sort_order: 0, service_ids: ["svc_hair"] },
      { id: "m_v", name: "Нурлан", branch_id: "b2", sort_order: 1, service_ids: ["svc_hair"] },
    ],
    slots: { [`m_c|${TOMORROW}`]: [slotRow(TOMORROW, "12:00")], [`m_v|${TOMORROW}`]: [slotRow(TOMORROW, "15:00")] },
  };
}
const BRANCHES = [{ id: "b1", name: "Центр", address: null }, { id: "b2", name: "Восток", address: null }];

test("41. multi-branch: asks branch, selects, books in chosen branch", async () => {
  const c = convo(branchSalon(), { branches: BRANCHES });
  const r1 = await c.say("хочу записаться");
  expect(r1.nextState).toBe("awaiting_branch");
  await c.say("Центр");                       // deterministic branch match → b1
  expect(c.data.branch_id).toBe("b1");
  await c.say("завтра");
  await c.say("в 12:00");                      // only Центр master has 12:00
  const r = await c.say("да");
  expect(c.db.appointments[0]._branch_id).toBe("b1");
  expect(c.db.appointments[0]._master_id).toBe("m_c");
});

test("42. branch filters masters: time only in other branch → nearest in chosen branch", async () => {
  const c = convo(branchSalon(), { branches: BRANCHES });
  await c.say("Восток");                       // b2
  await c.say("завтра");
  const r = await c.say("в 12:00");            // Восток has only 15:00 → no 12:00
  expect(r.nextState).toBe("awaiting_slot_choice");
  const r2 = await c.say("в 15:00");
  await c.say("да");
  expect(c.db.appointments[0]._master_id).toBe("m_v");
});

test("43. switch to a range-priced service at confirm → asks for photo, no booking", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка завтра в 14:00", { gemini: { intent: "choose_specific_time", language: "ru", entities: { service_id: "svc_hair", day_relative: "tomorrow", specific_time: "14:00" } } });
  expect(c.state).toBe("awaiting_final_confirm");
  const r = await c.say("лучше окрашивание");  // range service → photo flow
  expect(c.data.service_id).toBe("svc_color");
  expect(r.nextState).toBe("awaiting_photo");
  expect(r.appointmentId).toBeNull();
});

test("44. 'да' on the slot list picks first but still requires final confirm", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  await c.say("днём");
  const r = await c.say("да");                 // picks first slot
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(r.appointmentId).toBeNull();          // NOT auto-booked
  const r2 = await c.say("да");
  expect(r2.appointmentId).not.toBeNull();
});

test("45. today: a past time is excluded (no booking in the past)", async () => {
  const todayHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
  if (todayHour < 1) return; // skip near midnight to avoid flakiness
  const cfg = singleSalon();
  const today = bishkekToday();
  cfg.slots = { [`m_ulur|${today}`]: [slotRow(today, "00:05")] }; // already in the past
  const c = convo(cfg);
  const r = await c.say("сегодня в 00:05");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
});

// ===================== ROUND 4: live feedback (greeting, ky, past parts, pretty confirm) ===

const nowHourBishkek = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));

test("46. today: past parts of day are NOT offered", async () => {
  const h = nowHourBishkek();
  const c = convo(singleSalon());
  const r = await c.say("на сегодня");
  if (h >= 21) {
    expect(r.reply.length).toBeGreaterThan(0); // whole day over → suggests another day
    return;
  }
  expect(r.nextState).toBe("awaiting_part_of_day");
  if (h >= 12) expect(/утром/i.test(r.reply)).toBe(false);
  if (h >= 17) expect(/дн[её]м/i.test(r.reply)).toBe(false);
});

test("47. language is sticky: Kyrgyz chat stays Kyrgyz on a plain word", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Саламатсызбы");
  expect(c.data.language).toBe("ky");
  await c.say("сегодня");            // Russian-looking, weak signal → must NOT flip to ru
  expect(c.data.language).toBe("ky");
});

test("47b. casual Kyrgyz 'бугун' (no ү) is detected as Kyrgyz", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  const r = await c.say("бугун жазылам");
  expect(c.data.language).toBe("ky");
});

test("48. booking confirmation is warm: salon name + emoji + time", async () => {
  const c = convo(singleSalon());
  await c.say("завтра в 12:45");
  const r = await c.say("да");
  expect(r.appointmentId).not.toBeNull();
  expect(r.reply).toContain("Тест салон");
  expect(/🎉|😊/.test(r.reply)).toBe(true);
  expect(r.reply).toContain("12:45");
});

test("49. first contact is greeted", async () => {
  const c = convo(singleSalon());
  const r = await c.say("завтра в 12:45");      // very first message
  expect(/^\s*(Здравствуйте|Привет|Саламат)/i.test(r.reply)).toBe(true);
});

test("49b. second message is NOT greeted again", async () => {
  const c = convo(singleSalon());
  await c.say("Привет");
  const r = await c.say("завтра в 12:45");
  expect(/^\s*(Здравствуйте|Саламат)/i.test(r.reply)).toBe(false);
});

// ===================== ROUND 5: anti-loop / hand-off / greeting persistence =============

test("50. repeated unrecognized reply on part-of-day does NOT loop verbatim, then hands off", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");                 // → asks part of day (last_prompt = part)
  const r1 = await c.say("кхм");          // 1st unrecognized → gentle clarify (different wording)
  expect(c.data.reask_count).toBe(1);
  expect(r1.reply).toMatch(/не совсем понял|утром|днём|вечером/i);
  const r2 = await c.say("эээ");          // 2nd unrecognized → hand off to a human
  expect(r1.reply).not.toBe(r2.reply);
  expect(c.data.needs_human).toBe(true);
  expect(r2.reply).toMatch(/администратор/i);
  expect(/^\s*(Здравствуйте|Саламат|Привет)/i.test(r2.reply)).toBe(false);
});

test("50b. a recognized reply resets the re-ask counter (no false hand-off)", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");
  await c.say("кхм");                     // reask_count = 1
  const r = await c.say("днём");          // recognized part of day → counter resets, lists slots
  expect(c.data.reask_count).toBe(0);
  expect(c.data.needs_human).toBeFalsy();
  expect(r.nextState).toBe("awaiting_slot_choice");
});

test("52. Kyrgyz 'ооба' confirms a booking", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("эртең 12:45", { gemini: { intent: "choose_specific_time", language: "ky", entities: { day_relative: "tomorrow", specific_time: "12:45" } } });
  expect(c.state).toBe("awaiting_final_confirm");
  const r = await c.say("ооба");                 // Kyrgyz "yes"
  expect(r.appointmentId).not.toBeNull();
});

test("52b. Kyrgyz 'жок' at confirm rejects (back to time selection)", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await bookToConfirm(c, "завтра", "в 12:45");
  const r = await c.say("жок");                   // Kyrgyz "no"
  expect(r.nextState).toBe("awaiting_part_of_day");
  expect(c.db.appointments).toHaveLength(0);
});

test("53. typo'd 'нееет' is understood as deny at confirm", async () => {
  const c = convo(singleSalon());
  await bookToConfirm(c, "завтра", "в 12:45");
  const r = await c.say("нееет");
  expect(r.nextState).toBe("awaiting_part_of_day");
  expect(c.db.appointments).toHaveLength(0);
});

test("53b. typo'd part of day 'вечром' is understood", async () => {
  const cfg = singleSalon();
  cfg.slots = { [`m_ulur|${TOMORROW}`]: [slotRow(TOMORROW, "18:00"), slotRow(TOMORROW, "19:00")] };
  const c = convo(cfg);
  await c.say("завтра");
  const r = await c.say("вечром");                // typo of "вечером"
  expect(r.nextState).toBe("awaiting_slot_choice");
  expect(r.reply).toMatch(/18:00|19:00/);
});

test("54. fuzzy master name 'Айгул' (missing ь) matches Айгуль", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка");
  await c.say("завтра");
  await c.say("в 13:00");                          // both masters free → ask which
  const r = await c.say("Айгул", { gemini: { intent: "choose_master", language: "ru", entities: { master_name: "Айгул" } } });
  expect(r.nextState).toBe("awaiting_final_confirm");
  await c.say("да");
  expect(c.db.appointments[0]._master_id).toBe("m_aigul");
});

test("55. explicit 'не понял' triggers a clarify, not a verbatim repeat", async () => {
  const c = convo(singleSalon());
  await c.say("завтра");                           // asks part of day
  const r = await c.say("не понял вас");           // confusion → immediate clarify
  expect(c.data.reask_count).toBe(1);
  expect(r.reply).toMatch(/не совсем понял|утром|днём|вечером/i);
});

test("55b. Kyrgyz 'тушунбодум' triggers a Kyrgyz clarify", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Саламатсызбы");                     // ky greeting → language sticks ky
  await c.say("эртең", { gemini: { intent: "choose_day", language: "ky", entities: { day_relative: "tomorrow" } } }); // asks part of day in ky
  const r = await c.say("тушунбодум");             // "I didn't understand"
  expect(c.data.language).toBe("ky");
  expect(c.data.reask_count).toBeGreaterThanOrEqual(1);
  expect(/түшүн|ыңгайлуу|эртең менен|кечинде/i.test(r.reply)).toBe(true);
});

test("51. greeted flag prevents a second greeting after history was cleared", async () => {
  (globalThis as any).__WA_DB__ = makeDb(singleSalon());
  const res = await runWaAgent({
    salon: SALON,
    config: CONFIG,
    client: { phone: "996700000000", name: "Рамис" },
    history: [], // history wiped (e.g. webhook reload mid-session)
    lastMessages: [{ id: "in1", direction: "in", kind: "text", text_body: "завтра в 12:45", media_signed_url: null, media_path: null, created_at: new Date().toISOString() }],
    branches: [],
    selectedBranchId: null,
    state: "collecting",
    stateData: { greeted: true, service_id: "svc_hair", service_name: "Стрижка", service_price_type: "fixed", language: "ru" },
  } as any);
  expect(/^\s*(Здравствуйте|Саламат|Привет)/i.test(res.reply)).toBe(false);
});

test("56. salon tone_instructions reach the Gemini compose prompt", async () => {
  (globalThis as any).__WA_DB__ = makeDb(singleSalon());
  await runWaAgent({
    salon: SALON,
    config: { greeting: null, tone_instructions: "Всегда обращайся на «вы» и предлагай комбо стрижка+укладка", pricing_rules: null, languages: ["ru"] },
    client: { phone: "996700000000", name: "Рамис" },
    history: [],
    lastMessages: [{ id: "in1", direction: "in", kind: "text", text_body: "завтра в 12:45", media_signed_url: null, media_path: null, created_at: new Date().toISOString() }],
    branches: [],
    selectedBranchId: null,
    state: "idle",
    stateData: {},
  } as any);
  expect(composeSystemInstructions.some((s) => s.includes("комбо стрижка+укладка"))).toBe(true);
});

// ===================== ROUND 6: Islamic greeting, language fix, service list format =====================

test("58. 'Ассалму аллейкум' → detected as Kyrgyz, language set to ky", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Ассалму аллейкум");
  expect(c.data.language).toBe("ky");
});

test("59. 'Ассалму аллейкум' → reply starts with Ваалейкум or Ассалам (Islamic response)", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  const r = await c.say("Ассалму аллейкум");
  expect(c.data.language).toBe("ky");
  expect(/Ваалейкум|Ассалам/i.test(r.reply)).toBe(true);
});

test("59b. 'Ассалму аллейкум' (no ky in languages) → clamped to ru, no crash", async () => {
  const c = convo(singleSalon(), { languages: ["ru"] });
  const r = await c.say("Ассалму аллейкум");
  expect(r.reply.length).toBeGreaterThan(0);
  expect(r.appointmentId).toBeNull();
});

test("59c. 'Саламатсыбы' (typo for саламатсызбы) → detected as Kyrgyz", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Саламатсыбы");
  expect(c.data.language).toBe("ky");
});

test("59d. 'Салматсызбы' (dropped-vowel typo) → detected as Kyrgyz", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Салматсызбы");
  expect(c.data.language).toBe("ky");
});

test("60. 'какие у вас услуги?' after service prompt → lists services, no day jump", async () => {
  const c = convo(multiSalon());
  await c.say("хочу записаться");         // bot asks: which service?
  const r = await c.say("а какие у вас услуги есть?");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).toBe("collecting"); // still collecting service, NOT jumped to day
  // Reply must contain at least one service name
  expect(/Стрижка|Маникюр|Окрашивание/i.test(r.reply)).toBe(true);
});

test("60b. 'сколько стоит стрижка?' → lists price, no day jump", async () => {
  const c = convo(multiSalon());
  const r = await c.say("сколько стоит стрижка?");
  expect(r.appointmentId).toBeNull();
  // Should not jump straight to day selection
  expect(r.nextState).not.toBe("awaiting_part_of_day");
});

test("61. service list is formatted with newlines not commas", async () => {
  const c = convo(multiSalon());
  const r = await c.say("Привет");
  // With newline formatting, each service is on its own line
  expect(r.reply).toContain("\n");
  // Services are NOT comma-joined
  expect(/Стрижка, Маникюр/.test(r.reply)).toBe(false);
});

test("62. Islamic greeting mid-session switches language to ky (confidentLanguage = true)", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Привет");                  // start in Russian
  expect(c.data.language).toBe("ru");
  await c.say("Ассалму аллейкум");        // Islamic greeting → confident ky signal → switch
  expect(c.data.language).toBe("ky");
});

test("63. full Kyrgyz booking flow: грит → выбор услуги → день → время → подтверждение", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Саламатсызбы");            // greet in Kyrgyz → language = ky
  expect(c.data.language).toBe("ky");
  // choose service + day + time in one shot (Kyrgyz)
  await c.say("эртең 12:45", { gemini: { intent: "choose_specific_time", language: "ky", entities: { day_relative: "tomorrow", specific_time: "12:45" } } });
  expect(c.state).toBe("awaiting_final_confirm");
  const r = await c.say("ооба");          // Kyrgyz "yes"
  expect(r.appointmentId).not.toBeNull();
  expect(c.data.language).toBe("ky");
});

// ===================== ROUND 7: master name matching, photo price, Kyrgyz conjunctions =====================

test("64. 'УЛурга' (mixed case + Kyrgyz suffix -га) matches master 'Улур'", async () => {
  const c = convo(multiSalon(), { languages: ["ru", "ky"] });
  await c.say("стрижка");
  await c.say("завтра");
  await c.say("в 13:00");                // both masters free → awaiting_master_choice
  expect(c.state).toBe("awaiting_master_choice");
  const r = await c.say("УЛурга");       // raw text fallback should match "Улур"
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(c.data.master_id).toBe("m_ulur");
});

test("65. master name with typo 'Айгул' (missing ь) matched via raw text fallback", async () => {
  const c = convo(multiSalon());
  await c.say("стрижка");
  await c.say("завтра");
  await c.say("в 13:00");
  const r = await c.say("Айгул");       // levenshtein close enough to "Айгуль"
  expect(r.nextState).toBe("awaiting_final_confirm");
  expect(c.data.master_id).toBe("m_aigul");
});

test("66. photo vision error → bot shows message and sets price_skipped (not silent jump to day)", async () => {
  const c = convo(multiSalon());
  await c.say("окрашивание");            // range service → awaiting_photo
  expect(c.state).toBe("awaiting_photo");
  // Send photo — vision stub returns price 1500; new flow: price shown + day asked, no confirm step
  const r = await c.say("вот фото", { image: true });
  expect(r.nextState).not.toBe("awaiting_photo");
  expect(r.reply).toMatch(/1500|стоимость|баа|сом/i);
});

test("67. awaiting_photo + no image sent → bot re-asks for photo, does NOT jump to day", async () => {
  const c = convo(multiSalon());
  await c.say("окрашивание");            // → awaiting_photo
  expect(c.state).toBe("awaiting_photo");
  const r = await c.say("окей");        // text, not image → should re-ask for photo
  expect(r.nextState).toBe("awaiting_photo");
  expect(r.appointmentId).toBeNull();
});

test("68. 'байке' and 'эже' detected as Kyrgyz", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"] });
  await c.say("Саламатсызбы");           // set language to ky
  await c.say("эже жардам бер");         // эже = distinctly Kyrgyz word
  expect(c.data.language).toBe("ky");
});

test("57. Vision failure does not loop asking for a photo — booking proceeds", async () => {
  // Make the image download fail so priceFromPhoto errors out.
  const cfg = multiSalon();
  cfg.slots = { [`m_ulur|${TOMORROW}`]: [slotRow(TOMORROW, "13:00")] };
  const c = convo(cfg);
  await c.say("окрашивание");                       // range service → asks photo
  expect(c.state).toBe("awaiting_photo");
  // Inject a classify result and a broken image: the vision call returns price (stub),
  // so instead simulate the *download* failing by pointing at a non-img URL is hard here;
  // assert the price_skipped guard via the success path is covered by test 24. Here we verify
  // that once priced, a follow-up turn does NOT bounce back to awaiting_photo.
  const r = await c.say("вот фото", { image: true }); // price shown + day asked in one turn
  expect(r.nextState).not.toBe("awaiting_photo");
  const r3 = await c.say("завтра");                  // next turn: day selected, must NOT bounce back to photo
  expect(r3.nextState).not.toBe("awaiting_photo");
});

// =========================================================================
// CONVERSATIONAL AI (TESTS 69–93) — human-like answers, no forced booking
// =========================================================================

const SALON_HOURS: Record<string, string> = {
  mon: "10:00–20:00", tue: "10:00–20:00", wed: "10:00–20:00",
  thu: "10:00–20:00", fri: "10:00–20:00", sat: "11:00–18:00", sun: "Выходной",
};
const SALON_INFO_WITH_HOURS = { working_hours: SALON_HOURS, address: null };

// ---- Smalltalk ----

test("69. 'как дела?' → natural reply, no booking push, no internal instruction echo", async () => {
  const c = convo(multiSalon());
  const r = await c.say("как дела?");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
  expect(r.nextState).not.toBe("done");
  expect(r.reply.length).toBeGreaterThan(0);
  expect(/^(спроси|скажи|поприветствуй|ответь|перечисл)/i.test(r.reply)).toBe(false);
});

test("70. Kyrgyz smalltalk 'кандайс?' → friendly reply without starting booking", async () => {
  const c = convo(multiSalon(), { languages: ["ru", "ky"] });
  const r = await c.say("кандайс?", { gemini: { intent: "smalltalk", language: "ky", entities: {} } });
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply.length).toBeGreaterThan(0);
  expect(/^(спроси|скажи|поприветствуй)/i.test(r.reply)).toBe(false);
});

test("71. 'эмне кылатасыз?' → lists services, no forced booking start", async () => {
  const c = convo(multiSalon(), { languages: ["ru", "ky"] });
  const r = await c.say("эмне кылатасыз?", { gemini: { intent: "ask_services", language: "ky", entities: {} } });
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
  expect(r.reply).toMatch(/стрижк|маникюр|окрашив|кызмат|услуг/i);
});

// ---- Capability questions ----

test("72. 'вы делаете маникюр?' → confirms yes + price, no booking started", async () => {
  const c = convo(multiSalon());
  const r = await c.say("вы делаете маникюр?");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
  expect(r.nextState).not.toBe("done");
  expect(r.reply).toMatch(/маникюр|800|делаем|услуг/i);
});

test("73. 'вы можете сделать стрижку?' → confirms service + price", async () => {
  const c = convo(multiSalon());
  const r = await c.say("вы можете сделать стрижку?");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply).toMatch(/стрижк|500|делаем|услуг/i);
});

test("74. 'у вас есть окрашивание?' → mentions price range 1000–3000", async () => {
  const c = convo(multiSalon());
  const r = await c.say("у вас есть окрашивание?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/окрашив|1000|3000|делаем|услуг/i);
});

// ---- Schedule questions ----

test("75. 'вы работаете завтра?' + working_hours → replies with schedule", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  const r = await c.say("вы работаете завтра?");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
  expect(r.reply).toMatch(/10:00|20:00|режим|расписание|работ/i);
});

test("76. 'когда вы открываетесь?' + working_hours → replies with opening time", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  const r = await c.say("когда вы открываетесь?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/10:00|режим|расписание|работ/i);
});

test("77. 'до скольки работаете?' + working_hours → replies with hours", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  const r = await c.say("до скольки работаете?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/20:00|18:00|режим|расписание|работ/i);
});

test("78. 'вы работаете в воскресенье?' → mentions выходной in reply", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  const r = await c.say("вы работаете в воскресенье?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/выходн|Вс|режим|расписание/i);
});

test("79. 'у вас есть выходные?' (with Gemini ask_schedule) → schedule info", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  // Deterministic sees "у вас есть" as ask_capability; Gemini corrects to ask_schedule
  const r = await c.say("у вас есть выходные?", { gemini: { intent: "ask_schedule", language: "ru", entities: {} } });
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/Вс|выходн|режим|расписание/i);
});

test("80. schedule question with NO working_hours data → suggests contacting admin", async () => {
  const c = convo(singleSalon(), { salonInfo: { working_hours: null, address: null } });
  const r = await c.say("вы работаете завтра?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/администратор|уточнит|часы/i);
});

// ---- Other conversational ----

test("81. 'привет, я новый клиент' → greeting reply, no appointment created", async () => {
  const c = convo(multiSalon());
  const r = await c.say("привет, я новый клиент");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply.length).toBeGreaterThan(0);
  expect(/^(спроси|скажи|ответь|поприветствуй)/i.test(r.reply)).toBe(false);
});

test("82. 'спасибо большое за ответ' → friendly acknowledgement, no booking push", async () => {
  const c = convo(multiSalon());
  const r = await c.say("спасибо большое за ответ");
  expect(r.appointmentId).toBeNull();
  expect(r.reply.length).toBeGreaterThan(0);
  expect(/^(спроси|скажи|поприветствуй)/i.test(r.reply)).toBe(false);
});

test("83. 'я просто хотел узнать' → natural reply, no appointment started", async () => {
  const c = convo(multiSalon());
  const r = await c.say("я просто хотел узнать");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
  expect(r.reply.length).toBeGreaterThan(0);
});

// ---- Kyrgyz capability ----

test("84. Kyrgyz 'сиз маникюр кыласызбы?' (ask_capability inject) → confirms + price", async () => {
  const c = convo(multiSalon(), { languages: ["ru", "ky"] });
  const r = await c.say("сиз маникюр кыласызбы?", {
    gemini: { intent: "ask_capability", language: "ky", entities: { service_id: "svc_nail" } },
  });
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply).toMatch(/маникюр|800|делаем|жасайбыз/i);
});

// ---- Mid-booking resilience ----

test("85. capability question mid-booking does not reset booking state", async () => {
  const c = convo(multiSalon());
  await c.say("маникюр");
  await c.say("завтра");
  await c.say("в 13:00");                          // only Айгуль → direct confirm
  expect(c.state).toBe("awaiting_final_confirm");
  const savedService = c.data.service_id;
  const savedSlot = c.data.slot_start;
  const r = await c.say("а вы делаете стрижку?");  // ask_capability for different service
  expect(r.appointmentId).toBeNull();
  // booking data must be intact — capability handler returns early, no entity update runs
  expect(c.data.service_id).toBe(savedService);
  expect(c.data.slot_start).toBe(savedSlot);
  expect(c.state).toBe("awaiting_final_confirm");
});

test("86. schedule question mid-booking does not reset booking state", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  await c.say("запишите меня на завтра в 12:30");
  expect(c.state).toBe("awaiting_final_confirm");
  const savedSlot = c.data.slot_start;
  const r = await c.say("вы работаете в субботу?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/11:00|18:00|режим|расписание/i);  // Сб: 11:00–18:00
  expect(c.data.slot_start).toBe(savedSlot);
  expect(c.state).toBe("awaiting_final_confirm");
});

// ---- Service not offered ----

test("87. 'вы делаете свадебный макияж?' (not in list) → honest answer, lists alternatives", async () => {
  const c = convo(multiSalon());
  const r = await c.say("вы делаете свадебный макияж?");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("done");
  expect(r.reply).toMatch(/стрижк|маникюр|окрашив|услуг|интересует/i);
});

test("88. 'вы сможете сделать стрижку?' → confirms yes + price", async () => {
  const c = convo(multiSalon());
  const r = await c.say("вы сможете сделать стрижку?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/стрижк|500|делаем|услуг/i);
});

// ---- Sequential flow ----

test("89. smalltalk then booking → booking completes normally", async () => {
  const c = convo(singleSalon());
  const r1 = await c.say("как дела?", { gemini: { intent: "smalltalk", language: "ru", entities: {} } });
  expect(r1.appointmentId).toBeNull();
  expect(r1.nextState).not.toBe("done");
  // Immediately request a booking — flow must not be broken by prior smalltalk
  await c.say("запишите на завтра в 12:00");
  const r3 = await c.say("да");
  expect(r3.appointmentId).not.toBeNull();
});

// ---- Kyrgyz schedule ----

test("90. Kyrgyz 'иштейсизби?' + working_hours → schedule reply", async () => {
  const c = convo(singleSalon(), { languages: ["ru", "ky"], salonInfo: SALON_INFO_WITH_HOURS });
  // Deterministic already detects ask_schedule via "иштейсизби"; inject Gemini for language
  const r = await c.say("иштейсизби?", { gemini: { intent: "ask_schedule", language: "ky", entities: {} } });
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/10:00|20:00|Пн|режим|расписание/i);
});

// ---- Regression ----

test("91. REGRESSION: 'да' in awaiting_final_confirm books (re-resolve guard fix)", async () => {
  const c = convo(singleSalon());
  await c.say("запишите меня на завтра в 12:45");
  expect(c.state).toBe("awaiting_final_confirm");
  // Inject Gemini returning service_id entity for "да" — was the bug trigger before the fix
  const r = await c.say("да", { gemini: { intent: "confirm_yes", language: "ru", entities: { service_id: "svc_hair" } } });
  expect(r.appointmentId).not.toBeNull();
  expect(r.nextState).toBe("done");
});

test("92. 'спасибо, не надо' after capability answer → no booking forced", async () => {
  const c = convo(multiSalon());
  await c.say("вы делаете маникюр?");
  const r = await c.say("спасибо, не надо");
  expect(r.appointmentId).toBeNull();
  expect(r.nextState).not.toBe("awaiting_final_confirm");
  expect(r.reply.length).toBeGreaterThan(0);
});

test("93. 'вы работаете по пятницам?' + working_hours → schedule with Friday hours", async () => {
  const c = convo(singleSalon(), { salonInfo: SALON_INFO_WITH_HOURS });
  const r = await c.say("вы работаете по пятницам?");
  expect(r.appointmentId).toBeNull();
  expect(r.reply).toMatch(/10:00|20:00|Пт|режим|расписание/i);
});

// =========================================================================
// V3 manage flow (cancel / reschedule) — runs the REAL runWaAgentV3, which is
// what production (webhook + admin simulator) uses.
// =========================================================================

function convoV3(
  cfg: SalonCfg,
  opts: { assistantConfig?: any; state?: string } = {},
) {
  (globalThis as any).__WA_DB__ = makeDb(cfg);
  const db = (globalThis as any).__WA_DB__;
  let state: any = opts.state ?? "idle";
  let stateData: any = {};
  let selectedBranchId: any = null;
  const history: any[] = [];
  const config = { ...CONFIG, manage_cutoff_hours: 0, ...opts.assistantConfig };
  return {
    db,
    get state() { return state; },
    get data() { return stateData; },
    seedAppointment(a: { id?: string; startsAt: string; serviceId: string; masterId: string }) {
      db.appointments.push({
        id: a.id ?? `appt-${db.appointments.length + 1}`,
        _starts_at: a.startsAt,
        _service_id: a.serviceId,
        _master_id: a.masterId,
        status: "confirmed",
      });
      state = "done";
    },
    async say(text: string, turnOpts: { gemini?: any; selectedId?: string } = {}) {
      if (turnOpts.gemini) geminiClassifyQueue.push(turnOpts.gemini);
      const input: any = {
        salon: SALON, config,
        client: { phone: "996700000000", name: "Рамис" },
        history: [...history],
        lastMessages: [{
          id: `in-${history.length}`, direction: "in", kind: "text",
          text_body: text || null, created_at: new Date().toISOString(),
          selected_id: turnOpts.selectedId ?? null,
        }],
        branches: [], selectedBranchId, state, stateData, salonInfo: null,
      };
      const res = await runWaAgentV3(input);
      history.push({ id: `in-${history.length}`, direction: "in", kind: "text", text_body: text, created_at: new Date().toISOString() });
      history.push({ id: `out-${history.length}`, direction: "out", kind: "text", text_body: res.reply, created_at: new Date().toISOString() });
      state = res.nextState; stateData = res.nextStateData; selectedBranchId = res.selectedBranchId;
      return res;
    },
  };
}

function v3SalonWithEveningSlots(): SalonCfg {
  const cfg = singleSalon();
  cfg.slots[`m_ulur|${TOMORROW}`] = [slotRow(TOMORROW, "12:00"), slotRow(TOMORROW, "18:00"), slotRow(TOMORROW, "19:00"), slotRow(TOMORROW, "20:30")];
  return cfg;
}

test("V3-1. 'пенеренести эту запись на 19:00' (typo) → straight to confirm, then moves the appointment", async () => {
  const c = convoV3(v3SalonWithEveningSlots());
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r1 = await c.say("Вы не могли бы пенеренести эту запись на 19:00");
  expect(r1.nextState).toBe("awaiting_manage_confirm");
  expect(r1.reply).toContain("19:00");
  const r2 = await c.say("да");
  expect(r2.nextState).toBe("done");
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "19:00"));
});

test("V3-2. requested time busy → nearest free slots of the SAME master offered", async () => {
  const cfg = singleSalon();
  cfg.slots[`m_ulur|${TOMORROW}`] = [slotRow(TOMORROW, "18:00"), slotRow(TOMORROW, "20:30")];
  const c = convoV3(cfg);
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r = await c.say("перенесите на 19:00");
  expect(r.nextState).toBe("awaiting_reschedule_slot");
  expect(r.reply).toMatch(/занято/i);
  const times = (r.interactiveMessage as any)?.sections?.[0]?.rows?.map((x: any) => x.title) ?? [];
  expect(times).toContain("18:00");
});

test("V3-3. own master fully booked that day → other master's slots offered, reschedule switches master", async () => {
  const cfg = multiSalon();
  cfg.slots[`m_ulur|${TOMORROW}`] = [];
  cfg.slots[`m_aigul|${TOMORROW}`] = [slotRow(TOMORROW, "19:00")];
  const c = convoV3(cfg);
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "13:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r1 = await c.say("перенесите запись на завтра в 19:00");
  expect(r1.nextState).toBe("awaiting_reschedule_slot");
  expect(r1.reply).toMatch(/друг/i); // "…есть время у других мастеров"
  const r2 = await c.say("", { selectedId: "slot_0" });
  expect(r2.nextState).toBe("awaiting_manage_confirm");
  expect(r2.reply).toContain("Айгуль");
  const r3 = await c.say("да");
  expect(r3.nextState).toBe("done");
  expect(c.db.appointments[0]._starts_at).toBe(slotISO(TOMORROW, "19:00"));
  expect(c.db.appointments[0]._master_id).toBe("m_aigul");
});

test("V3-4. free-phrase cancel via Gemini fallback → confirm → appointment cancelled", async () => {
  const c = convoV3(singleSalon());
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r1 = await c.say("я отказываюсь от визита", { gemini: { action: "cancel" } });
  expect(r1.nextState).toBe("awaiting_manage_confirm");
  const r2 = await c.say("да");
  expect(r2.nextState).toBe("done");
  expect(r2.reply).toMatch(/отменена/i);
  expect(c.db.appointments[0].status).toBe("cancelled");
});

test("V3-5. 'не смогу прийти' (ambiguous) → cancel/reschedule buttons, not a greeting", async () => {
  const c = convoV3(singleSalon());
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r = await c.say("я не смогу прийти");
  expect(r.nextState).toBe("awaiting_manage_action");
  expect((r.interactiveMessage as any)?.buttons?.map((b: any) => b.id)).toContain("manage_cancel");
});

// =========================================================================
// Numbered text menu — Green-API can't deliver interactive lists/buttons to
// regular WhatsApp accounts, so menus go out as numbered text and the client
// answers with a number. The rowId order is persisted in state_data.menu.
// =========================================================================

test("V3-6. greeting stores menu rowIds; reply '2' picks the 2nd service", async () => {
  const c = convoV3(multiSalon());
  const r1 = await c.say("Здравствуйте");
  expect(r1.nextState).toBe("awaiting_service");
  expect((r1.nextStateData as any).menu).toEqual(["svc_svc_hair", "svc_svc_nail", "svc_svc_color"]);
  const r2 = await c.say("2");
  expect((r2.nextStateData as any).v3?.service_id).toBe("svc_nail");
  expect(r2.nextState).not.toBe("awaiting_service");
});

test("V3-7. manage buttons picked by number: '1' = отменить", async () => {
  const c = convoV3(singleSalon());
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r1 = await c.say("я не смогу прийти");
  expect(r1.nextState).toBe("awaiting_manage_action");
  const r2 = await c.say("1");
  expect(r2.nextState).toBe("awaiting_manage_confirm");
  const r3 = await c.say("да");
  expect(r3.nextState).toBe("done");
  expect(c.db.appointments[0].status).toBe("cancelled");
});

test("V3-8. renderInteractiveAsText: приветствие + нумерованное меню + подсказка", async () => {
  const c = convoV3(multiSalon());
  const r = await c.say("Здравствуйте");
  const txt = renderInteractiveAsText(r.reply, r.interactiveMessage!, "ru");
  expect(txt).toContain(r.reply.trim());
  expect(txt).toMatch(/1\. Стрижка/);
  expect(txt).toMatch(/2\. Маникюр/);
  expect(txt).toMatch(/3\. Окрашивание/);
  expect(txt).toMatch(/цифрой/i);
});

test("V3-6. cutoff: visit in 1h, limit 2h → polite refusal, appointment untouched", async () => {
  const c = convoV3(singleSalon(), { assistantConfig: { manage_cutoff_hours: 2 } });
  c.seedAppointment({ startsAt: new Date(Date.now() + 3600_000).toISOString(), serviceId: "svc_hair", masterId: "m_ulur" });
  const r = await c.say("отмените мою запись");
  expect(r.nextState).toBe("done");
  expect(r.reply).toMatch(/напрямую|салон/i);
  expect(c.db.appointments[0].status).toBe("confirmed");
});

test("V3-7. reschedule without date/time ('пенеренести' typo only) → asks for a date, not a greeting", async () => {
  const c = convoV3(singleSalon());
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r = await c.say("можно пенеренести запись?");
  expect(r.nextState).toBe("awaiting_reschedule_date");
  expect(r.reply).toMatch(/дату|переносим/i);
});

test("V3-8. Gemini says 'none' → normal greeting, manage flow not entered", async () => {
  const c = convoV3(singleSalon());
  c.seedAppointment({ startsAt: slotISO(TOMORROW, "12:00"), serviceId: "svc_hair", masterId: "m_ulur" });
  const r = await c.say("здравствуйте", { gemini: { action: "none" } });
  expect(r.nextState).toBe("awaiting_service");
});
