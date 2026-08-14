import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isPlausiblePhoneLength } from "@/lib/phone-countries";

// Verify that a phone number is registered on WhatsApp via the salon's Green-API
// credentials (Green-API `checkWhatsapp`). Called from the public booking widget and the
// admin appointment dialog BEFORE creating an appointment, so clients don't book with a
// number that can't receive the WhatsApp confirmation.
//
// No auth middleware on purpose: the public booking widget is anonymous. Only the salon id
// and phone come in; only a status enum goes out — Green-API credentials never leave the
// server. "unavailable" (no creds / Green-API down / timeout) is treated as fail-open by
// callers: better to accept a rare unverified booking than to block everyone.

export type WaCheckStatus = "registered" | "not_registered" | "unavailable";

// Per-server-instance cache — checkWhatsapp answers rarely change and Green-API is slow.
const cache = new Map<string, { status: WaCheckStatus; exp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;

// Abuse guard: this endpoint is public (no auth — the booking widget is anonymous), and
// every non-cached call spends one Green-API `checkWhatsapp` request against the salon's
// paid quota. Cap DISTINCT phones per salon in a short window so a scripted attacker can't
// drain the salon's Green-API budget by hammering the endpoint with random numbers.
// `checkPhoneWhatsapp` for a real booking runs once per client per booking session, so 40
// distinct phones per salon per 5 min is well above any legitimate use.
const RL_MAX_PER_SALON = 40;
const RL_WINDOW_MS = 5 * 60 * 1000;
const rlSeen = new Map<string, { phones: Set<string>; resetAt: number }>();
function rlAllow(salonId: string, digits: string): boolean {
  const now = Date.now();
  let e = rlSeen.get(salonId);
  if (!e || e.resetAt <= now) {
    e = { phones: new Set(), resetAt: now + RL_WINDOW_MS };
    rlSeen.set(salonId, e);
  }
  if (e.phones.has(digits)) return true; // repeat check of same phone — allowed, hits cache anyway
  if (e.phones.size >= RL_MAX_PER_SALON) return false;
  e.phones.add(digits);
  return true;
}

export const checkPhoneWhatsapp = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), phone: z.string().max(32) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ status: WaCheckStatus }> => {
    const digits = data.phone.replace(/\D/g, "");
    // Same bounds as the validate_appointment_phone DB trigger. This used to demand
    // 11 digits, which made every valid 10-digit number come back "not_registered" —
    // and the public widget turns that verdict into a hard block with a message that
    // isn't true ("этот номер не зарегистрирован в WhatsApp"). One rule, one place.
    if (!isPlausiblePhoneLength(digits)) return { status: "not_registered" };

    const key = `${data.salonId}:${digits}`;
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return { status: hit.status };

    // First line: per-instance counter. Cheap, no round-trip, catches an obvious flood
    // immediately. On over-limit, fail-open (unavailable) so the booking flow doesn't
    // hard-block real clients — same policy as any other transient Green-API failure.
    if (!rlAllow(data.salonId, digits)) return { status: "unavailable" };

    let secrets: { greenapi_instance: string | null; greenapi_token: string | null } | null = null;
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      // Second line: shared counter in the database. The in-memory one above lives inside a
      // single Cloudflare Worker isolate, and Cloudflare runs many of them — so a "40 per 5
      // minutes" cap in memory is really 40 × however many isolates happen to be warm. This
      // is the counter that actually holds, because every isolate increments the same row.
      // Failure to check is not a reason to block: the in-memory cap still applies.
      const { data: allowed, error: rlErr } = await supabaseAdmin.rpc(
        "wa_check_rate_limit" as any,
        { _salon_id: data.salonId },
      );
      if (rlErr) console.error("[wa-check] shared rate limit unavailable:", rlErr.message);
      else if (allowed === false) return { status: "unavailable" };

      const { data: row } = await supabaseAdmin
        .from("salon_secrets")
        .select("greenapi_instance, greenapi_token")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      secrets = row;
    } catch (e) {
      // Missing service-role key (local dev) or DB hiccup — never block the booking on it.
      console.error("[wa-check] secrets lookup failed:", e);
      return { status: "unavailable" };
    }

    // Cloud-API-only salons have no way to check registration — fail open.
    if (!secrets?.greenapi_instance || !secrets?.greenapi_token) return { status: "unavailable" };

    let status: WaCheckStatus = "unavailable";
    try {
      const res = await fetch(
        `https://api.green-api.com/waInstance${secrets.greenapi_instance}/checkWhatsapp/${secrets.greenapi_token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneNumber: Number(digits) }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (res.ok) {
        const body: any = await res.json();
        if (body?.existsWhatsapp === true) status = "registered";
        else if (body?.existsWhatsapp === false) status = "not_registered";
        else console.error("[wa-check] unexpected checkWhatsapp response shape:", body);
      } else {
        console.error("[wa-check] checkWhatsapp HTTP", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.error("[wa-check] checkWhatsapp failed:", e);
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    // Only cache a CONFIRMED answer. "unavailable" is by definition transient (a timeout, a
    // 5xx, a malformed response) — caching it for 10 minutes turned one bad Green-API blip into
    // 10 minutes of every booking on that phone number silently skipping the check entirely.
    // Leaving it uncached means the next attempt just retries for real.
    if (status !== "unavailable") cache.set(key, { status, exp: Date.now() + CACHE_TTL_MS });
    return { status };
  });
