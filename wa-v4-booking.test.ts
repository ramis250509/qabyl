// Phase A regression: server-authoritative time resolution for the V4 booking engine.
// Guards the "11:00 booked as 17:00" bug — the server must book the client's exact clock
// time, never a fabricated/tz-shifted timestamp. Run: bun test wa-v4-booking.test.ts
import { test, expect, describe } from "bun:test";
import {
  resolveRequestedSlot,
  normHHMM,
  classifyEmptyDay,
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
