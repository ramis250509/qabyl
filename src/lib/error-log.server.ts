// Prod error sink — SERVER ONLY. Import from Nitro server handlers, createServerFn handlers,
// or edge-fn-adjacent code. Writes go through the service-role client, so RLS never blocks
// them; reads at /admin/errors are super_admin-only via the RLS policy on error_logs.
//
// Never throws. If Supabase itself is down we still console.error so wrangler tail sees it —
// but silent-failing here means logError() can be called freely from catch{} blocks without
// risking cascading failures.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type ErrorSource =
  | "wa-webhook"
  | "wa-agent-v4"
  | "wa-agent-v3"
  // Instagram Direct channel. Kept separate from wa-webhook so /admin/errors can tell at a glance
  // whether a spike is the WhatsApp transport or the Instagram one — they fail for different
  // reasons (Green-API instance unpaid vs a 60-day Meta token that expired).
  | "ig-webhook"
  | "server-fn"
  | "edge-fn"
  | "client"
  | "cron"
  | "other";

export interface LogErrorInput {
  source: ErrorSource;
  message: string;
  // Attach anything JSON-serializable: request id, phone, url, message id, etc.
  context?: Record<string, unknown> | null;
  // JS Error, string stack, or nothing.
  error?: unknown;
  // Optional grouping key. When omitted we derive one from (source|first-line-of-message).
  fingerprint?: string | null;
  level?: "error" | "warn" | "info";
  salonId?: string | null;
  userId?: string | null;
}

// djb2-xor → hex; deterministic, dependency-free, short-lived (used only as a grouping key).
function fingerprintOf(source: string, message: string): string {
  const s = `${source}|${message.split("\n")[0].slice(0, 200)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h & 0xffffffff).toString(16);
}

function stackOf(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function logError(input: LogErrorInput): Promise<void> {
  const level = input.level ?? "error";
  const stack = stackOf(input.error);
  const fingerprint = input.fingerprint ?? fingerprintOf(input.source, input.message);

  // Always mirror to Cloudflare logs so wrangler tail keeps working even if Supabase is down.
  const prefix = `[${level}:${input.source}]`;
  if (level === "error") console.error(prefix, input.message, input.context ?? "", stack ?? "");
  else if (level === "warn") console.warn(prefix, input.message, input.context ?? "");
  else console.log(prefix, input.message, input.context ?? "");

  try {
    // The generated Supabase types don't yet include error_logs (this migration hasn't been
    // regenerated into `src/integrations/supabase/types.ts` — that step is manual). Cast
    // through `any` so this compiles regardless. Runtime is unaffected.
    await (supabaseAdmin as any).from("error_logs").insert({
      level,
      source: input.source,
      salon_id: input.salonId ?? null,
      user_id: input.userId ?? null,
      message: String(input.message).slice(0, 4000),
      stack: stack ? stack.slice(0, 8000) : null,
      context: input.context ?? null,
      fingerprint,
    });
  } catch (e) {
    // Never rethrow. The whole point of the sink is that the caller doesn't have to care.
    console.error("[error-log] insert failed:", (e as Error)?.message ?? e);
  }
}
