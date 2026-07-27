/**
 * One-off data migration: OLD (Tokyo, khykprcdojksqvuqyajd) -> NEW (Frankfurt, bfxexnpyfslfuelfkhzr).
 *
 * Selective: only the salons named in TARGET_SALON_NAMES are copied, with all their
 * config rows (branches, services, masters, schedules, secrets, AI config, etc.).
 * Ephemeral data (appointments, wa_*, notifications, push_subscriptions) is intentionally skipped.
 *
 * Auth strategy: "preserve exact passwords" — auth.users + auth.identities rows are copied
 * verbatim over a direct Postgres connection (Bun's built-in SQL), keeping password hashes AND
 * original UUIDs. Because UUIDs are preserved, user_roles need no remapping.
 *
 * Modes (argv[2]):
 *   inspect  - read-only against OLD. Reports salons, per-table row counts, and auth accounts. No writes.
 *   probe    - read-only: verify both Postgres connections + count auth.users. No writes.
 *   migrate  - copies auth (via pg), then config + user_roles (via service role). Idempotent.
 *
 * Credentials come from env (never hardcoded):
 *   OLD_URL, OLD_SR   - old project URL + service_role key (public-schema reads)
 *   NEW_URL, NEW_SR   - new project URL + service_role key (public-schema writes)
 *   CREDS_FILE        - path to JSON { old:{host,port,user,password,db}, new:{...} } for the auth copy
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SQL } from "bun";

const TARGET_SALON_NAMES = ["Lashes Nurzhan", "Skin Art", "Эркеайым"];

const mode = process.argv[2] ?? "inspect";

const OLD_URL = process.env.OLD_URL!;
const OLD_SR = process.env.OLD_SR!;
const NEW_URL = process.env.NEW_URL!;
const NEW_SR = process.env.NEW_SR!;

if (!OLD_URL || !OLD_SR) {
  console.error("Missing OLD_URL / OLD_SR env vars");
  process.exit(1);
}
if (mode === "migrate" && (!NEW_URL || !NEW_SR)) {
  console.error("Missing NEW_URL / NEW_SR env vars (required for migrate)");
  process.exit(1);
}

const adminOpts = { auth: { autoRefreshToken: false, persistSession: false } };
const oldDb = createClient(OLD_URL, OLD_SR, adminOpts);
const newDb: SupabaseClient | null = mode === "migrate" ? createClient(NEW_URL, NEW_SR, adminOpts) : null;

type PgCfg = { host: string; port: number; user: string; password: string; db: string };
function buildPgUrl(c: PgCfg): string {
  const u = encodeURIComponent(c.user);
  const p = encodeURIComponent(c.password);
  return `postgresql://${u}:${p}@${c.host}:${c.port}/${c.db}?sslmode=require`;
}
async function loadCreds(): Promise<{ old: PgCfg; new: PgCfg }> {
  const path = process.env.CREDS_FILE;
  if (!path) throw new Error("CREDS_FILE env var not set");
  return JSON.parse(await Bun.file(path).text());
}

// Tables keyed directly by salon_id, in FK-safe insert order (parents first).
const SALON_TABLES = [
  "salons", // PK = id (the salon id itself)
  "branches",
  "services",
  "service_addons",
  "masters",
  "ai_service_overrides",
  "salon_ai_assistant",
  "salon_faqs",
  "salon_secrets",
  "salon_reviews",
] as const;

// Tables keyed by master_id (need the master-id set), FK-safe order.
const MASTER_TABLES = [
  "master_services",
  "master_schedules",
  "master_day_overrides",
  "master_time_off",
] as const;

const SALON_ID_COL: Record<string, string> = { salons: "id" };

async function selectAll(db: SupabaseClient, table: string, col: string, values: string[]) {
  if (values.length === 0) return [];
  const { data, error } = await db.from(table).select("*").in(col, values);
  if (error) throw new Error(`${table} select failed: ${error.message}`);
  return data ?? [];
}

async function main() {
  if (mode === "probe") {
    const creds = await loadCreds();
    for (const [label, cfg] of [["OLD", creds.old], ["NEW", creds.new]] as const) {
      const sql = new SQL(buildPgUrl(cfg));
      try {
        const [{ n }] = await sql`SELECT count(*)::int AS n FROM auth.users`;
        const [{ v }] = await sql`SELECT current_database() AS v`;
        console.log(`  ${label}: connected OK  db=${v}  auth.users=${n}`);
      } finally {
        await sql.end();
      }
    }
    console.log("\n[probe] both Postgres connections OK — no writes performed.");
    return;
  }

  // 1. Resolve target salons in OLD.
  const { data: allSalons, error: sErr } = await oldDb.from("salons").select("id,name,slug");
  if (sErr) throw new Error(`salons list failed: ${sErr.message}`);
  console.log(`\nAll salons in OLD (${allSalons!.length}):`);
  for (const s of allSalons!) console.log(`  - ${s.name}  [${s.slug}]  ${s.id}`);

  const targets = (allSalons ?? []).filter((s) => TARGET_SALON_NAMES.includes(s.name));
  const missing = TARGET_SALON_NAMES.filter((n) => !targets.some((t) => t.name === n));
  console.log(`\nMatched ${targets.length}/${TARGET_SALON_NAMES.length} target salons:`);
  for (const t of targets) console.log(`  ✓ ${t.name}  ${t.id}`);
  if (missing.length) console.log(`  ✗ NOT FOUND: ${missing.join(", ")}  (check exact spelling)`);

  const salonIds = targets.map((t) => t.id);
  if (salonIds.length === 0) {
    console.log("\nNo target salons matched — aborting.");
    return;
  }

  // 2. Gather master ids for these salons (needed for master_* tables).
  const masters = await selectAll(oldDb, "masters", "salon_id", salonIds);
  const masterIds = masters.map((m: any) => m.id);

  // 3. Report per-table counts (read-only).
  console.log("\nPer-table row counts for target salons (OLD):");
  const salonRows: Record<string, any[]> = {};
  for (const t of SALON_TABLES) {
    const col = SALON_ID_COL[t] ?? "salon_id";
    const rows = await selectAll(oldDb, t, col, salonIds);
    salonRows[t] = rows;
    console.log(`  ${t.padEnd(22)} ${rows.length}`);
  }
  const masterRows: Record<string, any[]> = {};
  for (const t of MASTER_TABLES) {
    const rows = await selectAll(oldDb, t, "master_id", masterIds);
    masterRows[t] = rows;
    console.log(`  ${t.padEnd(22)} ${rows.length}`);
  }

  // 4. Auth footprint: user_roles for these salons + all super_admins.
  const salonRoles = await selectAll(oldDb, "user_roles", "salon_id", salonIds);
  const { data: superRoles } = await oldDb.from("user_roles").select("*").eq("role", "super_admin");
  const roleRows = [...salonRoles, ...(superRoles ?? [])];
  const userIds = [...new Set(roleRows.map((r: any) => r.user_id))];

  console.log(`\nAuth accounts to migrate (${userIds.length}):`);
  const authUsers: any[] = [];
  for (const uid of userIds) {
    const { data, error } = await oldDb.auth.admin.getUserById(uid);
    if (error || !data?.user) {
      console.log(`  ? ${uid}  (could not fetch: ${error?.message ?? "no user"})`);
      continue;
    }
    authUsers.push(data.user);
    const roles = roleRows.filter((r: any) => r.user_id === uid).map((r: any) => r.role);
    console.log(`  - ${data.user.email ?? "(no email)"}  roles=[${[...new Set(roles)].join(",")}]  ${uid}`);
  }

  console.log(`\nuser_roles rows to migrate: ${roleRows.length} (salon-scoped ${salonRoles.length} + super_admin ${superRoles?.length ?? 0})`);

  if (mode === "inspect") {
    console.log("\n[inspect] done — no writes performed.");
    return;
  }

  // ---------- MIGRATE ----------
  const db = newDb!;
  const creds = await loadCreds();
  console.log("\n=== MIGRATE -> NEW (Frankfurt) ===");

  // 4a. Auth: copy auth.users then auth.identities verbatim (preserve password hashes + UUIDs).
  await copyAuth(buildPgUrl(creds.old), buildPgUrl(creds.new), userIds);

  // 4b. Config tables (preserve UUIDs) via service role.
  async function upsert(table: string, rows: any[], conflict?: string) {
    if (rows.length === 0) {
      console.log(`  ${table.padEnd(22)} 0 (skip)`);
      return;
    }
    const { error } = await db.from(table).upsert(rows, conflict ? { onConflict: conflict } : undefined);
    if (error) throw new Error(`upsert ${table} failed: ${error.message}`);
    console.log(`  upserted ${table.padEnd(22)} ${rows.length}`);
  }
  for (const t of SALON_TABLES) {
    const conflict = t === "salon_ai_assistant" || t === "salon_secrets" ? "salon_id" : "id";
    await upsert(t, salonRows[t], conflict);
  }
  for (const t of MASTER_TABLES) {
    const conflict = t === "master_services" ? "master_id,service_id" : "id";
    await upsert(t, masterRows[t], conflict);
  }

  // 4c. user_roles — UUIDs preserved by the auth copy, so migrate original rows unchanged.
  await upsert("user_roles", roleRows, "id");

  console.log("\n=== MIGRATE done ===");
}

/** Copy auth.users + auth.identities for the given user ids, verbatim, via direct Postgres. */
async function copyAuth(oldPg: string, newPg: string, userIds: string[]) {
  const src = new SQL(oldPg);
  const dst = new SQL(newPg);
  const idArr = `{${userIds.join(",")}}`; // Postgres array literal: {uuid1,uuid2,...}
  try {
    for (const table of ["users", "identities"] as const) {
      const whereCol = table === "users" ? "id" : "user_id";
      const rows: any[] = await src`
        SELECT * FROM auth.${src(table)} WHERE ${src(whereCol)} = ANY(${idArr}::uuid[])`;
      if (rows.length === 0) {
        console.log(`  auth.${table}: 0 rows in OLD`);
        continue;
      }
      // Only insert columns that exist and are NOT generated on the destination.
      const dstColRows: any[] = await dst`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = ${table} AND is_generated <> 'ALWAYS'`;
      const dstCols = new Set(dstColRows.map((r) => r.column_name));
      const filtered = rows.map((r) => {
        const o: Record<string, any> = {};
        for (const k of Object.keys(r)) if (dstCols.has(k)) o[k] = r[k];
        return o;
      });
      await dst`INSERT INTO auth.${dst(table)} ${dst(filtered)} ON CONFLICT DO NOTHING`;
      console.log(`  auth.${table}: ${filtered.length} row(s) inserted (on conflict do nothing)`);
    }
  } finally {
    await src.end();
    await dst.end();
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
