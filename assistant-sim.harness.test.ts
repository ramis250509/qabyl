// Deterministic edge-case suite for the AI assistant pipeline — no API keys, runs in `bun test`.
//
// The model is replaced by a scripted "brain" that answers Gemini requests by looking at what the
// request contains. Everything else is production code: the Cloud API webhook, dedup, the lock and
// drain loop, runWaAgentV4, the tools, and the booking rules (ported 1:1 in qa/assistant-sim/fake-db).
//
// This is the part of the quality system that must never regress silently: duplicate webhooks,
// bursts, the last-slot race, a model outage, a database fault, and the booking fixes of 13.09.2026.
//
// Run: bun test assistant-sim.harness
import { test, expect, mock, beforeAll, beforeEach, describe } from "bun:test";
import {
  SimWorld,
  ClientSession,
  DEFAULT_SALON,
  SOLO_SALON,
  MULTI_BRANCH_SALON,
  type SalonHandle,
} from "./qa/assistant-sim/world";
import { localDateOf, localTimeOf, localToUtcMs } from "./qa/assistant-sim/fake-db";
import { runAssertions } from "./qa/assistant-sim/assertions";

const world = new SimWorld();
(globalThis as any).__QABYL_SIM_DB__ = world.db;
mock.module("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({} as any, {
    get(_t, prop) {
      const db = (globalThis as any).__QABYL_SIM_DB__;
      const v = db[prop];
      return typeof v === "function" ? v.bind(db) : v;
    },
  }),
}));
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GEMINI_API_KEY = "sim-test-key";

// ─── scripted brain ───────────────────────────────────────────────────────────────────────────
type Brain = (req: {
  contents: any[];
  lastUserText: string;
  lastFunctionResponse: any | null;
}) => any[];
let brain: Brain = () => [{ text: "Здравствуйте!" }];
let geminiDown = false;
let geminiCalls = 0;
const realFetch = globalThis.fetch;
const simFetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("generativelanguage.googleapis.com")) return realFetch(input, init);
  geminiCalls++;
  if (geminiDown) return new Response('{"error":{"code":503}}', { status: 503 });
  const body = JSON.parse(init.body);
  const contents: any[] = body.contents ?? [];
  const last = contents.at(-1);
  const fr = last?.parts?.find((p: any) => p.functionResponse)?.functionResponse ?? null;
  const lastUser = [...contents]
    .reverse()
    .find((c) => c.role === "user" && c.parts?.some((p: any) => typeof p.text === "string"));
  const lastUserText = (lastUser?.parts ?? []).map((p: any) => p.text ?? "").join("\n");
  const parts = brain({ contents, lastUserText, lastFunctionResponse: fr });
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts } }] }), {
    status: 200,
  });
}) as typeof fetch;

// `bun test` loads every test file into ONE process, and other suites replace globalThis.fetch and
// register their own client.server mock (a proxy onto globalThis.__WA_DB__) at import time. Standalone
// this file passed; in the full run whichever file loaded last won. Re-assert our fetch before every
// test and point both known DB globals at the fake, so the outcome no longer depends on file order.
globalThis.fetch = simFetch;
beforeEach(() => {
  globalThis.fetch = simFetch;
  (globalThis as any).__QABYL_SIM_DB__ = world.db;
});

let processWaCloudPayload: any;
beforeAll(async () => {
  ({ processWaCloudPayload } = await import("@/routes/api/public/wacloud.$salonId"));
});

const session = (h: SalonHandle, phone: string, name = "Клиент") =>
  new ClientSession(world, h, phone, name, processWaCloudPayload);
const call = (name: string, args: Record<string, unknown>) => [{ functionCall: { name, args } }];

describe("fake database = production booking rules", () => {
  test("slots are generated in the salon timezone and respect buffer, bookings and day off", () => {
    const h = world.createSalon(DEFAULT_SALON);
    const day = h.localDate(2);
    const slots = world.db.getAvailableSlots(
      h.masterId("Айгуль"),
      h.serviceId("Женская стрижка"),
      day,
    );
    expect(localTimeOf(slots[0].slot_start, h.tz)).toBe("10:00");
    expect(localTimeOf(slots.at(-1)!.slot_start, h.tz)).toBe("19:00");
    // Bishkek is UTC+6: 10:00 local = 04:00Z.
    expect(slots[0].slot_start).toBe(
      new Date(localToUtcMs(day, "10:00", "Asia/Bishkek")).toISOString(),
    );

    // Colouring (150 min + 15 min buffer) at 12:00 blocks a haircut at 14:30 but not at 14:45.
    world.addAppointment(h, {
      master: "Айгуль",
      service: "Окрашивание",
      date: day,
      time: "12:00",
      phone: "996700111222",
      name: "X",
    });
    const after = world.db
      .getAvailableSlots(h.masterId("Айгуль"), h.serviceId("Женская стрижка"), day)
      .map((s) => localTimeOf(s.slot_start, h.tz));
    expect(after).not.toContain("14:30");
    expect(after).toContain("14:45");

    world.addDayOff(h, "Айгуль", day);
    expect(
      world.db.getAvailableSlots(h.masterId("Айгуль"), h.serviceId("Женская стрижка"), day),
    ).toEqual([]);
  });

  test("create_appointment rejects an overlap and an ai_assistant booking outside the schedule", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    const day = h.localDate(2);
    const base = {
      _salon_id: h.salonId,
      _master_id: h.masterId("Айжан"),
      _service_id: h.serviceId("Маникюр"),
      _client_name: "Тест",
      _client_phone: "996700123456",
      _source: "ai_assistant",
    };
    const ok = await world.db.rpc("create_appointment", {
      ...base,
      _starts_at: new Date(localToUtcMs(day, "10:00", h.tz)).toISOString(),
    });
    expect(ok.error).toBeNull();
    // 'manual' on purpose: for online sources assert_master_available runs FIRST (same order as
    // the SQL) and would reject 10:30 as "вне графика" before the overlap check is reached.
    const clash = await world.db.rpc("create_appointment", {
      ...base,
      _source: "manual",
      _client_phone: "996700999999",
      _starts_at: new Date(localToUtcMs(day, "10:30", h.tz)).toISOString(),
    });
    expect(clash.error?.message).toMatch(/no longer available/);
    const night = await world.db.rpc("create_appointment", {
      ...base,
      _starts_at: new Date(localToUtcMs(day, "23:00", h.tz)).toISOString(),
    });
    expect(night.error?.message).toMatch(/вне рабочего графика/);
  });
});

describe("webhook pipeline under real-world delivery", () => {
  test("happy path: booking lands in the DB at the local time the client asked for", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    const day = h.localDate(1);
    brain = ({ lastUserText, lastFunctionResponse }) => {
      if (lastFunctionResponse?.name === "create_appointment") {
        return [
          {
            text: lastFunctionResponse.response.success
              ? "Записала вас на завтра в 18:00 к Айгуль."
              : "Не получилось записать.",
          },
        ];
      }
      if (/да/i.test(lastUserText)) {
        return call("create_appointment", {
          service_id: h.serviceId("Женская стрижка"),
          master_id: h.masterId("Айгуль"),
          date: day,
          time: "18:00",
          client_name: "Жылдыз",
          client_confirmation: "да",
        });
      }
      return [
        {
          text: "Женская стрижка завтра в 18:00 к Айгуль, 1200 сом. Как вас зовут? Подтверждаете?",
        },
      ];
    };
    const s = session(h, "996700200001");
    await s.say(["Хочу стрижку завтра в 18"]);
    const r = await s.say(["Жылдыз, да"]);
    expect(r.replies.at(-1)).toContain("Записала");
    const appts = world.appointmentsOf(h);
    expect(appts).toHaveLength(1);
    expect(localDateOf(appts[0].starts_at, h.tz)).toBe(day);
    expect(localTimeOf(appts[0].starts_at, h.tz)).toBe("18:00");
    expect(appts[0].source).toBe("ai_assistant");

    // Observability: the outgoing message keeps what the model asked the booking tool and what the
    // server answered — enough to answer «почему записали на это время» from the database alone.
    const conv = world.conversationOf(h, "996700200001")!;
    const trace = world.db
      .table("wa_messages")
      .filter((m) => m.conversation_id === conv.id && m.direction === "out")
      .flatMap((m) => m.meta?.tool_trace ?? []);
    const booking = trace.find((t: any) => t.name === "create_appointment");
    expect(booking?.args).toMatchObject({ date: day, time: "18:00" });
    expect(booking?.result).toMatchObject({ success: true });
  }, 30_000);

  test("Meta delivers the same message twice at once: stored once, answered once", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    brain = () => [{ text: "Здравствуйте! Чем могу помочь?" }];
    const s = session(h, "996700200002");
    const callsBefore = geminiCalls;
    const r = await s.say(["Здравствуйте"], { duplicateDelivery: true });
    const conv = world.conversationOf(h, "996700200002")!;
    const inbound = world.db
      .table("wa_messages")
      .filter((m) => m.conversation_id === conv.id && m.direction === "in");
    expect(inbound).toHaveLength(1);
    expect(r.replies).toHaveLength(1);
    expect(geminiCalls - callsBefore).toBe(1);
  }, 30_000);

  test("a burst of bubbles is answered with ONE reply that saw all of them", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    let seen = "";
    brain = ({ lastUserText }) => {
      seen = lastUserText;
      return [{ text: "На какую услугу записать?" }];
    };
    const s = session(h, "996700200003");
    const r = await s.say(["Здравствуйте", "Хочу записаться", "Завтра", "Вечером"], { gapMs: 250 });
    expect(r.replies).toHaveLength(1);
    expect(r.lostInbound).toBe(0);
    for (const word of ["Здравствуйте", "Хочу записаться", "Завтра", "Вечером"])
      expect(seen).toContain(word);
  }, 30_000);

  test("two clients race for the last slot: exactly one booking, the loser is not told they are booked", async () => {
    const h = world.createSalon(SOLO_SALON);
    const day = h.localDate(1);
    world.fillDayExcept(h, "Айгуль", "Коррекция бровей", day, ["18:00"]);
    brain = ({ lastFunctionResponse, lastUserText }) => {
      if (lastFunctionResponse?.name === "create_appointment") {
        return [
          {
            text: lastFunctionResponse.response.success
              ? "Готово, вы записаны на завтра в 18:00."
              : "Извините, 18:00 только что заняли. Могу предложить послезавтра.",
          },
        ];
      }
      const name = /Алина/.test(lastUserText) ? "Алина" : "Камила";
      return call("create_appointment", {
        service_id: h.serviceId("Коррекция бровей"),
        master_id: h.masterId("Айгуль"),
        date: day,
        time: "18:00",
        client_name: name,
        client_confirmation: "да",
      });
    };
    const a = session(h, "996700200004", "A");
    const b = session(h, "996700200005", "B");
    const before = structuredClone(world.appointmentsOf(h));
    const [ra, rb] = await Promise.all([
      a.say(["Алина, завтра 18:00, да"]),
      b.say(["Камила, завтра 18:00, да"]),
    ]);
    const atSlot = world
      .appointmentsOf(h)
      .filter(
        (x) => localTimeOf(x.starts_at, h.tz) === "18:00" && localDateOf(x.starts_at, h.tz) === day,
      );
    expect(atSlot).toHaveLength(1);
    for (const [s, r] of [
      [a, ra],
      [b, rb],
    ] as const) {
      const checks = runAssertions({
        world,
        salon: h,
        phone: s.phone,
        before,
        clientTexts: [],
        assistantTexts: r.replies,
        expect: { describe: "race" },
        lostInbound: r.lostInbound,
      });
      expect(checks.filter((c) => !c.ok && c.severity === "critical")).toEqual([]);
    }
  }, 30_000);

  test("model outage: the client gets an honest hand-off, the chat is paused, nothing crashes", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    geminiDown = true;
    try {
      const s = session(h, "996700200006");
      const r = await s.say(["Можно на маникюр?"]);
      expect(r.replies.join(" ")).toMatch(/администратор/i);
      expect(r.replies.join(" ")).not.toMatch(/503|gemini|error/i);
      expect(world.conversationOf(h, "996700200006")?.ai_paused).toBe(true);
    } finally {
      geminiDown = false;
    }
  }, 60_000);

  test("database fault while storing the conversation: webhook still acks, no reply, no crash", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    world.db.injectFault({
      table: "wa_conversations",
      op: "upsert",
      error: { message: "connection reset", code: "08006" },
    });
    const s = session(h, "996700200007");
    const r = await s.say(["Здравствуйте"]);
    expect(r.replies).toHaveLength(0);
  }, 30_000);
});

describe("booking fixes of 13.09.2026 (regressions)", () => {
  test("reschedule without a master change goes through reschedule_appointment_v2 and respects a prepayment hold", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    const day = h.localDate(1);
    const phone = "996700200008";
    const mine = world.addAppointment(h, {
      master: "Айжан",
      service: "Маникюр",
      date: day,
      time: "11:00",
      phone,
      name: "Жибек",
    });
    // Someone else's unpaid hold at 15:00 — the legacy RPC ignored pending_payment rows.
    world.addAppointment(h, {
      master: "Айжан",
      service: "Маникюр",
      date: day,
      time: "15:00",
      phone: "996700777777",
      name: "Hold",
      status: "pending_payment",
    });
    const eventsFrom = world.db.events.length;
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const input: any = {
      salon: { salonId: h.salonId, salonName: h.spec.name, timezone: h.tz },
      config: { manage_cutoff_hours: 0 },
      client: { phone, name: null },
      history: [],
      lastMessages: [],
      branches: [],
      selectedBranchId: null,
      state: "collecting",
      stateData: {},
    };
    const flags: any = {
      appointmentId: null,
      selectedBranchId: null,
      needsHuman: false,
      escalateReason: null,
      photoNotes: [],
    };
    const moved = await executeV4Tool(
      "reschedule_appointment",
      { appointment_id: mine.id, new_date: day, new_time: "13:00" },
      input,
      world.db as any,
      flags,
    );
    expect(moved.success).toBe(true);
    const rpcs = world.db.events
      .slice(eventsFrom)
      .filter((e) => e.kind === "rpc")
      .map((e) => e.rpc);
    expect(rpcs).toContain("reschedule_appointment_v2");
    expect(rpcs).not.toContain("reschedule_appointment");
    expect(
      localTimeOf(world.db.table("appointments").find((a) => a.id === mine.id)!.starts_at, h.tz),
    ).toBe("13:00");

    const onHold = await executeV4Tool(
      "reschedule_appointment",
      { appointment_id: mine.id, new_date: day, new_time: "15:00" },
      input,
      world.db as any,
      flags,
    );
    expect(onHold.success).toBe(false);
  });

  test("cancel_appointment cannot touch another salon's booking or a past visit", async () => {
    const a = world.createSalon(DEFAULT_SALON);
    const b = world.createSalon(DEFAULT_SALON);
    const phone = "996700200009";
    const inOtherSalon = world.addAppointment(b, {
      master: "Айжан",
      service: "Маникюр",
      date: b.localDate(1),
      time: "11:00",
      phone,
      name: "Жибек",
    });
    const past = world.addAppointment(a, {
      master: "Айжан",
      service: "Маникюр",
      date: a.localDate(-1),
      time: "11:00",
      phone,
      name: "Жибек",
    });
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const input: any = {
      salon: { salonId: a.salonId, salonName: a.spec.name, timezone: a.tz },
      config: { manage_cutoff_hours: 0 },
      client: { phone, name: null },
      history: [],
      lastMessages: [],
      branches: [],
      selectedBranchId: null,
      state: "collecting",
      stateData: {},
    };
    const flags: any = {
      appointmentId: null,
      selectedBranchId: null,
      needsHuman: false,
      escalateReason: null,
      photoNotes: [],
    };
    expect(
      (
        await executeV4Tool(
          "cancel_appointment",
          { appointment_id: inOtherSalon.id },
          input,
          world.db as any,
          flags,
        )
      ).success,
    ).toBe(false);
    expect(
      (
        await executeV4Tool(
          "cancel_appointment",
          { appointment_id: past.id },
          input,
          world.db as any,
          flags,
        )
      ).success,
    ).toBe(false);
    expect(inOtherSalon.status).toBe("confirmed");
    expect(past.status).toBe("confirmed");
  });

  test("a question instead of «да» never creates the booking (client changes mind at the last second)", async () => {
    const h = world.createSalon(DEFAULT_SALON);
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const input: any = {
      salon: { salonId: h.salonId, salonName: h.spec.name, timezone: h.tz },
      config: {},
      client: { phone: "996700200010", name: null },
      history: [],
      lastMessages: [],
      branches: [],
      selectedBranchId: null,
      state: "collecting",
      stateData: {},
    };
    const flags: any = {
      appointmentId: null,
      selectedBranchId: null,
      needsHuman: false,
      escalateReason: null,
      photoNotes: [],
    };
    const r = await executeV4Tool(
      "create_appointment",
      {
        service_id: h.serviceId("Маникюр"),
        master_id: h.masterId("Айжан"),
        date: h.localDate(1),
        time: "14:00",
        client_name: "Айжамал",
        client_confirmation: "ой, а давайте лучше на 16:00?",
      },
      input,
      world.db as any,
      flags,
    );
    expect(r.success).toBe(false);
    expect(r.reason).toBe("need_explicit_confirmation");
    expect(world.appointmentsOf(h)).toHaveLength(0);
  });
});

// Ложные утверждения о доступности, найденные живым прогоном 17.09.2026.
//
// ПОЧЕМУ ЭТИ ЧЕТЫРЕ ЖИВУТ ЗДЕСЬ, А НЕ В scenarios.ts. Все они — про то, что ВОЗВРАЩАЕТ
// инструмент, а не про то, как модель это сформулировала. Значит, живой Gemini для них не нужен:
// проверяются без ключа, без денег и в каждом `bun run test`. Правило деления такое: зависит от
// формулировок модели — в живой прогон, зависит только от кода — сюда.
describe("нельзя утверждать то, чего система не знает (17.09.2026)", () => {
  /** Минимальный V4-контекст для прямого вызова инструмента. */
  const toolCtx = (h: SalonHandle, phone: string, branchId: string | null = null) => ({
    input: {
      salon: { salonId: h.salonId, salonName: h.spec.name, timezone: h.tz },
      config: { manage_cutoff_hours: 0 },
      client: { phone, name: null },
      history: [],
      lastMessages: [],
      branches: [],
      selectedBranchId: branchId,
      state: "collecting",
      stateData: {},
    } as any,
    flags: {
      appointmentId: null,
      selectedBranchId: branchId,
      needsHuman: false,
      escalateReason: null,
      photoNotes: [],
    } as any,
  });

  test("get_masters с временем не отдаёт мастера, который в этот час уже не работает", async () => {
    // Айгуль работает до 20:00, Айжан — до 18:00. На 18:30 женскую стрижку может сделать только
    // Айгуль. Раньше инструмент про время не знал и возвращал обеих, модель честно зачитывала
    // список — и предлагала клиенту мастера, чья смена кончилась.
    const h = world.createSalon(DEFAULT_SALON);
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const { input, flags } = toolCtx(h, "996700300001");
    const service = h.serviceId("Женская стрижка");
    const date = h.localDate(1);

    const withTime: any = await executeV4Tool(
      "get_masters",
      { service_id: service, date, time: "18:30" },
      input,
      world.db as any,
      flags,
    );
    expect(withTime.masters.map((m: any) => m.name)).toEqual(["Айгуль"]);
    expect(withTime.filtered_by).toEqual({ date, time: "18:30" });

    // Без времени поведение прежнее — обе делают эту услугу.
    const withoutTime: any = await executeV4Tool(
      "get_masters",
      { service_id: service },
      input,
      world.db as any,
      flags,
    );
    expect(withoutTime.masters.map((m: any) => m.name).sort()).toEqual(["Айгуль", "Айжан"]);
    expect(withoutTime.filtered_by).toBeUndefined();
  });

  test("когда в это время свободных нет, инструмент говорит это причиной, а не пустым списком", async () => {
    // 21:00 — позже смены обеих. Пустой список без причины модель читала как «такого мастера
    // нет»: в промпте написано «нет в списке → скажи, что такого нет».
    const h = world.createSalon(DEFAULT_SALON);
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const { input, flags } = toolCtx(h, "996700300002");

    const res: any = await executeV4Tool(
      "get_masters",
      { service_id: h.serviceId("Женская стрижка"), date: h.localDate(1), time: "21:00" },
      input,
      world.db as any,
      flags,
    );
    expect(res.masters).toEqual([]);
    expect(res.reason).toBe("nobody_free_at_time");
    // Имена тех, кто услугу делает, отданы отдельным полем — чтобы модель не выдала их за
    // свободных, но и не заявила, что таких мастеров не существует.
    expect(res.performs_service.sort()).toEqual(["Айгуль", "Айжан"]);
  });

  test("услуга есть в другом филиале — это wrong_branch, а не «мастера не существует»", async () => {
    // Окрашивание в Beauty Lab делает только Айгуль, и только в филиале «Центр».
    const h = world.createSalon(MULTI_BRANCH_SALON);
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const dzhal = h.branchId("Джал");
    const { input, flags } = toolCtx(h, "996700300003", dzhal);

    const res: any = await executeV4Tool(
      "get_masters",
      { service_id: h.serviceId("Окрашивание"), branch_id: dzhal },
      input,
      world.db as any,
      flags,
    );
    expect(res.masters).toEqual([]);
    expect(res.reason).toBe("wrong_branch");
    expect(res.elsewhere).toContain("Айгуль");
  });

  test("выходной единственного мастера услуги — это не «салон не работает»", async () => {
    // Мужскую стрижку делает только Бекзат. Его выходной раньше приходил как closed_that_day, и
    // клиент слышал «завтра салон не работает» — ложь про салон, который работает.
    const h = world.createSalon(DEFAULT_SALON);
    const { executeV4Tool } = await import("@/lib/wa-agent-v4.server");
    const { input, flags } = toolCtx(h, "996700300004");
    const date = h.localDate(1);
    world.addDayOff(h, "Бекзат", date);

    const res: any = await executeV4Tool(
      "get_available_slots",
      { service_id: h.serviceId("Мужская стрижка"), date },
      input,
      world.db as any,
      flags,
    );
    expect(res.free_times ?? []).toEqual([]);
    expect(res.reason).toBe("no_master_for_service_that_day");

    // Контроль: когда выходной у ВСЕХ, салон действительно закрыт — и это по-прежнему
    // closed_that_day. Иначе фикс просто прятал бы настоящие выходные.
    const closed = world.createSalon(DEFAULT_SALON);
    const closedDate = closed.localDate(1);
    for (const m of ["Айгуль", "Айжан", "Бекзат"]) world.addDayOff(closed, m, closedDate);
    const ctx2 = toolCtx(closed, "996700300005");
    const res2: any = await executeV4Tool(
      "get_available_slots",
      { service_id: closed.serviceId("Мужская стрижка"), date: closedDate },
      ctx2.input,
      world.db as any,
      ctx2.flags,
    );
    expect(res2.reason).toBe("closed_that_day");
  });
});
