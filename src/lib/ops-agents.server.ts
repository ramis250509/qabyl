// Ops-agents core — SERVER ONLY. Phase 0 + 1.
//
// Phase 1 is intentionally DETERMINISTIC (no LLM): the Chief-of-Staff digest and the
// SRE error scan are pure SQL aggregation formatted into Telegram text. That keeps this
// phase free, fast and reliable; Gemini polish is a later, opt-in layer.
//
// DB access goes through supabaseAdmin (service_role) behind this narrow module — the
// only reads are the two purpose-built RPCs, and the only writes are to ops_* tables.
// The dedicated ops_agent PG role (see migration) is groundwork for phase-2 write-agents.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const db = () => supabaseAdmin as any; // ops_* + RPCs aren't in generated types yet

// ---- Kill-switch + agent registry -----------------------------------------

export async function agentsEnabled(): Promise<boolean> {
  const { data } = await db().from("ops_config").select("agents_enabled").eq("id", 1).maybeSingle();
  // Fail-safe: only enabled when the config row explicitly says so. If the row is missing or
  // the read fails (e.g. migration not applied yet), this returns false — agents stay dark
  // rather than acting on a broken/unknown config.
  return data?.agents_enabled === true;
}

export async function setKillSwitch(enabled: boolean, by: string): Promise<void> {
  await db()
    .from("ops_config")
    .update({ agents_enabled: enabled, updated_at: new Date().toISOString(), updated_by: by })
    .eq("id", 1);
  await audit(by, enabled ? "killswitch.on" : "killswitch.off", {});
}

export async function isAgentActive(key: string): Promise<boolean> {
  const { data } = await db()
    .from("ops_agents")
    .select("enabled, paused")
    .eq("key", key)
    .maybeSingle();
  return Boolean(data) && data.enabled === true && data.paused !== true;
}

// ---- Audit (append-only) ---------------------------------------------------

export async function audit(
  actor: string,
  action: string,
  detail?: Record<string, unknown>,
  ref?: { type?: string; id?: string },
): Promise<void> {
  try {
    await db()
      .from("ops_audit_log")
      .insert({
        actor,
        action,
        detail: detail ?? null,
        ref_type: ref?.type ?? null,
        ref_id: ref?.id ?? null,
      });
  } catch (e: any) {
    console.error("[ops] audit insert failed:", e?.message ?? e);
  }
}

// ---- KV cursors ------------------------------------------------------------

async function kvGet(key: string): Promise<any | null> {
  const { data } = await db().from("ops_kv").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function kvSet(key: string, value: unknown): Promise<void> {
  await db()
    .from("ops_kv")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

// ===========================================================================
// CHIEF OF STAFF (Кэп) — daily digest
// ===========================================================================

export interface DigestSnapshot {
  salons_total: number;
  bookings_today: number;
  bookings_7d: number;
  ai_bookings_7d: number;
  no_show_30d: number;
  conversations_today: number;
  errors_24h: number;
  pending_approvals: number;
  open_tasks: number;
}

export async function fetchDigestSnapshot(): Promise<DigestSnapshot | null> {
  const { data, error } = await db().rpc("ops_digest_snapshot");
  if (error) {
    console.error("[ops] ops_digest_snapshot failed:", error.message);
    return null;
  }
  return data as DigestSnapshot;
}

export function formatDigest(s: DigestSnapshot, dateLabel: string): string {
  const health = s.errors_24h === 0 ? "🟢 всё зелёное" : `🔴 ошибок за сутки: ${s.errors_24h}`;
  const lines = [
    `🧭 <b>Сводка на ${dateLabel}</b>`,
    ``,
    `💰 <b>Продажи (записи в салоны)</b>`,
    `   • Сегодня: ${s.bookings_today}`,
    `   • За 7 дней: ${s.bookings_7d} (из них через ИИ: ${s.ai_bookings_7d})`,
    `   • No-show за 30 дней: ${s.no_show_30d}`,
    ``,
    `💬 Диалогов сегодня: ${s.conversations_today}`,
    `🏢 Салонов на платформе: ${s.salons_total}`,
    ``,
    `🛠 <b>Техника:</b> ${health}`,
    ``,
    `⏳ <b>Ждут тебя:</b> ${s.pending_approvals} на одобрение, ${s.open_tasks} задач в работе`,
  ];
  return lines.join("\n");
}

/** Build + return the digest text. Records to audit. Sending is the caller's job. */
export async function buildDailyDigest(): Promise<string | null> {
  const snap = await fetchDigestSnapshot();
  if (!snap) return null;
  const dateLabel = new Date().toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Bishkek",
  });
  await kvSet("digest_last_built", { at: new Date().toISOString() });
  await audit("chief", "digest.built", { snapshot: snap });
  return formatDigest(snap, dateLabel);
}

// ===========================================================================
// DEV / SRE (Деби) — error scan
// ===========================================================================

interface ErrorGroup {
  fingerprint: string;
  source: string;
  sample_message: string;
  cnt: number;
  affected_salons: number;
  last_ts: string;
}

async function fetchErrorGroups(since: string): Promise<ErrorGroup[] | null> {
  const { data, error } = await db().rpc("ops_recent_errors", { _since: since });
  if (error) {
    console.error("[ops] ops_recent_errors failed:", error.message);
    return null;
  }
  return (data ?? []) as ErrorGroup[];
}

function formatErrorGroups(groups: ErrorGroup[], header: (total: number) => string): string {
  const totalErrors = groups.reduce((a, g) => a + g.cnt, 0);
  const parts: string[] = [header(totalErrors), ``];
  for (const g of groups.slice(0, 8)) {
    const msg = (g.sample_message || "").replace(/[<>&]/g, "").slice(0, 140);
    const salons = g.affected_salons > 0 ? ` · салонов: ${g.affected_salons}` : "";
    parts.push(`• <b>${g.cnt}×</b> [${g.source}]${salons}\n  ${msg}`);
  }
  parts.push(``, `Открыть панель ошибок: /admin/errors`);
  return parts.join("\n");
}

function severityLabel(total: number): string {
  return total >= 10 ? "🔴 Критично" : total >= 3 ? "🟠 Внимание" : "🟡 Замечено";
}

/**
 * SRE cron scan: report only NEW errors since the last cursor, then advance the cursor so
 * each error alerts at most once. `windowMinutes` caps how far back the first-ever run looks
 * so a fresh install doesn't dump the whole backlog. Returns null when nothing new.
 */
export async function scanErrors(windowMinutes = 30): Promise<{ text: string } | null> {
  const cursor = await kvGet("sre_last_scan_at");
  const fallback = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const since: string = cursor?.at && typeof cursor.at === "string" ? cursor.at : fallback;

  const groups = await fetchErrorGroups(since);

  // Always advance the cursor to now, even when nothing new — otherwise a single old error
  // would re-alert every 15 min forever.
  await kvSet("sre_last_scan_at", { at: new Date().toISOString() });

  if (groups === null || groups.length === 0) return null;

  await audit("sre", "sre.alert", {
    total: groups.reduce((a, g) => a + g.cnt, 0),
    groups: groups.length,
  });
  return {
    text: formatErrorGroups(
      groups,
      (t) => `🛠 <b>${severityLabel(t)}</b> — новые ошибки (${t} за период)`,
    ),
  };
}

/**
 * On-demand report for the /errors command: summarise errors over a fixed lookback window
 * WITHOUT touching the scan cursor (so it never suppresses the next cron alert).
 */
export async function errorReport(sinceMinutes = 24 * 60): Promise<string> {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const groups = await fetchErrorGroups(since);
  if (groups === null) return "Не удалось прочитать журнал ошибок.";
  if (groups.length === 0) return "🟢 Ошибок за период нет.";
  const hours = Math.round(sinceMinutes / 60);
  return formatErrorGroups(
    groups,
    (t) => `🛠 <b>${severityLabel(t)}</b> — ошибки за ${hours}ч (${t})`,
  );
}
