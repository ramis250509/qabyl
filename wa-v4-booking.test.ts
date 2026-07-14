// Phase A regression: server-authoritative time resolution for the V4 booking engine.
// Guards the "11:00 booked as 17:00" bug — the server must book the client's exact clock
// time, never a fabricated/tz-shifted timestamp. Run: bun test wa-v4-booking.test.ts
import { test, expect, describe } from "bun:test";
import {
  resolveRequestedSlot,
  normHHMM,
  classifyEmptyDay,
  executeV4Tool,
  clampPriceOverride,
  isDayWorkableForService,
  loadSalonClosedDates,
} from "@/lib/wa-agent-v4.server";

const TZ = "Asia/Bishkek"; // UTC+6, no DST

function futureDate(n = 3): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function slotISO(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+06:00`).toISOString();
}
function slotRow(date: string, hhmm: string) {
  const start = slotISO(date, hhmm);
  return { slot_start: start, slot_end: new Date(new Date(start).getTime() + 30 * 60000).toISOString() };
}
function localHHMM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// Minimal db exposing only rpc("get_available_slots"); resolveRequestedSlot with a masterId
// never touches db.from (it builds a synthetic single-master list).
function makeDb(date: string, freeTimes: string[]) {
  return {
    rpc: async (name: string, _args: any) => {
      if (name === "get_available_slots") return { data: freeTimes.map((t) => slotRow(date, t)) };
      return { data: null };
    },
  } as any;
}
const input = {
  salon: { salonId: "s1", salonName: "Тест", timezone: TZ },
  selectedBranchId: null,
  salonInfo: { working_hours: null },
} as any;

const DATE = futureDate();

describe("resolveRequestedSlot — books the exact requested time", () => {
  test("11:00 free → books 11:00, NOT 17:00", async () => {
    const db = makeDb(DATE, ["11:00", "13:00", "17:00"]);
    const r = await resolveRequestedSlot({ db, input, serviceId: "svc", masterId: "m1", date: DATE, time: "11:00" });
    expect(r.ok).toBe(true);
    expect(localHHMM(r.slotStart!)).toBe("11:00");
  });

  test("11:00 taken (only 17:00 free) → slot_not_free, never books 17:00", async () => {
    const db = makeDb(DATE, ["17:00"]);
    const r = await resolveRequestedSlot({ db, input, serviceId: "svc", masterId: "m1", date: DATE, time: "11:00" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("slot_not_free");
    expect(r.slotStart).toBeUndefined();
    expect(r.nearest).toContain("17:00");
  });

  test("legacy fabricated ISO for 11:00 when 11:00 not free → rejected", async () => {
    const db = makeDb(DATE, ["17:00"]);
    const r = await resolveRequestedSlot({ db, input, serviceId: "svc", masterId: "m1", date: DATE, slotStartIso: slotISO(DATE, "11:00") });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("slot_not_free");
  });

  test("legacy ISO matching a real free slot → accepted at that exact instant", async () => {
    const db = makeDb(DATE, ["11:00", "17:00"]);
    const r = await resolveRequestedSlot({ db, input, serviceId: "svc", masterId: "m1", date: DATE, slotStartIso: slotISO(DATE, "17:00") });
    expect(r.ok).toBe(true);
    expect(localHHMM(r.slotStart!)).toBe("17:00");
  });

  test("garbage time → bad_time", async () => {
    const db = makeDb(DATE, ["11:00"]);
    const r = await resolveRequestedSlot({ db, input, serviceId: "svc", masterId: "m1", date: DATE, time: "notatime" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad_time");
  });
});

describe("normHHMM", () => {
  test.each([
    ["11", "11:00"],
    ["11:30", "11:30"],
    ["09:05", "09:05"],
    ["17.00", "17:00"],
    ["25:00", null],
    ["abc", null],
  ])("normHHMM(%p) === %p", (input, expected) => {
    expect(normHHMM(input as string)).toBe(expected as any);
  });
});

describe("classifyEmptyDay — closed vs fully booked", () => {
  const D = "2026-07-15"; // any date
  test("unknown hours → fully_booked (never wrongly 'closed')", () => {
    expect(classifyEmptyDay(D, null)).toBe("fully_booked");
  });
  test("all days working → fully_booked", () => {
    const wh = { mon: "10:00–20:00", tue: "10:00–20:00", wed: "10:00–20:00", thu: "10:00–20:00", fri: "10:00–20:00", sat: "10:00–20:00", sun: "10:00–20:00" };
    expect(classifyEmptyDay(D, wh)).toBe("fully_booked");
  });
  test("all days off (Выходной) → closed_that_day", () => {
    const wh = { mon: "Выходной", tue: "Выходной", wed: "Выходной", thu: "Выходной", fri: "Выходной", sat: "Выходной", sun: "Выходной" };
    expect(classifyEmptyDay(D, wh)).toBe("closed_that_day");
  });
  test("day missing from config → closed_that_day", () => {
    expect(classifyEmptyDay(D, {})).toBe("closed_that_day");
  });
});

// Scenario-3 bug: client asks for a part of day (вечером) with no slots, but the salon is
// open earlier the same day. Must NOT say "всё занято"/jump to another date — must return
// the day's other free times with reason=part_unavailable.
describe("get_available_slots — part-of-day empty but day is open", () => {
  const flags = { appointmentId: null, selectedBranchId: null, needsHuman: false, escalateReason: null };
  // Salon open all week 10:00–17:00, so there is never an "evening" (>17:00) slot.
  const openInput = {
    ...input,
    config: { manage_cutoff_hours: 0 },
    salonInfo: {
      working_hours: {
        mon: "10:00–17:00", tue: "10:00–17:00", wed: "10:00–17:00", thu: "10:00–17:00",
        fri: "10:00–17:00", sat: "10:00–17:00", sun: "10:00–17:00",
      },
    },
  } as any;

  test("evening empty, day open → part_unavailable + day's free times (not fully_booked)", async () => {
    const db = makeDb(DATE, ["10:00", "12:00", "14:00", "16:00"]); // all before 17:00
    const r = await executeV4Tool(
      "get_available_slots",
      { service_id: "svc", date: DATE, master_id: "m1", part_of_day: "evening" },
      openInput, db, flags,
    );
    expect(r.reason).toBe("part_unavailable");
    expect(r.free_times.length).toBeGreaterThan(0);
    expect(r.free_times).toContain("14:00");
  });

  test("evening has slots → ok", async () => {
    const db = makeDb(DATE, ["16:00", "18:00", "19:00"]);
    const r = await executeV4Tool(
      "get_available_slots",
      { service_id: "svc", date: DATE, master_id: "m1", part_of_day: "evening" },
      openInput, db, flags,
    );
    expect(r.reason).toBe("ok");
    expect(r.free_times).toContain("18:00");
  });

  test("whole day empty (no part filter) → fully_booked, not part_unavailable", async () => {
    const db = makeDb(DATE, []);
    const r = await executeV4Tool(
      "get_available_slots",
      { service_id: "svc", date: DATE, master_id: "m1" },
      openInput, db, flags,
    );
    expect(r.reason).toBe("fully_booked");
  });
});

// Phase B: price stays inside the service's configured range.
function makeServiceDb(row: any) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row }),
  };
  return { from: () => chain } as any;
}
describe("clampPriceOverride — never outside the service range", () => {
  test("range service: below min → clamped up to min", async () => {
    const db = makeServiceDb({ price: 2500, price_max: 7000, price_type: "range" });
    expect(await clampPriceOverride(db, "s1", "svc", 1000)).toBe(2500);
  });
  test("range service: above max → clamped down to max", async () => {
    const db = makeServiceDb({ price: 2500, price_max: 7000, price_type: "range" });
    expect(await clampPriceOverride(db, "s1", "svc", 9999)).toBe(7000);
  });
  test("range service: inside → kept as agreed", async () => {
    const db = makeServiceDb({ price: 2500, price_max: 7000, price_type: "range" });
    expect(await clampPriceOverride(db, "s1", "svc", 4200)).toBe(4200);
  });
  test("fixed service: any override → pinned to the fixed price", async () => {
    const db = makeServiceDb({ price: 1500, price_max: null, price_type: "fixed" });
    expect(await clampPriceOverride(db, "s1", "svc", 999)).toBe(1500);
  });
  test("unknown service → returns input unchanged", async () => {
    const db = makeServiceDb(null);
    expect(await clampPriceOverride(db, "s1", "svc", 3333)).toBe(3333);
  });
});

// Phase B: photo analysis persists so a follow-up a turn later still has the master's read.
describe("remember_photo — persists structured photo analysis into flags", () => {
  test("stores note the model can recall next turn", async () => {
    const flags = { appointmentId: null, selectedBranchId: null, needsHuman: false, escalateReason: null, photoNotes: [] as any[] };
    const r = await executeV4Tool(
      "remember_photo",
      { kind: "hair", summary: "длинные густые волосы, следы осветления", price_band: "3200–3500 сом", issues: ["сухие концы"] },
      { ...input, config: { manage_cutoff_hours: 0 } } as any,
      {} as any,
      flags as any,
    );
    expect(r.success).toBe(true);
    expect(flags.photoNotes).toHaveLength(1);
    expect(flags.photoNotes[0].kind).toBe("hair");
    expect(flags.photoNotes[0].price_band).toBe("3200–3500 сом");
    expect(flags.photoNotes[0].issues).toEqual(["сухие концы"]);
    expect(typeof flags.photoNotes[0].ts).toBe("string");
  });
});

// A table-dispatching Supabase mock: from(table) returns a thenable query builder that ignores
// filters and resolves to the preset rows for that table. Enough to exercise the schedule reads.
function makeTableDb(tables: Record<string, any[]>, rpc?: (n: string, a: any) => Promise<any>) {
  const builder = (rows: any[]) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      in: () => b,
      gte: () => b,
      lte: () => b,
      gt: () => b,
      lt: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null }),
      then: (resolve: any) => resolve({ data: rows }),
    };
    return b;
  };
  return {
    from: (name: string) => builder(tables[name] ?? []),
    rpc: rpc ?? (async () => ({ data: null })),
  } as any;
}
const masterRow = (id: string, svc: string) => ({
  id, name: id, branch_id: null, sort_order: 0, specialization: null, bio: null,
  master_services: [{ service_id: svc }],
});

// The day-off bug fix: a one-off выходной is stored in master_day_overrides (kind='off'), NOT in
// salons.working_hours — so availability reasons must consult the real schedule tables.
describe("isDayWorkableForService — day-off vs working day (real sources)", () => {
  const D = "2026-07-15"; // Wednesday
  test("per-date override kind=off → NOT workable (→ closed_that_day)", async () => {
    const db = makeTableDb({
      masters: [masterRow("m1", "svc")],
      master_day_overrides: [{ master_id: "m1", is_off: true, kind: "off", intervals: null }],
      master_schedules: [{ master_id: "m1" }], // has a weekly schedule, but the override wins
    });
    expect(await isDayWorkableForService({ db, input, serviceId: "svc", date: D })).toBe(false);
  });
  test("no override + has weekly schedule → workable (→ fully_booked when no free slot)", async () => {
    const db = makeTableDb({
      masters: [masterRow("m1", "svc")],
      master_day_overrides: [],
      master_schedules: [{ master_id: "m1" }],
    });
    expect(await isDayWorkableForService({ db, input, serviceId: "svc", date: D })).toBe(true);
  });
  test("no schedule that weekday → NOT workable", async () => {
    const db = makeTableDb({
      masters: [masterRow("m1", "svc")],
      master_day_overrides: [],
      master_schedules: [],
    });
    expect(await isDayWorkableForService({ db, input, serviceId: "svc", date: D })).toBe(false);
  });
  test("one master off but another works → workable", async () => {
    const db = makeTableDb({
      masters: [masterRow("m1", "svc"), masterRow("m2", "svc")],
      master_day_overrides: [{ master_id: "m1", is_off: true, kind: "off", intervals: null }],
      master_schedules: [{ master_id: "m2" }],
    });
    expect(await isDayWorkableForService({ db, input, serviceId: "svc", date: D })).toBe(true);
  });
});

describe("loadSalonClosedDates — whole-salon days off for the prompt", () => {
  test("date off for ALL active masters → listed; date off for only one → not listed", async () => {
    const db = makeTableDb({
      masters: [{ id: "m1" }, { id: "m2" }],
      master_day_overrides: [
        { date: "2026-07-15", master_id: "m1" },
        { date: "2026-07-15", master_id: "m2" }, // both off → closed
        { date: "2026-07-16", master_id: "m1" }, // only one off → open
      ],
    });
    const closed = await loadSalonClosedDates(db, "s1", "2026-07-14", 14);
    expect(closed).toContain("2026-07-15");
    expect(closed).not.toContain("2026-07-16");
  });
});

// Phase D: returning-client recognition aggregated from past appointments.
describe("get_client_context — returning client from past visits", () => {
  const flags = { appointmentId: null, selectedBranchId: null, needsHuman: false, escalateReason: null, photoNotes: [] };
  const clientInput = {
    salon: { salonId: "s1", salonName: "Тест", timezone: TZ },
    selectedBranchId: null,
    salonInfo: { working_hours: null },
    config: { manage_cutoff_hours: 0 },
    client: { phone: "996700000001" },
  } as any;

  test("no past visits → is_returning:false", async () => {
    const db = makeTableDb({ appointments: [] });
    const r = await executeV4Tool("get_client_context", {}, clientInput, db, flags as any);
    expect(r.is_returning).toBe(false);
    expect(r.visit_count).toBe(0);
  });

  test("past visits → returning, preferred master = most frequent, services aggregated", async () => {
    const db = makeTableDb({
      appointments: [
        // ordered desc by starts_at (newest first), as the query returns them
        { starts_at: "2026-07-10T05:00:00Z", status: "completed", services: { name: "Кератин" }, masters: { id: "m1", name: "Айгерим" } },
        { starts_at: "2026-06-01T05:00:00Z", status: "completed", services: { name: "Стрижка" }, masters: { id: "m1", name: "Айгерим" } },
        { starts_at: "2026-05-01T05:00:00Z", status: "confirmed", services: { name: "Маникюр" }, masters: { id: "m2", name: "Нургуль" } },
      ],
    });
    const r = await executeV4Tool("get_client_context", {}, clientInput, db, flags as any);
    expect(r.is_returning).toBe(true);
    expect(r.visit_count).toBe(3);
    expect(r.preferred_master).toEqual({ id: "m1", name: "Айгерим", visits: 2 });
    expect(r.services_used).toEqual(expect.arrayContaining(["Кератин", "Стрижка", "Маникюр"]));
    expect(r.last_visit.service).toBe("Кератин");
  });
});

// The false-busy bug: a time past the working window must read as outside_hours, not «занято».
describe("check_time — outside_hours vs time_taken", () => {
  const flags = { appointmentId: null, selectedBranchId: null, needsHuman: false, escalateReason: null, photoNotes: [] };
  const cfgInput = { ...input, config: { manage_cutoff_hours: 0 } } as any;
  test("17:00 asked, only morning free (9:30–11:15) → outside_hours, not time_taken", async () => {
    const db = makeDb(DATE, ["09:30", "10:00", "10:30", "11:00", "11:15"]);
    const r = await executeV4Tool(
      "check_time",
      { service_id: "svc", date: DATE, master_id: "m1", time: "17:00" },
      cfgInput, db, flags as any,
    );
    expect(r.available).toBe(false);
    expect(r.reason).toBe("outside_hours");
  });
  test("11:00 asked and it is a gap between free slots (10:00 & 12:00) → time_taken", async () => {
    const db = makeDb(DATE, ["10:00", "12:00"]);
    const r = await executeV4Tool(
      "check_time",
      { service_id: "svc", date: DATE, master_id: "m1", time: "11:00" },
      cfgInput, db, flags as any,
    );
    expect(r.available).toBe(false);
    expect(r.reason).toBe("time_taken");
  });
});
