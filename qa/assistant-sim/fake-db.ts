// In-memory Supabase for the AI-assistant quality system.
//
// WHY A FAKE AND NOT A REAL DATABASE. The simulator runs hundreds of conversations that create,
// move and cancel bookings. Against the production project that is not an option (WhatsApp
// triggers, real salons), and a Supabase branch costs money per run. So the booking rules that
// live in Postgres are ported here 1:1 — get_available_slots, create_appointment (incl.
// assert_master_available for online sources), reschedule_appointment_v2, the prepayment hold,
// the per-conversation lock, the unique and exclusion constraints — and everything above them
// (webhook, drain loop, agent, tools) runs UNCHANGED against this object.
//
// Keep the ports in sync with the SQL. Source of truth, as of 13.09.2026: the functions of the
// same name in project bfxexnpyfslfuelfkhzr. supabase/tests/booking_integrity.sql is the
// real-database counterpart of these semantics.
//
// Atomicity: every RPC body below is synchronous after its optional injected delay, and JS is
// single-threaded, so two "parallel" bookings are serialised exactly like pg_advisory_xact_lock
// serialises them in Postgres.

type Row = Record<string, any>;
type DbError = { message: string; code?: string; details?: string };
type Result = { data: any; error: DbError | null; count?: number | null };

export type Fault = {
  table?: string;
  rpc?: string;
  op?: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
  /** How many matching calls to affect. Default 1. */
  times?: number;
  /** Return this as `{ error }` (what a PostgREST failure looks like to supabase-js). */
  error?: DbError;
  /** Throw instead of returning an error (network failure inside supabase-js). */
  throwMessage?: string;
  /** Delay the call (timeouts, slow database). Combined with error/throw if both are set. */
  delayMs?: number;
};

export type DbEvent = {
  at: string;
  kind: "query" | "rpc";
  table?: string;
  rpc?: string;
  op?: string;
  args?: unknown;
  error?: string | null;
};

// ─── time helpers (timezone-correct, no libraries) ───────────────────────────────────────────

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second);
  return asUtc - (utcMs - (utcMs % 1000));
}

/** `date` (YYYY-MM-DD) + wall-clock `time` (HH:MM[:SS]) in `tz` → UTC epoch ms. */
export function localToUtcMs(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  const off1 = tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function localDateOf(ms: number | string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function localTimeOf(ms: number | string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function normTime(t: string): string {
  const [h, m, s] = String(t).split(":");
  return `${h.padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}:${(s ?? "00").padStart(2, "0")}`;
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T/;
function cmp(a: any, b: any): number {
  if (typeof a === "string" && typeof b === "string" && TS_RE.test(a) && TS_RE.test(b)) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function same(a: any, b: any): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  return cmp(a, b) === 0;
}

let lastTs = 0;
/** Strictly increasing ISO timestamps, so ordering by created_at is always the insertion order. */
export function nowIso(): string {
  const t = Math.max(Date.now(), lastTs + 1);
  lastTs = t;
  return new Date(t).toISOString();
}

const uuid = () => crypto.randomUUID();

// ─── schema knowledge the query builder needs ────────────────────────────────────────────────

type Rel = { table: string; local: string; foreign: string; many: boolean };
const RELATIONS: Record<string, Record<string, Rel>> = {
  appointments: {
    services: { table: "services", local: "service_id", foreign: "id", many: false },
    masters: { table: "masters", local: "master_id", foreign: "id", many: false },
    branches: { table: "branches", local: "branch_id", foreign: "id", many: false },
    salons: { table: "salons", local: "salon_id", foreign: "id", many: false },
  },
  masters: {
    master_services: { table: "master_services", local: "id", foreign: "master_id", many: true },
    branches: { table: "branches", local: "branch_id", foreign: "id", many: false },
  },
  wa_messages: {
    wa_conversations: {
      table: "wa_conversations",
      local: "conversation_id",
      foreign: "id",
      many: false,
    },
  },
};

type Unique = { name: string; cols: string[]; where?: (r: Row) => boolean };
const UNIQUES: Record<string, Unique[]> = {
  wa_messages: [
    {
      name: "wa_messages_green_id_uniq",
      cols: ["salon_id", "green_api_message_id"],
      where: (r) => r.green_api_message_id != null,
    },
  ],
  wa_conversations: [
    { name: "wa_conversations_salon_id_client_phone_key", cols: ["salon_id", "client_phone"] },
  ],
  appointments: [
    {
      name: "appointments_active_prepay_dedup_uidx",
      cols: ["salon_id", "client_phone", "service_id", "master_id", "starts_at"],
      where: (r) => r.status === "confirmed" || r.status === "pending_payment",
    },
  ],
  salon_ai_assistant: [{ name: "salon_ai_assistant_pkey", cols: ["salon_id"] }],
  salon_secrets: [{ name: "salon_secrets_pkey", cols: ["salon_id"] }],
  prepayment_settings: [{ name: "prepayment_settings_pkey", cols: ["salon_id"] }],
};

const DEFAULTS: Record<string, () => Row> = {
  wa_conversations: () => ({
    status: "active",
    state: "idle",
    state_data: {},
    ai_paused: false,
    ai_paused_at: null,
    processing_lock_id: null,
    processing_lock_until: null,
    selected_branch_id: null,
    appointment_id: null,
    channel: "whatsapp",
    created_at: nowIso(),
    last_message_at: nowIso(),
    session_started_at: nowIso(),
  }),
  wa_messages: () => ({
    kind: "text",
    processed_at: null,
    meta: null,
    media_path: null,
    green_api_message_id: null,
    created_at: nowIso(),
  }),
  appointments: () => ({
    status: "confirmed",
    source: "manual",
    manage_token: uuid(),
    created_at: nowIso(),
    updated_at: nowIso(),
    hold_expires_at: null,
    branch_id: null,
    client_notes: null,
    confirmation_status: "pending",
    deleted_at: null,
  }),
  error_logs: () => ({ ts: nowIso() }),
  notifications: () => ({ created_at: nowIso(), is_read: false }),
  masters: () => ({
    is_active: true,
    sort_order: 0,
    branch_id: null,
    specialization: null,
    bio: null,
  }),
  services: () => ({
    is_active: true,
    sort_order: 0,
    category: null,
    price_type: "fixed",
    price_max: null,
    duration_max_min: null,
    buffer_after_min: 0,
  }),
  branches: () => ({ is_active: true, sort_order: 0, working_hours: null, address: null }),
};

// ─── select-string parsing ───────────────────────────────────────────────────────────────────

type SelectItem =
  | { kind: "star" }
  | { kind: "col"; name: string }
  | { kind: "rel"; key: string; rel: string; cols: SelectItem[] };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(s: string): SelectItem[] {
  return splitTop(s || "*").map((item): SelectItem => {
    if (item === "*") return { kind: "star" };
    const m = item.match(/^(?:(\w+):)?(\w+)(?:![\w]+)?\((.*)\)$/s);
    if (m) return { kind: "rel", key: m[1] ?? m[2], rel: m[2], cols: parseSelect(m[3]) };
    const alias = item.match(/^(\w+):(\w+)$/);
    if (alias) return { kind: "col", name: alias[2] };
    return { kind: "col", name: item.replace(/::\w+$/, "") };
  });
}

// ─── the query builder ───────────────────────────────────────────────────────────────────────

class Query implements PromiseLike<Result> {
  op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  cols = "*";
  returnCols: string | null = null;
  filters: Array<(r: Row) => boolean> = [];
  filterLog: Array<[string, string, unknown]> = [];
  orders: Array<{ col: string; asc: boolean }> = [];
  limitN: number | null = null;
  singleMode: null | "single" | "maybe" = null;
  payload: any = null;
  onConflict: string | null = null;
  countMode = false;
  head = false;

  constructor(
    private db: FakeSupabase,
    readonly table: string,
  ) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.cols = cols;
      if (opts?.count) {
        this.countMode = true;
        this.head = Boolean(opts.head);
      }
    } else {
      this.returnCols = cols;
    }
    return this;
  }
  insert(p: any) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  update(p: any) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  upsert(p: any, opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = p;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  private f(name: string, col: string, val: unknown, fn: (r: Row) => boolean) {
    this.filterLog.push([name, col, val]);
    this.filters.push(fn);
    return this;
  }
  eq(c: string, v: any) {
    return this.f("eq", c, v, (r) => same(r[c], v));
  }
  neq(c: string, v: any) {
    return this.f("neq", c, v, (r) => !same(r[c], v));
  }
  in(c: string, vs: any[]) {
    return this.f("in", c, vs, (r) => (vs ?? []).some((v) => same(r[c], v)));
  }
  is(c: string, v: any) {
    return this.f("is", c, v, (r) => (v === null ? r[c] == null : r[c] === v));
  }
  not(c: string, op: string, v: any) {
    if (op === "is") return this.f("not.is", c, v, (r) => (v === null ? r[c] != null : r[c] !== v));
    if (op === "eq") return this.f("not.eq", c, v, (r) => !same(r[c], v));
    if (op === "in") {
      const list = String(v)
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((x) => x.trim());
      return this.f("not.in", c, v, (r) => !list.some((x) => same(r[c], x)));
    }
    throw new Error(`fake-db: unsupported not.${op}`);
  }
  gt(c: string, v: any) {
    return this.f("gt", c, v, (r) => r[c] != null && cmp(r[c], v) > 0);
  }
  gte(c: string, v: any) {
    return this.f("gte", c, v, (r) => r[c] != null && cmp(r[c], v) >= 0);
  }
  lt(c: string, v: any) {
    return this.f("lt", c, v, (r) => r[c] != null && cmp(r[c], v) < 0);
  }
  lte(c: string, v: any) {
    return this.f("lte", c, v, (r) => r[c] != null && cmp(r[c], v) <= 0);
  }
  ilike(c: string, pattern: string) {
    const re = new RegExp(
      "^" +
        String(pattern)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*")
          .replace(/_/g, ".") +
        "$",
      "i",
    );
    return this.f("ilike", c, pattern, (r) => r[c] != null && re.test(String(r[c])));
  }
  like(c: string, pattern: string) {
    return this.ilike(c, pattern);
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.limitN = to - from + 1;
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybe";
    return this;
  }
  single() {
    this.singleMode = "single";
    return this;
  }
  abortSignal() {
    return this;
  }

  then<A = Result, B = never>(
    onFulfilled?: ((v: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((e: any) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.db.execQuery(this).then(onFulfilled, onRejected);
  }
}

// ─── the database ────────────────────────────────────────────────────────────────────────────

export class FakeSupabase {
  tables = new Map<string, Row[]>();
  faults: Fault[] = [];
  events: DbEvent[] = [];
  /** RPCs this fake does not implement are recorded here so a silent gap shows up in reports. */
  unknownRpcs = new Set<string>();

  table(name: string): Row[] {
    let t = this.tables.get(name);
    if (!t) {
      t = [];
      this.tables.set(name, t);
    }
    return t;
  }

  from(table: string) {
    return new Query(this, table);
  }

  injectFault(f: Fault) {
    this.faults.push({ times: 1, ...f });
  }

  /** Seed helper: raw insert without constraint checks (fixtures only). */
  seed(table: string, row: Row): Row {
    const full = { ...(DEFAULTS[table]?.() ?? {}), id: uuid(), ...row };
    this.table(table).push(full);
    return full;
  }

  storage = {
    from: (_bucket: string) => ({
      upload: async () => ({ data: { path: "sim" }, error: null }),
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `data:image/png;base64,iVBORw0KGgo=#${path}` },
        error: null,
      }),
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://sim.local/${path}` } }),
    }),
  };

  private async applyFault(match: {
    table?: string;
    rpc?: string;
    op: string;
  }): Promise<Result | null> {
    const f = this.faults.find(
      (x) =>
        (x.times ?? 1) > 0 &&
        (x.table == null || x.table === match.table) &&
        (x.rpc == null || x.rpc === match.rpc) &&
        (x.op == null || x.op === match.op),
    );
    if (!f) return null;
    f.times = (f.times ?? 1) - 1;
    if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
    if (f.throwMessage) throw new Error(f.throwMessage);
    if (f.error) return { data: null, error: f.error };
    return null;
  }

  private log(e: Omit<DbEvent, "at">) {
    this.events.push({ at: nowIso(), ...e });
    if (this.events.length > 20000) this.events.splice(0, 5000);
  }

  private project(table: string, row: Row, items: SelectItem[]): Row {
    const out: Row = {};
    for (const it of items) {
      if (it.kind === "star") Object.assign(out, structuredClone(row));
      else if (it.kind === "col") out[it.name] = structuredClone(row[it.name] ?? null);
      else {
        const rel = RELATIONS[table]?.[it.rel];
        if (!rel) throw new Error(`fake-db: unknown relation ${table}.${it.rel}`);
        const related = this.table(rel.table).filter((r) => same(r[rel.foreign], row[rel.local]));
        out[it.key] = rel.many
          ? related.map((r) => this.project(rel.table, r, it.cols))
          : related[0]
            ? this.project(rel.table, related[0], it.cols)
            : null;
      }
    }
    return out;
  }

  private checkUniques(table: string, candidate: Row, ignore?: Row): DbError | null {
    for (const u of UNIQUES[table] ?? []) {
      if (u.where && !u.where(candidate)) continue;
      const clash = this.table(table).some(
        (r) =>
          r !== ignore &&
          r !== candidate &&
          (!u.where || u.where(r)) &&
          u.cols.every((c) => same(r[c], candidate[c])),
      );
      if (clash) {
        return {
          code: "23505",
          message: `duplicate key value violates unique constraint "${u.name}"`,
        };
      }
    }
    if (table === "appointments") return this.checkNoOverlap(candidate, ignore);
    return null;
  }

  /** EXCLUDE USING gist (master_id WITH =, tstzrange(starts_at, ends_at) WITH &&) for live rows. */
  private checkNoOverlap(a: Row, ignore?: Row): DbError | null {
    const live = (r: Row) => r.status === "confirmed" || r.status === "pending_payment";
    if (!live(a)) return null;
    const s = new Date(a.starts_at).getTime();
    const e = new Date(a.ends_at).getTime();
    const clash = this.table("appointments").some(
      (r) =>
        r !== a &&
        r !== ignore &&
        live(r) &&
        r.master_id === a.master_id &&
        new Date(r.starts_at).getTime() < e &&
        new Date(r.ends_at).getTime() > s,
    );
    return clash
      ? {
          code: "23P01",
          message: 'conflicting key value violates exclusion constraint "appointments_no_overlap"',
        }
      : null;
  }

  async execQuery(q: Query): Promise<Result> {
    const fault = await this.applyFault({ table: q.table, op: q.op });
    if (fault) {
      this.log({ kind: "query", table: q.table, op: q.op, error: fault.error?.message });
      return fault;
    }
    const rows = this.table(q.table);
    const match = (r: Row) => q.filters.every((f) => f(r));
    let affected: Row[] = [];
    let error: DbError | null = null;

    if (q.op === "select") {
      affected = rows.filter(match);
    } else if (q.op === "insert" || q.op === "upsert") {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      for (const p of list) {
        let target: Row | undefined;
        if (q.op === "upsert") {
          const keys = (q.onConflict ?? "id").split(",").map((k) => k.trim());
          target = rows.find((r) => keys.every((k) => same(r[k], p[k])));
        }
        if (target) {
          const before = { ...target };
          Object.assign(target, structuredClone(p), { updated_at: nowIso() });
          error = this.checkUniques(q.table, target, undefined);
          if (error) Object.assign(target, before);
          else affected.push(target);
        } else {
          const full = { ...(DEFAULTS[q.table]?.() ?? {}), id: uuid(), ...structuredClone(p) };
          error = this.checkUniques(q.table, full);
          if (!error) {
            rows.push(full);
            affected.push(full);
          }
        }
        if (error) break;
      }
    } else if (q.op === "update") {
      for (const r of rows.filter(match)) {
        const before = { ...r };
        Object.assign(r, structuredClone(q.payload));
        if ("updated_at" in before) r.updated_at = nowIso();
        const e = this.checkUniques(q.table, r, undefined);
        if (e) {
          Object.assign(r, before);
          error = e;
          break;
        }
        affected.push(r);
      }
    } else if (q.op === "delete") {
      affected = rows.filter(match);
      this.tables.set(
        q.table,
        rows.filter((r) => !affected.includes(r)),
      );
    }

    this.log({
      kind: "query",
      table: q.table,
      op: q.op,
      args: q.op === "select" ? q.filterLog : { filters: q.filterLog, payload: q.payload },
      error: error?.message ?? null,
    });
    if (error) return { data: null, error };

    if (q.op !== "select" && q.returnCols == null) {
      return { data: null, error: null };
    }
    let out = [...affected];
    for (const o of [...q.orders].reverse()) {
      out.sort((a, b) => {
        if (a[o.col] == null && b[o.col] == null) return 0;
        if (a[o.col] == null) return 1;
        if (b[o.col] == null) return -1;
        return o.asc ? cmp(a[o.col], b[o.col]) : cmp(b[o.col], a[o.col]);
      });
    }
    const count = out.length;
    if (q.limitN != null) out = out.slice(0, q.limitN);
    if (q.head) return { data: null, error: null, count };
    const items = parseSelect(q.op === "select" ? q.cols : (q.returnCols ?? "*"));
    const projected = out.map((r) => this.project(q.table, r, items));
    if (q.singleMode) {
      if (projected.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
      }
      if (projected.length === 0) {
        return q.singleMode === "maybe"
          ? { data: null, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows returned" } };
      }
      return { data: projected[0], error: null, ...(q.countMode ? { count } : {}) };
    }
    return { data: projected, error: null, ...(q.countMode ? { count } : {}) };
  }

  async rpc(name: string, args: Record<string, any> = {}): Promise<Result> {
    const fault = await this.applyFault({ rpc: name, op: "rpc" });
    if (fault) {
      this.log({ kind: "rpc", rpc: name, args, error: fault.error?.message });
      return fault;
    }
    let result: Result;
    try {
      result = { data: this.rpcBody(name, args), error: null };
    } catch (e: any) {
      result = {
        data: null,
        error: { message: e?.message ?? String(e), code: e?.code ?? "P0001" },
      };
    }
    this.log({ kind: "rpc", rpc: name, args, error: result.error?.message ?? null });
    return result;
  }

  // ─── RPC ports ─────────────────────────────────────────────────────────────────────────────

  private rpcBody(name: string, a: Record<string, any>): any {
    switch (name) {
      case "get_available_slots":
        return this.getAvailableSlots(a._master_id, a._service_id, a._date);
      case "create_appointment":
        return this.createAppointment(a);
      case "create_appointment_with_prepayment":
        return this.createAppointmentWithPrepayment(a);
      case "reschedule_appointment_v2":
        return this.rescheduleV2(a._appointment_id, a._new_starts_at, a._new_master_id ?? null);
      case "reschedule_appointment":
        return this.rescheduleLegacy(a._appointment_id, a._new_starts_at);
      case "wa_try_acquire_lock": {
        const c = this.table("wa_conversations").find((r) => r.id === a._conversation_id);
        if (!c) return false;
        const free =
          !c.processing_lock_until ||
          new Date(c.processing_lock_until).getTime() < Date.now() ||
          c.processing_lock_id === a._lock_id;
        if (!free) return false;
        c.processing_lock_id = a._lock_id;
        c.processing_lock_until = new Date(
          Date.now() + (a._ttl_seconds ?? 25) * 1000,
        ).toISOString();
        return true;
      }
      case "wa_release_lock": {
        const c = this.table("wa_conversations").find(
          (r) => r.id === a._conversation_id && r.processing_lock_id === a._lock_id,
        );
        if (c) {
          c.processing_lock_id = null;
          c.processing_lock_until = null;
        }
        return null;
      }
      case "billing_record_usage":
      case "internal_get_cron_secret":
        return null;
      default:
        this.unknownRpcs.add(name);
        throw Object.assign(new Error(`fake-db: RPC ${name} is not implemented`), {
          code: "PGRST202",
        });
    }
  }

  private salonTz(salonId: string): string {
    return this.table("salons").find((s) => s.id === salonId)?.timezone ?? "UTC";
  }

  private serviceBuffer(serviceId: string): number {
    return Number(this.table("services").find((s) => s.id === serviceId)?.buffer_after_min ?? 0);
  }

  /** Port of public.get_available_slots(_master_id, _service_id, _date). */
  getAvailableSlots(masterId: string, serviceId: string, date: string) {
    const svc = this.table("services").find((s) => s.id === serviceId && s.is_active !== false);
    if (!svc) return [];
    const master = this.table("masters").find((m) => m.id === masterId);
    if (!master) return [];
    const tz = this.salonTz(master.salon_id);
    const duration = Number(svc.duration_min);
    const buffer = Number(svc.buffer_after_min ?? 0);
    const lead = Number(
      this.table("salon_ai_assistant").find((x) => x.salon_id === master.salon_id)
        ?.min_lead_minutes ?? 0,
    );
    const earliest = Date.now() + lead * 60_000;
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();

    let branchIntervals: any = null;
    if (master.branch_id) {
      const wh = this.table("branches").find((b) => b.id === master.branch_id)?.working_hours;
      if (wh && typeof wh === "object" && !Array.isArray(wh)) {
        branchIntervals = wh[String(wd)] ?? null;
        if (Array.isArray(branchIntervals) && branchIntervals.length === 0) return [];
      }
    }

    const override = this.table("master_day_overrides").find(
      (o) => o.master_id === masterId && o.date === date,
    );
    if (override && (override.is_off || override.kind === "off")) return [];
    const overrideIntervals =
      override?.kind === "workday" && Array.isArray(override.intervals) && override.intervals.length
        ? override.intervals
        : null;
    const breakIntervals =
      override?.kind === "break" && Array.isArray(override.intervals) ? override.intervals : [];

    const masterIntervals: Array<{ start: string; end: string }> =
      overrideIntervals ??
      this.table("master_schedules")
        .filter((s) => s.master_id === masterId && Number(s.weekday) === wd)
        .map((s) => ({ start: s.start_time, end: s.end_time }));
    if (!masterIntervals.length) return [];

    const out: Array<{ slot_start: string; slot_end: string }> = [];
    const step = 15 * 60_000;
    for (const mi of masterIntervals) {
      const bis = Array.isArray(branchIntervals) ? branchIntervals : [mi];
      for (const bi of bis) {
        const s = [normTime(mi.start), normTime(bi.start)].sort().at(-1)!;
        const e = [normTime(mi.end), normTime(bi.end)].sort()[0];
        if (s >= e) continue;
        let start = localToUtcMs(date, s, tz);
        const endLimit = localToUtcMs(date, e, tz);
        for (;;) {
          const end = start + duration * 60_000;
          const blockEnd = end + buffer * 60_000;
          if (end > endLimit) break;
          if (start <= earliest) {
            start += step;
            continue;
          }
          const busy = this.table("appointments").some(
            (x) =>
              x.master_id === masterId &&
              (x.status === "confirmed" || x.status === "pending_payment") &&
              new Date(x.starts_at).getTime() < blockEnd &&
              new Date(x.ends_at).getTime() + this.serviceBuffer(x.service_id) * 60_000 > start,
          );
          const off = this.table("master_time_off").some(
            (t) =>
              t.master_id === masterId &&
              new Date(t.starts_at).getTime() < blockEnd &&
              new Date(t.ends_at).getTime() > start,
          );
          const onBreak = breakIntervals.some(
            (b: any) =>
              localToUtcMs(date, normTime(b.start), tz) < blockEnd &&
              localToUtcMs(date, normTime(b.end), tz) > start,
          );
          if (!busy && !off && !onBreak) {
            out.push({
              slot_start: new Date(start).toISOString(),
              slot_end: new Date(end).toISOString(),
            });
          }
          start += step;
        }
      }
    }
    return out;
  }

  /** Port of public.assert_master_available — runs for 'widget' and 'ai_assistant' bookings. */
  private assertMasterAvailable(
    masterId: string,
    serviceId: string,
    startsMs: number,
    endsMs: number,
  ) {
    const master = this.table("masters").find((m) => m.id === masterId)!;
    const tz = this.salonTz(master.salon_id);
    const date = localDateOf(startsMs, tz);
    const lead = Number(
      this.table("salon_ai_assistant").find((x) => x.salon_id === master.salon_id)
        ?.min_lead_minutes ?? 0,
    );
    if (lead > 0 && startsMs <= Date.now() + lead * 60_000) {
      throw new Error(`Онлайн-запись закрывается за ${lead} мин до визита. Позвоните в салон.`);
    }
    if (
      this.table("master_time_off").some(
        (t) =>
          t.master_id === masterId &&
          new Date(t.starts_at).getTime() < endsMs &&
          new Date(t.ends_at).getTime() > startsMs,
      )
    ) {
      throw new Error("Мастер не работает в это время (отпуск)");
    }
    if (
      this.table("master_day_overrides").some(
        (o) => o.master_id === masterId && o.date === date && (o.is_off || o.kind === "off"),
      )
    ) {
      throw new Error("У мастера выходной в этот день");
    }
    const hasSchedule =
      this.table("master_schedules").some((s) => s.master_id === masterId) ||
      this.table("master_day_overrides").some(
        (o) => o.master_id === masterId && o.date === date && o.kind === "workday",
      );
    if (!hasSchedule) return;
    const ok = this.getAvailableSlots(masterId, serviceId, date).some(
      (g) => new Date(g.slot_start).getTime() === startsMs,
    );
    if (!ok) throw new Error("Это время вне рабочего графика мастера");
  }

  private breakClash(masterId: string, tz: string, startsMs: number, endsMs: number) {
    const days = new Set([localDateOf(startsMs, tz), localDateOf(endsMs, tz)]);
    for (const d of days) {
      for (const o of this.table("master_day_overrides")) {
        if (
          o.master_id !== masterId ||
          o.date !== d ||
          o.kind !== "break" ||
          !Array.isArray(o.intervals)
        )
          continue;
        for (const b of o.intervals) {
          const bs = localToUtcMs(d, normTime(b.start), tz);
          const be = localToUtcMs(d, normTime(b.end), tz);
          if (startsMs < be && endsMs > bs) {
            throw new Error(
              `У мастера установлен перерыв с ${localTimeOf(bs, tz)} до ${localTimeOf(be, tz)}`,
            );
          }
        }
      }
    }
  }

  private liveOverlap(masterId: string, startsMs: number, blockEndMs: number, exceptId?: string) {
    return this.table("appointments").some(
      (x) =>
        x.id !== exceptId &&
        x.master_id === masterId &&
        (x.status === "confirmed" || x.status === "pending_payment") &&
        new Date(x.starts_at).getTime() < blockEndMs &&
        new Date(x.ends_at).getTime() + this.serviceBuffer(x.service_id) * 60_000 > startsMs,
    );
  }

  /** Port of public.create_appointment (+ the BEFORE INSERT triggers that can reject a row). */
  createAppointment(a: Record<string, any>): string {
    const name = String(a._client_name ?? "").trim();
    const phone = String(a._client_phone ?? "").trim();
    const source = a._source ?? "manual";
    if (!name || name.length > 100) throw new Error("Invalid client name");
    if (phone.length < 5 || phone.length > 20) throw new Error("Invalid client phone");
    if (!["manual", "widget", "ai_assistant"].includes(source)) throw new Error("Invalid source");

    let status = "confirmed";
    let holdUntil: string | null = null;
    if (a._hold_minutes != null) {
      if (a._hold_minutes < 5 || a._hold_minutes > 720)
        throw new Error("Hold minutes out of range");
      status = "pending_payment";
      holdUntil = new Date(Date.now() + a._hold_minutes * 60_000).toISOString();
    }

    const svc = this.table("services").find(
      (s) => s.id === a._service_id && s.salon_id === a._salon_id && s.is_active !== false,
    );
    if (!svc) throw new Error("Service not found");
    let duration = Number(svc.duration_min);
    if (
      a._duration_override_min != null &&
      svc.duration_max_min != null &&
      svc.duration_max_min > duration
    ) {
      duration = Math.min(
        Math.max(Number(a._duration_override_min), duration),
        Number(svc.duration_max_min),
      );
    }
    const master = this.table("masters").find(
      (m) => m.id === a._master_id && m.salon_id === a._salon_id && m.is_active !== false,
    );
    const performs =
      master &&
      this.table("master_services").some(
        (ms) => ms.master_id === master.id && ms.service_id === svc.id,
      );
    if (!performs) throw new Error("Master cannot perform this service");
    if (a._branch_id && master.branch_id && master.branch_id !== a._branch_id) {
      throw new Error("Master does not work at this branch");
    }

    let price = Number(svc.price);
    if (a._price_override != null) {
      if (svc.price_type !== "range")
        throw new Error("Price override allowed only for range-priced services");
      if (
        svc.price_max == null ||
        a._price_override < svc.price ||
        a._price_override > svc.price_max
      ) {
        throw new Error("Price override out of allowed range");
      }
      price = Number(a._price_override);
    }

    const startsMs = new Date(a._starts_at).getTime();
    const endsMs = startsMs + duration * 60_000;
    const blockEndMs = endsMs + Number(svc.buffer_after_min ?? 0) * 60_000;
    if (startsMs <= Date.now()) throw new Error("Cannot book in the past");
    if (source === "widget" || source === "ai_assistant") {
      this.assertMasterAvailable(master.id, svc.id, startsMs, endsMs);
    }
    if (this.liveOverlap(master.id, startsMs, blockEndMs))
      throw new Error("Time slot is no longer available");
    this.breakClash(master.id, this.salonTz(a._salon_id), startsMs, endsMs);

    // validate_appointment_phone_trg: 10–15 digits.
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      throw Object.assign(new Error("Некорректный номер телефона"), { code: "23514" });
    }

    const row: Row = {
      ...DEFAULTS.appointments(),
      id: uuid(),
      salon_id: a._salon_id,
      master_id: master.id,
      service_id: svc.id,
      client_name: name,
      client_phone: phone,
      client_notes: a._client_notes ?? null,
      starts_at: new Date(startsMs).toISOString(),
      ends_at: new Date(endsMs).toISOString(),
      price,
      branch_id: a._branch_id ?? master.branch_id ?? null,
      source,
      status,
      hold_expires_at: holdUntil,
    };
    const err = this.checkUniques("appointments", row);
    if (err) throw Object.assign(new Error(err.message), { code: err.code });
    this.table("appointments").push(row);
    return row.id;
  }

  createAppointmentWithPrepayment(a: Record<string, any>) {
    const cfg = this.table("prepayment_settings").find((p) => p.salon_id === a._salon_id);
    if (!cfg?.enabled) throw new Error("Prepayment is not enabled for this salon");
    const svc = this.table("services").find(
      (s) => s.id === a._service_id && s.salon_id === a._salon_id,
    );
    const base = a._price_override ?? svc?.price;
    if (base == null) throw new Error("Service not found");
    let amount =
      cfg.amount_type === "fixed"
        ? Number(cfg.amount_value)
        : Math.round((base * cfg.amount_value) / 100);
    if (cfg.min_amount != null && amount < cfg.min_amount) amount = cfg.min_amount;
    if (cfg.max_amount != null && amount > cfg.max_amount) amount = cfg.max_amount;
    const id = this.createAppointment({ ...a, _hold_minutes: cfg.hold_minutes ?? 60 });
    const appt = this.table("appointments").find((x) => x.id === id)!;
    this.seed("appointment_prepayments", {
      appointment_id: id,
      salon_id: a._salon_id,
      expected_amount: amount,
      currency: cfg.currency ?? "KGS",
      hold_expires_at: appt.hold_expires_at,
    });
    return {
      appointment_id: id,
      amount,
      currency: cfg.currency ?? "KGS",
      hold_expires_at: appt.hold_expires_at,
      manage_token: appt.manage_token,
    };
  }

  /** Port of public.reschedule_appointment_v2. */
  rescheduleV2(appointmentId: string, newStartsAt: string, newMasterId: string | null) {
    const appt = this.table("appointments").find((x) => x.id === appointmentId);
    if (!appt) throw new Error("Appointment not found");
    if (appt.status !== "confirmed")
      throw new Error("Only confirmed appointments can be rescheduled");
    const startsMs = new Date(newStartsAt).getTime();
    if (startsMs <= Date.now()) throw new Error("Cannot reschedule to the past");
    let masterId = appt.master_id;
    if (newMasterId && newMasterId !== masterId) {
      const m = this.table("masters").find(
        (x) => x.id === newMasterId && x.salon_id === appt.salon_id && x.is_active !== false,
      );
      if (!m) throw new Error("Master not found");
      if (
        !this.table("master_services").some(
          (ms) => ms.master_id === newMasterId && ms.service_id === appt.service_id,
        )
      ) {
        throw new Error("Master does not offer this service");
      }
      masterId = newMasterId;
    }
    const newBranch = this.table("masters").find((m) => m.id === masterId)?.branch_id ?? null;
    const svc = this.table("services").find(
      (s) => s.id === appt.service_id && s.salon_id === appt.salon_id && s.is_active !== false,
    );
    if (!svc) throw new Error("Service not found");
    const endsMs = startsMs + Number(svc.duration_min) * 60_000;
    const blockEndMs = endsMs + Number(svc.buffer_after_min ?? 0) * 60_000;
    if (this.liveOverlap(masterId, startsMs, blockEndMs, appt.id))
      throw new Error("Time slot is no longer available");
    this.breakClash(masterId, this.salonTz(appt.salon_id), startsMs, endsMs);
    if (
      this.table("master_time_off").some(
        (t) =>
          t.master_id === masterId &&
          new Date(t.starts_at).getTime() < blockEndMs &&
          new Date(t.ends_at).getTime() > startsMs,
      )
    ) {
      throw new Error("Мастер не работает в это время");
    }
    const before = { ...appt };
    Object.assign(appt, {
      starts_at: new Date(startsMs).toISOString(),
      ends_at: new Date(endsMs).toISOString(),
      master_id: masterId,
      branch_id: newBranch ?? appt.branch_id,
      updated_at: nowIso(),
    });
    const err = this.checkUniques("appointments", appt, undefined);
    if (err) {
      Object.assign(appt, before);
      throw new Error(err.message);
    }
    return appt.id;
  }

  /** Port of the legacy two-argument public.reschedule_appointment (kept to reproduce its bug). */
  rescheduleLegacy(appointmentId: string, newStartsAt: string) {
    const appt = this.table("appointments").find((x) => x.id === appointmentId);
    if (!appt) throw new Error("Appointment not found");
    if (appt.status !== "confirmed")
      throw new Error("Only confirmed appointments can be rescheduled");
    const startsMs = new Date(newStartsAt).getTime();
    if (startsMs <= Date.now()) throw new Error("Cannot reschedule to the past");
    const svc = this.table("services").find((s) => s.id === appt.service_id)!;
    const endsMs = startsMs + Number(svc.duration_min) * 60_000;
    const blockEndMs = endsMs + Number(svc.buffer_after_min ?? 0) * 60_000;
    const clash = this.table("appointments").some(
      (x) =>
        x.id !== appt.id &&
        x.master_id === appt.master_id &&
        x.status === "confirmed" &&
        new Date(x.starts_at).getTime() < blockEndMs &&
        new Date(x.ends_at).getTime() > startsMs,
    );
    if (clash) throw new Error("Time slot is no longer available");
    const before = { ...appt };
    Object.assign(appt, {
      starts_at: new Date(startsMs).toISOString(),
      ends_at: new Date(endsMs).toISOString(),
    });
    const err = this.checkNoOverlap(appt, undefined);
    if (err) {
      Object.assign(appt, before);
      throw new Error(err.message);
    }
    return appt.id;
  }
}
