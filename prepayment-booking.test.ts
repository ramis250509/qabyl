// Prepayment booking path through runWaAgentV4.
//
// The thing being pinned down here is that prepayment is a MODE of booking, not
// a second booking flow, and that it is off unless a salon explicitly turned it
// on. Three properties matter enough to be regression-tested:
//
//   1. off (or no settings row)   → ordinary confirmed booking, nextState=done
//   2. on                         → hold via create_appointment_with_prepayment,
//                                   nextState=awaiting_receipt, and the tool tells
//                                   the model NOT to claim the client is booked
//   3. settings unreadable        → booking still succeeds as if prepayment were off
//
// (3) is not a hypothetical: the prepayment migration has not been applied to
// production yet, so on a live database that table does not exist. If a missing
// table could throw here, every booking for every salon would fail.
//
// Run: bun test prepayment-booking.test.ts
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
const FREE_SLOT = "2099-01-01T04:00:00.000Z";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const MASTER_ID = "22222222-2222-4222-8222-222222222222";

// `prepayment` — null means "no settings row", "throw" means the table is absent.
function makeDb(prepayment: any | null | "throw") {
  const appointments: any[] = [];
  const rpcCalls: { name: string; args: any }[] = [];

  const services = [
    {
      id: SERVICE_ID,
      name: "Маникюр",
      category: null,
      price: 1000,
      price_max: null,
      price_type: "fixed",
      duration_min: 60,
      is_active: true,
    },
  ];
  const masters = [
    {
      id: MASTER_ID,
      name: "Айгуль",
      branch_id: null,
      sort_order: 0,
      service_ids: [SERVICE_ID],
    },
  ];

  const listQuery = (rows: any[]) => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.gte = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    q.then = (resolve: any) => resolve({ data: rows });
    return q;
  };
  const singleQuery = (row: any) => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: row, error: null });
    q.then = (resolve: any) => resolve({ data: row ? [row] : [] });
    return q;
  };

  return {
    appointments,
    rpcCalls,
    from: (table: string) => {
      if (table === "services") return listQuery(services);
      if (table === "masters") return listQuery(masters);
      if (table === "appointments") return listQuery(appointments);
      if (table === "prepayment_settings") {
        if (prepayment === "throw") throw new Error(`relation "prepayment_settings" does not exist`);
        return singleQuery(prepayment);
      }
      // Everything else the agent may touch is irrelevant here.
      return listQuery([]);
    },
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === "get_available_slots") {
        return {
          data: [
            {
              slot_start: FREE_SLOT,
              slot_end: new Date(new Date(FREE_SLOT).getTime() + 3600_000).toISOString(),
            },
          ],
          error: null,
        };
      }
      if (name === "create_appointment") {
        const id = `appt_${appointments.length + 1}`;
        appointments.push({ id, status: "confirmed", starts_at: args._starts_at });
        return { data: id, error: null };
      }
      if (name === "create_appointment_with_prepayment") {
        const id = `held_${appointments.length + 1}`;
        appointments.push({ id, status: "pending_payment", starts_at: args._starts_at });
        return {
          data: {
            appointment_id: id,
            prepayment_id: "pp_1",
            amount: 200,
            currency: "KGS",
            hold_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            manage_token: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

let geminiQueue: any[][] = [];
let geminiRequests: any[] = [];
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes("/cachedContents")) return new Response('{"error":"skip"}', { status: 400 });
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

const fc = (name: string, args: any) => ({ functionCall: { name, args } });

function makeInput(text: string) {
  return {
    salon: SALON,
    config: {
      greeting: null,
      tone_instructions: null,
      pricing_rules: null,
      languages: ["ru"],
      manage_cutoff_hours: 0,
      knowledge_base: null,
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
    state: "collecting" as const,
    stateData: {},
    salonInfo: { working_hours: { mon: "10:00–20:00" }, address: "ул. Тестовая 1" },
  } as any;
}

const bookingCall = () =>
  fc("create_appointment", {
    service_id: SERVICE_ID,
    master_id: MASTER_ID,
    slot_start: FREE_SLOT,
    client_name: "Анна",
    client_confirmation: "да, записывайте",
  });

function toolResponse(name: string) {
  const lastReq = geminiRequests[geminiRequests.length - 1];
  return lastReq.contents
    .flatMap((c: any) => c.parts)
    .find((p: any) => p.functionResponse?.name === name)?.functionResponse?.response;
}

test("предоплата выключена: обычная запись, nextState=done", async () => {
  const db = makeDb({ enabled: false });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [[bookingCall()], [{ text: "Записала вас!" }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));

  expect(res.appointmentId).toBe("appt_1");
  expect(res.nextState).toBe("done");
  expect(db.rpcCalls.some((c) => c.name === "create_appointment")).toBe(true);
  expect(db.rpcCalls.some((c) => c.name === "create_appointment_with_prepayment")).toBe(false);
});

test("нет строки настроек вообще: тоже обычная запись", async () => {
  const db = makeDb(null);
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [[bookingCall()], [{ text: "Записала вас!" }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));

  expect(res.appointmentId).toBe("appt_1");
  expect(res.nextState).toBe("done");
});

test("таблицы предоплаты нет в базе: запись всё равно создаётся", async () => {
  const db = makeDb("throw");
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [[bookingCall()], [{ text: "Записала вас!" }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));

  // The whole point: a missing table must not surface as "не получилось записать".
  expect(res.appointmentId).toBe("appt_1");
  expect(res.nextState).toBe("done");
  expect(toolResponse("create_appointment").success).toBe(true);
});

test("предоплата включена: слот удерживается, nextState=awaiting_receipt", async () => {
  const db = makeDb({
    enabled: true,
    hold_minutes: 30,
    recipient_name: "Айгуль А.",
    recipient_details: { bank: "MBANK", phone: "+996555112233" },
    instruction_ru: null,
  });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [[bookingCall()], [{ text: "Держу слот, жду чек." }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));

  expect(db.rpcCalls.some((c) => c.name === "create_appointment_with_prepayment")).toBe(true);
  expect(db.rpcCalls.some((c) => c.name === "create_appointment")).toBe(false);
  expect(res.appointmentId).toBe("held_1");
  expect(res.nextState).toBe("awaiting_receipt");
  expect(res.nextStateData.prepayment_appointment_id).toBe("held_1");
  expect(res.nextStateData.prepayment_amount).toBe(200);
});

test("предоплата включена: инструмент запрещает модели объявлять клиента записанным", async () => {
  const db = makeDb({
    enabled: true,
    hold_minutes: 30,
    recipient_name: "Айгуль А.",
    recipient_details: { bank: "MBANK", phone: "+996555112233" },
    instruction_ru: null,
  });
  (globalThis as any).__WA_DB__ = db;
  geminiQueue = [[bookingCall()], [{ text: "Держу слот, жду чек." }]];

  await runWaAgentV4(makeInput("да, записывайте"));

  const resp = toolResponse("create_appointment");
  expect(resp.success).toBe(true);
  expect(resp.prepayment_required).toBe(true);
  expect(resp.amount).toBe(200);
  expect(resp.currency).toBe("KGS");
  // The requisites the client has to pay to must reach the model.
  expect(resp.requisites).toContain("MBANK");
  expect(resp.requisites).toContain("+996555112233");
  // And the instruction must be explicit that this is not a completed booking.
  expect(resp.note).toContain("НЕ говори");
  expect(resp.note).toContain("предоплат");
});
