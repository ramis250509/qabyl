// Payment QR delivery and the sales governor, exercised through a full runWaAgentV4 turn.
//
// The QR is the one piece of this feature where a bug moves real money: sending salon A's
// payment QR to salon B's client means a client pays the wrong business. So the ownership
// check is not "trust the query" — the storage path itself must prove the QR belongs to this
// salon, and a row that fails that check must degrade to text requisites rather than sending
// anything. That is the property pinned here.
//
// Run: bun test prepayment-qr.test.ts
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
const SALON_ID = "salon1";
const SALON = { salonId: SALON_ID, salonName: "Тест салон", timezone: TZ, slug: "test-salon" };
const FREE_SLOT = "2099-01-01T04:00:00.000Z";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const MASTER_ID = "22222222-2222-4222-8222-222222222222";

function makeDb(prepayment: any | null) {
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
    { id: MASTER_ID, name: "Айгуль", branch_id: null, sort_order: 0, service_ids: [SERVICE_ID] },
  ];

  const listQuery = (rows: any[]) => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.gte = () => q;
    q.lt = () => q;
    q.neq = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    q.then = (resolve: any) => resolve({ data: rows });
    return q;
  };

  return {
    rpcCalls,
    from: (table: string) => {
      if (table === "services") return listQuery(services);
      if (table === "masters") return listQuery(masters);
      if (table === "appointments") return listQuery(appointments);
      if (table === "prepayment_settings") return listQuery(prepayment ? [prepayment] : []);
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
      if (name === "create_appointment_with_prepayment") {
        return {
          data: {
            appointment_id: "held_1",
            prepayment_id: "pp_1",
            amount: 500,
            currency: "KGS",
            hold_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            manage_token: null,
          },
          error: null,
        };
      }
      if (name === "create_appointment") return { data: "appt_1", error: null };
      return { data: null, error: null };
    },
  };
}

let geminiQueue: any[][] = [];
globalThis.fetch = (async (url: any) => {
  const u = String(url);
  if (u.includes("/cachedContents")) return new Response('{"error":"skip"}', { status: 400 });
  if (u.includes("generativelanguage.googleapis.com")) {
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
});

const fc = (name: string, args: any) => ({ functionCall: { name, args } });
const bookingCall = () =>
  fc("create_appointment", {
    service_id: SERVICE_ID,
    master_id: MASTER_ID,
    slot_start: FREE_SLOT,
    client_name: "Анна",
    client_confirmation: "да, записывайте",
  });

function makeInput(text: string, stateData: any = {}) {
  return {
    salon: SALON,
    config: { languages: ["ru"], manage_cutoff_hours: 0 },
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
    stateData,
    salonInfo: { working_hours: { mon: "10:00–20:00" }, address: "ул. Тестовая 1" },
  } as any;
}

const withQr = (path: string, url: string) => ({
  enabled: true,
  hold_minutes: 30,
  recipient_name: "Айгуль А.",
  recipient_details: { bank: "MBANK", phone: "+996555112233" },
  instruction_ru: null,
  qr_path: path,
  qr_url: url,
});

test("QR салона уходит клиенту вместе с суммой", async () => {
  const url = `https://cdn.example/storage/payment-qr/${SALON_ID}/abc.png`;
  (globalThis as any).__WA_DB__ = makeDb(withQr(`${SALON_ID}/abc.png`, url));
  geminiQueue = [[bookingCall()], [{ text: "Держу слот, отправляю QR." }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));

  expect(res.nextState).toBe("awaiting_receipt");
  expect(res.sendMedia?.url).toBe(url);
  // The caption has to carry the amount: on Instagram the image arrives as its own bubble,
  // so a caption-less QR would be a picture with no explanation.
  expect(res.sendMedia?.caption).toContain("500");
  expect(res.sendMedia?.caption).toContain("KGS");
  expect((res.nextStateData as any).prepayment_qr_sent_for).toBe("held_1");
});

test("чужой QR не отправляется: путь обязан начинаться с id этого салона", async () => {
  // The exact cross-tenant hazard: a settings row pointing at another salon's object.
  const foreign = "https://cdn.example/storage/payment-qr/OTHER-SALON/abc.png";
  (globalThis as any).__WA_DB__ = makeDb(withQr("OTHER-SALON/abc.png", foreign));
  geminiQueue = [[bookingCall()], [{ text: "Держу слот." }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));

  expect(res.sendMedia).toBeUndefined();
  // The booking itself must still go through — the client pays by the text requisites.
  expect(res.nextState).toBe("awaiting_receipt");
});

test("без настроенного QR всё работает как раньше", async () => {
  (globalThis as any).__WA_DB__ = makeDb({
    enabled: true,
    hold_minutes: 30,
    recipient_details: { bank: "MBANK", phone: "+996555112233" },
  });
  geminiQueue = [[bookingCall()], [{ text: "Держу слот." }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));
  expect(res.sendMedia).toBeUndefined();
  expect(res.nextState).toBe("awaiting_receipt");
});

test("QR не отправляется второй раз за ту же бронь", async () => {
  const url = `https://cdn.example/storage/payment-qr/${SALON_ID}/abc.png`;
  (globalThis as any).__WA_DB__ = makeDb(withQr(`${SALON_ID}/abc.png`, url));
  geminiQueue = [[bookingCall()], [{ text: "Держу слот." }]];

  // Client re-confirms and the agent re-enters the prepayment path for the same hold.
  const res = await runWaAgentV4(
    makeInput("да, записывайте", { prepayment_qr_sent_for: "held_1" }),
  );
  expect(res.sendMedia).toBeUndefined();
});

test("обычная запись без предоплаты не тянет за собой никакой картинки", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ enabled: false });
  geminiQueue = [[bookingCall()], [{ text: "Записала вас!" }]];

  const res = await runWaAgentV4(makeInput("да, записывайте"));
  expect(res.sendMedia).toBeUndefined();
  expect(res.nextState).toBe("done");
});

test("состояние продаж переживает ход и не растёт, когда клиент двигается вперёд", async () => {
  (globalThis as any).__WA_DB__ = makeDb({ enabled: false });
  geminiQueue = [[bookingCall()], [{ text: "Записала вас!" }]];

  const res = await runWaAgentV4(
    makeInput("да, записывайте", { sales: { closeAttempts: 2, handled: [], slotRounds: 3 } }),
  );
  // A completed booking is the clearest possible "the push worked" — the anti-nag counter
  // must reset, otherwise the assistant would go mute right after a successful sale.
  expect((res.nextStateData as any).sales.closeAttempts).toBe(0);
});
