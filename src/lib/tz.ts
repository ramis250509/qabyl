/**
 * Timezone helpers. The whole app uses the *salon* timezone, not the
 * device timezone, for any "today / tomorrow / past" logic and any
 * displayed time. Default fallback is Asia/Bishkek (GMT+6, no DST).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const DEFAULT_TZ = "Asia/Bishkek";

/** Format a date in the given tz. Uses ru-RU locale by default. */
export function formatInTz(
  d: Date | string | number,
  tz: string | null | undefined,
  opts: Intl.DateTimeFormatOptions,
  locale: string = "ru-RU",
): string {
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  return new Intl.DateTimeFormat(locale, { timeZone: tz || DEFAULT_TZ, ...opts }).format(date);
}

/** "YYYY-MM-DD" for the calendar day a moment belongs to, in tz. */
export function dayKeyInTz(d: Date | string | number, tz?: string | null): string {
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || DEFAULT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/** Number of minutes since 00:00 in tz for a given moment. */
export function minutesFromMidnightInTz(d: Date | string | number, tz?: string | null): number {
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || DEFAULT_TZ, hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Day-of-week in tz (0=Sunday … 6=Saturday). */
export function dowInTz(d: Date | string | number, tz?: string | null): number {
  const key = dayKeyInTz(d, tz);
  // key is YYYY-MM-DD; build UTC midnight of that local date for stable DOW.
  const [y, mo, da] = key.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, da)).getUTCDay();
}

/**
 * Build a UTC `Date` that, when rendered in `tz`, equals
 * `YYYY-MM-DD HH:mm:00`. Works across DST.
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const seen = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = seen - guess; // tz offset for that instant
  return new Date(guess - offset);
}

/** Start-of-day in tz for `d` (returns UTC instant of 00:00 local). */
export function startOfDayInTz(d: Date | string | number, tz?: string | null): Date {
  const t = tz || DEFAULT_TZ;
  const [y, mo, da] = dayKeyInTz(d, t).split("-").map(Number);
  return zonedTimeToUtc(y, mo, da, 0, 0, t);
}

/** Start-of-day in tz for a YYYY-MM-DD key. */
export function startOfDayKeyInTz(dayKey: string, tz?: string | null): Date {
  const [y, mo, da] = dayKey.split("-").map(Number);
  return zonedTimeToUtc(y, mo, da, 0, 0, tz || DEFAULT_TZ);
}

/** Add N days (24h chunks) — safe for fixed-offset zones like Bishkek. */
export function addDaysInTz(d: Date, days: number, tz?: string | null): Date {
  const start = startOfDayInTz(d, tz);
  const [y, mo, da] = dayKeyInTz(start, tz).split("-").map(Number);
  return zonedTimeToUtc(y, mo, da + days, 0, 0, tz || DEFAULT_TZ);
}

// --- Hook: resolve salon tz with cache + Bishkek fallback ---------------------

const tzCache = new Map<string, string>();

export function useSalonTimezone(salonId: string | null | undefined): string {
  const [tz, setTz] = useState<string>(() => (salonId && tzCache.get(salonId)) || DEFAULT_TZ);
  useEffect(() => {
    if (!salonId) { setTz(DEFAULT_TZ); return; }
    const cached = tzCache.get(salonId);
    if (cached) { setTz(cached); return; }
    let alive = true;
    supabase.from("salons").select("timezone").eq("id", salonId).maybeSingle().then(({ data }) => {
      const value = (data?.timezone as string) || DEFAULT_TZ;
      tzCache.set(salonId, value);
      if (alive) setTz(value);
    });
    return () => { alive = false; };
  }, [salonId]);
  return tz;
}
