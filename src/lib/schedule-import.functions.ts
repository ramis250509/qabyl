// Server functions behind the "import an existing calendar" operator tool.
//
// SHAPE OF THE FEATURE, AND WHY
// -----------------------------
// Preview → commit → (if needed) rollback. Never a one-shot "import" button. A spreadsheet
// kept by hand for months contains ambiguity no parser can resolve — a cell that books two
// people, an amount that could be a deposit or a full payment — so the only safe design is
// one where a human sees exactly what will be written before it is written, and can undo the
// whole batch by its id afterwards.
//
// Idempotency is enforced by the DATABASE (unique index on salon_id + import_key), not by a
// SELECT-then-INSERT check here. That distinction matters: a check in application code can
// interleave with a second run and still produce duplicates, whereas the index cannot.
//
// ACCESS: super_admin only, AND the salon must be listed in SCHEDULE_IMPORT_SALON_IDS. The
// tool writes appointments in bulk under the service role, bypassing RLS — it is an operator
// instrument, not a salon-facing feature, and it fails closed when the env var is unset.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  importKeyFor,
  localTimeToUtc,
  parseScheduleSheet,
  type ParsedBooking,
  type VisitKind,
} from "@/lib/import/schedule-sheet";

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function allowedSalons(): string[] {
  return (process.env.SCHEDULE_IMPORT_SALON_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function assertImportAllowed(userId: string, salonId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  if (!(roles ?? []).some((r: any) => r.role === "super_admin")) {
    throw new Error("Импорт расписания доступен только суперадминистратору");
  }
  const allow = allowedSalons();
  if (!allow.includes(salonId)) {
    // Fail closed and say why, rather than silently importing nothing.
    throw new Error(
      allow.length === 0
        ? "Импорт не включён: переменная SCHEDULE_IMPORT_SALON_IDS не задана"
        : "Импорт для этого салона не включён",
    );
  }
}

// ---------------------------------------------------------------------------
// Source fetching
// ---------------------------------------------------------------------------

/**
 * Turn any Google Sheets URL the owner might paste into its CSV export endpoint.
 *
 * Restricted to docs.google.com on purpose: this runs server-side under the service role, so
 * accepting an arbitrary URL would turn the importer into a server-side request forgery
 * gadget pointed at whatever the caller likes.
 */
export function toCsvExportUrl(raw: string): string {
  const url = new URL(raw);
  if (url.hostname !== "docs.google.com") {
    throw new Error("Поддерживаются только ссылки на Google Таблицы (docs.google.com)");
  }
  const m = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error("Не похоже на ссылку на Google Таблицу");
  const gid = url.hash.match(/gid=(\d+)/)?.[1] ?? url.searchParams.get("gid") ?? "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

async function fetchCsv(sourceUrl: string): Promise<string> {
  const res = await fetch(toCsvExportUrl(sourceUrl), {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `Не удалось скачать таблицу (HTTP ${res.status}). Откройте доступ по ссылке «Просмотр».`,
    );
  }
  const text = await res.text();
  // A sheet that is not shared returns Google's HTML sign-in page with a 200.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error(
      "Google вернул страницу входа вместо таблицы. Откройте доступ «Всем, у кого есть ссылка — Просмотр».",
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type PlannedRow = {
  importKey: string;
  booking: ParsedBooking;
  startsAt: string;
  endsAt: string;
  serviceId: string | null;
  serviceName: string | null;
  price: number;
  /** confirmed for a future visit, completed for one that already happened. */
  status: "confirmed" | "completed";
  notes: string;
  verdict: "new" | "duplicate" | "conflict" | "needs_review" | "unmappable";
  reason: string | null;
};

export type ImportPlan = {
  salonId: string;
  masterId: string | null;
  branchId: string | null;
  timezone: string;
  rows: PlannedRow[];
  summary: Record<PlannedRow["verdict"], number>;
  parseIssues: Array<{ message: string; row: number; column?: number }>;
  /** Visit kinds present in the sheet that have no service mapped yet. */
  unmappedKinds: VisitKind[];
  services: Array<{ id: string; name: string; price: number; durationMin: number }>;
};

const VisitMapSchema = z.record(
  z.enum(["consultation", "repeat", "program", "injection", "unknown"]),
  z.string().uuid().nullable(),
);

/**
 * Build the notes we store on the appointment.
 *
 * The RAW CELL is always the last line and is never paraphrased. If the parser got the visit
 * kind or the amounts wrong, the truth is still sitting on the record for a human to read —
 * which is what makes an imperfect parser acceptable in the first place.
 */
function buildNotes(b: ParsedBooking): string {
  const bits: string[] = [];
  if (b.paid !== null) bits.push(`оплачено ${b.paid.toLocaleString("ru-RU")} сом`);
  if (b.remainder !== null) bits.push(`остаток ${b.remainder.toLocaleString("ru-RU")} сом`);
  if (b.curator) bits.push(`куратор: ${b.curator}`);
  const head = bits.length ? bits.join(", ") : null;
  return [head, `Импорт из таблицы (${b.date} ${b.startTime}): «${b.raw}»`]
    .filter(Boolean)
    .join("\n");
}

async function buildPlan(opts: {
  salonId: string;
  csvText: string;
  visitMap: Partial<Record<VisitKind, string | null>>;
  todayIso?: string;
}): Promise<ImportPlan> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .select("id, timezone")
    .eq("id", opts.salonId)
    .maybeSingle();
  if (salonErr) throw new Error(salonErr.message);
  if (!salon) throw new Error("Салон не найден");
  const tz = (salon as any).timezone || "Asia/Bishkek";

  const [{ data: services }, { data: masters }, { data: existing }] = await Promise.all([
    supabaseAdmin
      .from("services")
      .select("id, name, price, duration_min, is_active")
      .eq("salon_id", opts.salonId),
    supabaseAdmin
      .from("masters")
      .select("id, name, branch_id, is_active")
      .eq("salon_id", opts.salonId)
      .eq("is_active", true)
      .order("sort_order"),
    // Everything already on the calendar, so the preview can tell a re-run (same import_key)
    // apart from a genuine clash with something a human booked.
    supabaseAdmin
      .from("appointments")
      .select("id, import_key, starts_at, ends_at, status, client_name, source")
      .eq("salon_id", opts.salonId),
  ]);

  const master = (masters ?? [])[0] ?? null;
  const serviceById = new Map((services ?? []).map((s: any) => [s.id, s]));
  const seenKeys = new Set(
    (existing ?? []).map((a: any) => a.import_key).filter((k: string | null) => Boolean(k)),
  );
  const busy = (existing ?? [])
    .filter((a: any) => a.status === "confirmed" && !a.import_key)
    .map((a: any) => ({
      from: new Date(a.starts_at).getTime(),
      to: new Date(a.ends_at).getTime(),
      who: a.client_name as string,
    }));

  const today = opts.todayIso ?? new Date().toISOString().slice(0, 10);
  const parsed = parseScheduleSheet(opts.csvText, today);
  const nowMs = Date.now();

  const rows: PlannedRow[] = [];
  const withinBatch = new Set<string>();
  const unmapped = new Set<VisitKind>();

  for (const b of parsed.bookings) {
    const importKey = importKeyFor(b);
    const startsAt = localTimeToUtc(b.date, b.startTime, tz);
    const endsAt = localTimeToUtc(b.date, b.endTime, tz);
    const serviceId = opts.visitMap[b.visitKind] ?? null;
    const service = serviceId ? serviceById.get(serviceId) : null;
    const isPast = startsAt.getTime() < nowMs;

    let verdict: PlannedRow["verdict"] = "new";
    let reason: string | null = null;

    if (seenKeys.has(importKey) || withinBatch.has(importKey)) {
      verdict = "duplicate";
      reason = withinBatch.has(importKey)
        ? "такая же строка уже есть в этой таблице"
        : "уже импортирована ранее";
    } else if (b.confidence === "low") {
      verdict = "needs_review";
      reason = b.warnings.join("; ") || "низкая уверенность разбора";
    } else if (!serviceId) {
      verdict = "unmappable";
      reason = `не выбрана услуга для вида приёма «${b.visitKind}»`;
      unmapped.add(b.visitKind);
    } else if (
      // Only a FUTURE row can clash: past rows land as `completed`, which the
      // double-booking exclusion constraint ignores.
      !isPast &&
      busy.some((x) => startsAt.getTime() < x.to && endsAt.getTime() > x.from)
    ) {
      verdict = "conflict";
      const clash = busy.find((x) => startsAt.getTime() < x.to && endsAt.getTime() > x.from);
      reason = `время занято существующей записью (${clash?.who ?? "?"})`;
    }

    if (verdict === "new") withinBatch.add(importKey);

    rows.push({
      importKey,
      booking: b,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      serviceId,
      serviceName: service ? (service as any).name : null,
      // The price actually collected, when the sheet states one — that is the true revenue
      // for this visit. Falling back to the service list price would overstate every
      // instalment payment as a full 20 000 som programme.
      price:
        b.paid !== null || b.remainder !== null
          ? (b.paid ?? 0)
          : Number((service as any)?.price ?? 0),
      status: isPast ? "completed" : "confirmed",
      notes: buildNotes(b),
      verdict,
      reason,
    });
  }

  const summary: ImportPlan["summary"] = {
    new: 0,
    duplicate: 0,
    conflict: 0,
    needs_review: 0,
    unmappable: 0,
  };
  for (const r of rows) summary[r.verdict]++;

  return {
    salonId: opts.salonId,
    masterId: master?.id ?? null,
    branchId: master?.branch_id ?? null,
    timezone: tz,
    rows,
    summary,
    parseIssues: parsed.issues.map(({ message, row, column }) => ({ message, row, column })),
    unmappedKinds: [...unmapped],
    services: (services ?? [])
      .filter((s: any) => s.is_active)
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        price: Number(s.price),
        durationMin: s.duration_min,
      })),
  };
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export const previewScheduleImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        sourceUrl: z.string().url(),
        visitMap: VisitMapSchema.default({}),
        todayIso: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertImportAllowed(context.userId, data.salonId);
    const csvText = await fetchCsv(data.sourceUrl);
    return await buildPlan({
      salonId: data.salonId,
      csvText,
      visitMap: data.visitMap,
      todayIso: data.todayIso,
    });
  });

export const commitScheduleImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        sourceUrl: z.string().url(),
        visitMap: VisitMapSchema.default({}),
        /** Import keys the operator ticked in the preview. Nothing else is written. */
        acceptKeys: z.array(z.string()).min(1),
        todayIso: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertImportAllowed(context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Re-fetch and re-plan rather than trusting rows posted by the browser. The client can
    // only say WHICH keys to accept; what gets written is derived server-side, so a tampered
    // payload cannot inject an arbitrary appointment.
    const csvText = await fetchCsv(data.sourceUrl);
    const plan = await buildPlan({
      salonId: data.salonId,
      csvText,
      visitMap: data.visitMap,
      todayIso: data.todayIso,
    });

    const masterId = plan.masterId;
    if (!masterId) {
      return { ok: false as const, error: "У салона нет активного специалиста для записи" };
    }

    const accept = new Set(data.acceptKeys);
    const toInsert = plan.rows.filter((r) => r.verdict === "new" && accept.has(r.importKey));
    if (toInsert.length === 0) {
      return { ok: false as const, error: "Нечего импортировать: ни одна строка не подошла" };
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from("appointment_import_batches")
      .insert({
        salon_id: data.salonId,
        source_label: data.sourceUrl,
        created_by: context.userId,
        stats: { requested: toInsert.length, summary: plan.summary },
      })
      .select("id")
      .single();
    if (batchErr) throw new Error(batchErr.message);
    const batchId = (batch as any).id as string;

    // Chunked so one oversized statement cannot time out, and so a mid-run failure still
    // leaves a batch id covering exactly what did land — rollback stays exact either way.
    const CHUNK = 50;
    let inserted = 0;
    const failures: Array<{ key: string; error: string }> = [];

    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const payload = chunk.map((r) => ({
        salon_id: data.salonId,
        master_id: masterId,
        branch_id: plan.branchId,
        // Non-null by construction: a row without a mapped service is classified
        // `unmappable` in buildPlan and can never reach verdict "new".
        service_id: r.serviceId as string,
        client_name: r.booking.clientName,
        client_phone: "", // the source calendar records no phone; allowed only for source='import'
        client_notes: r.notes,
        starts_at: r.startsAt,
        ends_at: r.endsAt,
        price: r.price,
        status: r.status,
        source: "import",
        import_key: r.importKey,
        import_batch_id: batchId,
        reminder_sent: true, // never chase a client about a visit we back-filled
      }));

      const { data: ok, error } = await supabaseAdmin
        .from("appointments")
        .insert(payload)
        .select("id");

      if (error) {
        // Fall back to row-by-row so ONE bad row cannot cost the other 49. The report then
        // names exactly which rows failed and why, instead of a single opaque error.
        for (const row of payload) {
          const { error: rowErr } = await supabaseAdmin.from("appointments").insert(row);
          if (rowErr) failures.push({ key: row.import_key, error: rowErr.message });
          else inserted++;
        }
      } else {
        inserted += (ok ?? []).length;
      }
    }

    await supabaseAdmin
      .from("appointment_import_batches")
      .update({ stats: { requested: toInsert.length, inserted, failures, summary: plan.summary } })
      .eq("id", batchId);

    return {
      ok: true as const,
      batchId,
      inserted,
      requested: toInsert.length,
      skipped: {
        duplicate: plan.summary.duplicate,
        conflict: plan.summary.conflict,
        needsReview: plan.summary.needs_review,
        unmappable: plan.summary.unmappable,
        notAccepted: plan.rows.filter((r) => r.verdict === "new" && !accept.has(r.importKey))
          .length,
      },
      failures,
    };
  });

export const listImportBatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertImportAllowed(context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("appointment_import_batches")
      .select("id, source_label, created_at, rolled_back_at, stats")
      .eq("salon_id", data.salonId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);

    // Live count, not the stored one: a row may since have been cancelled or deleted by hand.
    const withCounts = await Promise.all(
      (rows ?? []).map(async (b: any) => {
        const { count } = await supabaseAdmin
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("import_batch_id", b.id);
        return { ...b, liveCount: count ?? 0 };
      }),
    );
    return withCounts;
  });

export const rollbackScheduleImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), batchId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertImportAllowed(context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Scope the delete by BOTH batch and salon. The batch id alone would be enough in
    // practice; requiring the salon too means a mistyped id can never reach another tenant.
    const { data: gone, error } = await supabaseAdmin
      .from("appointments")
      .delete()
      .eq("import_batch_id", data.batchId)
      .eq("salon_id", data.salonId)
      .eq("source", "import")
      .select("id");
    if (error) throw new Error(error.message);

    await supabaseAdmin
      .from("appointment_import_batches")
      .update({ rolled_back_at: new Date().toISOString() })
      .eq("id", data.batchId)
      .eq("salon_id", data.salonId);

    return { ok: true as const, deleted: (gone ?? []).length };
  });
