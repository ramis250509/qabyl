// Prepayment server functions: settings CRUD, receipt upload/verify (public),
// admin override, signed URL viewer.
//
// The public upload path uses appointments.manage_token as the credential —
// same pattern as get_appointment_by_token / cancel_appointment_by_token in
// migration 20260720150000. The token is opaque and per-appointment, and it
// is the only thing an anon caller ever hands us.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// File validation, hashing, verification and persistence all live in
// prepayment/process.server.ts so that every channel goes through the same
// checks. This module is only the browser-facing transport around it.

// ─────────────────────────── settings CRUD ─────────────────────────────────

const SETTINGS_INPUT = z.object({
  salonId: z.string().uuid(),
  enabled: z.boolean(),
  amountType: z.enum(["fixed", "percent"]),
  amountValue: z.number().nonnegative(),
  minAmount: z.number().nonnegative().nullable(),
  maxAmount: z.number().nonnegative().nullable(),
  currency: z.enum(["KGS", "USD", "RUB", "KZT", "EUR"]),
  holdMinutes: z.number().int().min(5).max(720),
  verifyMode: z.enum(["auto", "auto_under_amount", "manual_after_verify", "manual_always"]),
  autoMaxAmount: z.number().nonnegative().nullable(),
  recipientName: z.string().max(200).nullable(),
  recipientDetails: z
    .object({
      phone: z.string().max(30).optional(),
      card: z.string().max(30).optional(),
      account: z.string().max(60).optional(),
      bank: z.string().max(60).optional(),
    })
    .default({}),
  instructionRu: z.string().max(2000).nullable(),
  instructionKy: z.string().max(2000).nullable(),
  instructionEn: z.string().max(2000).nullable(),
  // Payment QR. The bytes go straight from the browser into the payment-qr bucket (RLS-scoped
  // to the salon's own prefix); only the resulting path/URL come through here. `.optional()`
  // rather than `.nullable()` alone so an older client that doesn't send these fields leaves
  // an existing QR untouched instead of wiping it.
  qrPath: z.string().max(300).nullable().optional(),
  qrUrl: z.string().max(600).nullable().optional(),
});

async function assertSalonOwner(userId: string, salonId: string) {
  const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role, salon_id")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const ok = (roles ?? []).some(
    (r: any) => r.role === "super_admin" || (r.role === "salon_admin" && r.salon_id === salonId),
  );
  if (!ok) throw new Error("Forbidden");
}

export const getPrepaymentSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonOwner(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: row, error } = await supabaseAdmin
      .from("prepayment_settings")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row ?? null;
  });

export const upsertPrepaymentSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SETTINGS_INPUT.parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonOwner(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const payload = {
      salon_id: data.salonId,
      enabled: data.enabled,
      amount_type: data.amountType,
      amount_value: data.amountValue,
      min_amount: data.minAmount,
      max_amount: data.maxAmount,
      currency: data.currency,
      hold_minutes: data.holdMinutes,
      verify_mode: data.verifyMode,
      auto_max_amount: data.autoMaxAmount,
      recipient_name: data.recipientName,
      recipient_details: data.recipientDetails,
      instruction_ru: data.instructionRu,
      instruction_ky: data.instructionKy,
      instruction_en: data.instructionEn,
      // Multi-tenant guard: the bucket layout is <salon_id>/<uuid>.<ext>, and this QR ends up
      // in front of paying clients. A path outside this salon's prefix is rejected outright
      // rather than stored — the agent has the same check before sending, but a bad row should
      // never exist in the first place.
      ...(data.qrPath !== undefined
        ? {
            qr_path: data.qrPath && data.qrPath.startsWith(`${data.salonId}/`) ? data.qrPath : null,
            qr_url: data.qrPath && data.qrPath.startsWith(`${data.salonId}/`) ? data.qrUrl : null,
          }
        : {}),
    };
    const { error } = await supabaseAdmin
      .from("prepayment_settings")
      .upsert(payload, { onConflict: "salon_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─────────────────────────── public: get status ────────────────────────────
// Anon-callable snapshot for the receipt-upload page.
export const getPrepaymentByToken = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ token: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: row, error } = await supabaseAdmin.rpc("get_prepayment_by_token" as any, {
      _token: data.token,
    });
    if (error) throw new Error(error.message);
    return row ?? { found: false };
  });

// ─────────────────────────── public: upload receipt ────────────────────────
// Accepts a base64-encoded file. Server-fns can't take FormData yet in this
// version of TanStack Start, so the client base64-encodes the bytes and we
// decode here. Everything after the decode is channel-agnostic and lives in
// prepayment/process.server.ts — the Instagram path calls the same function.
//
// The credential is appointments.manage_token: opaque, per-appointment, and the
// only thing an anon caller ever hands us.
export const uploadPrepaymentReceipt = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        token: z.string().uuid(),
        filename: z.string().max(200),
        mime: z.string().max(80),
        base64: z.string().max(20_000_000), // ~15 MB base64 covers 10 MB raw
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    // Token → appointment. The token is the ONLY thing that authorises this
    // call, so it is resolved before a single byte is decoded.
    const { data: snap, error: snapErr } = await supabaseAdmin.rpc(
      "get_prepayment_by_token" as any,
      { _token: data.token },
    );
    if (snapErr) throw new Error(snapErr.message);
    if (!snap || (snap as any).found === false) {
      return { ok: false as const, error: "Запись не найдена", verdict: null };
    }

    const { processReceipt } = await import("./prepayment/process.server");
    const result = await processReceipt({
      appointmentId: (snap as any).appointment_id,
      bytes: base64ToBytes(data.base64),
      mime: data.mime,
      filename: data.filename,
      actorKind: "client_via_token",
    });

    return result.ok
      ? {
          ok: true as const,
          verdict: result.verdict,
          reasons: result.reasons,
          ...(result.already ? { already: true } : {}),
          bank: result.bank ?? null,
          confidence: result.confidence ?? 0,
        }
      : { ok: false as const, error: result.error ?? "Не удалось обработать файл", verdict: null };
  });

// ─────────────────────────── admin: override + review ──────────────────────

export const adminConfirmPrepayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        appointmentId: z.string().uuid(),
        note: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: appt } = await supabaseAdmin
      .from("appointments")
      .select("salon_id")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (!appt) throw new Error("Запись не найдена");
    await assertSalonOwner(context.userId, (appt as any).salon_id);

    await supabaseAdmin
      .from("appointment_prepayments")
      .update({
        status: "verified",
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
        review_note: data.note ?? null,
      })
      .eq("appointment_id", data.appointmentId);

    await supabaseAdmin.rpc("confirm_prepayment" as any, { _appointment_id: data.appointmentId });

    await supabaseAdmin.from("prepayment_audit").insert({
      appointment_id: data.appointmentId,
      salon_id: (appt as any).salon_id,
      actor_id: context.userId,
      actor_kind: "admin",
      action: "confirmed",
      detail: { note: data.note },
    });
    return { ok: true };
  });

export const adminRejectPrepayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        appointmentId: z.string().uuid(),
        reason: z.string().min(1).max(500),
        dropHold: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: appt } = await supabaseAdmin
      .from("appointments")
      .select("salon_id, status")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (!appt) throw new Error("Запись не найдена");
    await assertSalonOwner(context.userId, (appt as any).salon_id);

    await supabaseAdmin
      .from("appointment_prepayments")
      .update({
        status: "rejected",
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
        review_note: data.reason,
      })
      .eq("appointment_id", data.appointmentId);

    if (data.dropHold && (appt as any).status === "pending_payment") {
      await supabaseAdmin
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", data.appointmentId);
    }

    await supabaseAdmin.from("prepayment_audit").insert({
      appointment_id: data.appointmentId,
      salon_id: (appt as any).salon_id,
      actor_id: context.userId,
      actor_kind: "admin",
      action: "rejected",
      detail: { reason: data.reason, dropHold: data.dropHold },
    });
    return { ok: true };
  });

// Signed URL for the admin viewer.
export const getReceiptSignedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ appointmentId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: appt } = await supabaseAdmin
      .from("appointments")
      .select("salon_id")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (!appt) throw new Error("Запись не найдена");
    await assertSalonOwner(context.userId, (appt as any).salon_id);
    const { data: pp } = await supabaseAdmin
      .from("appointment_prepayments")
      .select("receipt_path")
      .eq("appointment_id", data.appointmentId)
      .maybeSingle();
    if (!pp || !(pp as any).receipt_path) return { url: null };
    const { data: signed, error } = await supabaseAdmin.storage
      .from("prepayment-receipts")
      .createSignedUrl((pp as any).receipt_path, 5 * 60);
    if (error) throw new Error(error.message);
    return { url: signed?.signedUrl ?? null };
  });

export const listPendingReviews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonOwner(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: rows, error } = await supabaseAdmin
      .from("appointment_prepayments")
      .select(
        "id, appointment_id, expected_amount, currency, verdict, verdict_reasons, confidence, bank, created_at, hold_expires_at, appointments(client_name, client_phone, starts_at, status, service_id, master_id)",
      )
      .eq("salon_id", data.salonId)
      .in("status", ["manual_review", "uploaded", "processing"])
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// ─────────────────────────── helpers ───────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
