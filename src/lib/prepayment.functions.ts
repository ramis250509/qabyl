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
import { sha256Hex } from "./prepayment/hashes";
import { verifyReceipt } from "./prepayment/verify";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

// Magic-byte guard — never trust the client's Content-Type alone. An .html
// file with a .png extension and image/png Content-Type would otherwise reach
// storage. This blocks the obvious executables.
function isMimeContentPlausible(mime: string, bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (mime === "application/pdf")
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  if (mime === "image/png")
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") {
    const s = new TextDecoder("latin1").decode(bytes.subarray(0, 12));
    return s.startsWith("RIFF") && s.slice(8, 12) === "WEBP";
  }
  if (mime === "image/heic" || mime === "image/heif") {
    const s = new TextDecoder("latin1").decode(bytes.subarray(4, 12));
    return s.startsWith("ftyphe") || s.startsWith("ftypmif") || s.startsWith("ftypheic");
  }
  return false;
}

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
// decode + magic-byte-check + hash + verify + store here. Called by both the
// public booking page and the WA agent.
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
    if (!ALLOWED_MIME.has(data.mime)) {
      return { ok: false as const, error: "Файл такого типа не поддерживается", verdict: null };
    }
    const bytes = base64ToBytes(data.base64);
    if (bytes.length > MAX_BYTES) {
      return { ok: false as const, error: "Файл больше 10 МБ", verdict: null };
    }
    if (!isMimeContentPlausible(data.mime, bytes)) {
      return {
        ok: false as const,
        error: "Содержимое файла не совпадает с заявленным типом",
        verdict: null,
      };
    }

    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    // Resolve the appointment + prepayment by token.
    const { data: snap, error: snapErr } = await supabaseAdmin.rpc(
      "get_prepayment_by_token" as any,
      { _token: data.token },
    );
    if (snapErr) throw new Error(snapErr.message);
    if (!snap || (snap as any).found === false) {
      return { ok: false as const, error: "Запись не найдена", verdict: null };
    }
    const s = snap as any;
    if (s.appt_status === "cancelled" || s.appt_status === "payment_expired") {
      return { ok: false as const, error: "Бронь уже неактивна", verdict: null };
    }
    if (s.status === "verified") {
      return {
        ok: true as const,
        verdict: "verified" as const,
        already: true,
        reasons: ["Оплата уже подтверждена"],
      };
    }

    const salonId: string = s.salon_id;
    const appointmentId: string = s.appointment_id;

    // Hash the raw file — regardless of verify outcome, this hash lands in the
    // dedup index if we choose to accept it.
    const sha = await sha256Hex(bytes);

    // Existing hashes / txns for this salon (anti-reuse).
    const { data: existingHashes } = await supabaseAdmin
      .from("prepayment_receipt_hashes")
      .select("file_sha256, txn_id, file_phash")
      .eq("salon_id", salonId);
    const shaSet = new Set<string>();
    const txnSet = new Set<string>();
    const phashList: string[] = [];
    (existingHashes ?? []).forEach((h: any) => {
      if (h.file_sha256) shaSet.add(h.file_sha256);
      if (h.txn_id) txnSet.add(h.txn_id);
      if (h.file_phash) phashList.push(h.file_phash);
    });

    // Load the salon's settings so verify knows what to expect.
    const { data: cfg } = await supabaseAdmin
      .from("prepayment_settings")
      .select("recipient_name, recipient_details, verify_mode, auto_max_amount")
      .eq("salon_id", salonId)
      .maybeSingle();
    const cfgAny = cfg as any;

    // hold_started_at ≈ appointment_prepayments.created_at (we don't ship it
    // through the RPC snapshot — refetch it once for verify).
    const { data: pp } = await supabaseAdmin
      .from("appointment_prepayments")
      .select("id, created_at, hold_expires_at, expected_amount, currency, status")
      .eq("appointment_id", appointmentId)
      .maybeSingle();
    if (!pp)
      return {
        ok: false as const,
        error: "Предоплата не настроена для этой записи",
        verdict: null,
      };
    const ppAny = pp as any;

    // Storage path (private bucket).
    const ext = extForMime(data.mime, data.filename);
    const objectPath = `${salonId}/${appointmentId}/${cryptoRandomId()}.${ext}`;

    // Mark processing before we do the (slow) Vision call.
    await supabaseAdmin
      .from("appointment_prepayments")
      .update({
        status: "processing",
        receipt_path: objectPath,
        receipt_mime: data.mime,
        receipt_bytes: bytes.length,
        file_sha256: sha,
      })
      .eq("id", ppAny.id);
    await supabaseAdmin.from("prepayment_audit").insert({
      appointment_id: appointmentId,
      salon_id: salonId,
      actor_kind: "client_via_token",
      action: "uploaded",
      detail: { filename: data.filename, mime: data.mime, bytes: bytes.length },
    });

    // Verify (extract → parse → validate).
    const result = await verifyReceipt({
      bytes,
      mime: data.mime,
      filename: data.filename,
      fileSha256: sha,
      expectations: {
        expectedAmount: Number(ppAny.expected_amount),
        expectedCurrency: ppAny.currency,
        recipientName: cfgAny?.recipient_name ?? null,
        recipientPhone: cfgAny?.recipient_details?.phone ?? null,
        recipientAccount:
          cfgAny?.recipient_details?.account ?? cfgAny?.recipient_details?.card ?? null,
        holdStartedAt: new Date(ppAny.created_at),
        holdExpiresAt: new Date(ppAny.hold_expires_at),
        existingFileSha256s: shaSet,
        existingTxnIds: txnSet,
        existingPhashes: phashList,
      },
    });

    // Upload the file to storage AFTER verify decides — even 'rejected' files
    // are kept for the audit trail, so upload unconditionally.
    const { error: upErr } = await supabaseAdmin.storage
      .from("prepayment-receipts")
      .upload(objectPath, bytes, { contentType: data.mime, upsert: false });
    if (upErr) {
      // Non-fatal: record the failure but keep the verdict — admin can re-request.
      await supabaseAdmin.from("prepayment_audit").insert({
        appointment_id: appointmentId,
        salon_id: salonId,
        actor_kind: "system",
        action: "upload_failed",
        detail: { error: upErr.message },
      });
    }

    // Decide final verdict + apply verify_mode.
    const verifyMode = cfgAny?.verify_mode ?? "auto";
    const autoMax = cfgAny?.auto_max_amount ? Number(cfgAny.auto_max_amount) : null;
    const expected = Number(ppAny.expected_amount);
    let finalStatus: string = result.verdict; // 'verified' | 'manual_review' | 'rejected'

    if (finalStatus === "verified") {
      if (verifyMode === "manual_always") {
        finalStatus = "manual_review";
      } else if (verifyMode === "manual_after_verify") {
        finalStatus = "manual_review";
      } else if (verifyMode === "auto_under_amount" && autoMax !== null && expected > autoMax) {
        finalStatus = "manual_review";
      }
    }

    // Persist verify output.
    await supabaseAdmin
      .from("appointment_prepayments")
      .update({
        status: finalStatus,
        verdict: result.verdict,
        verdict_reasons: result.reasons,
        confidence: result.confidence,
        bank: result.bank,
        extracted: result.extracted as any,
        txn_id: result.extracted?.txnId ?? null,
      })
      .eq("id", ppAny.id);

    // Anti-reuse index gets the hash + txn only if we ACCEPTED the file for
    // this appointment (i.e. verified or manual_review). Rejected duplicates
    // don't need re-adding — they're already there or will be re-checked.
    if (finalStatus === "verified" || finalStatus === "manual_review") {
      await supabaseAdmin.from("prepayment_receipt_hashes").insert({
        salon_id: salonId,
        appointment_id: appointmentId,
        file_sha256: sha,
        txn_id: result.extracted?.txnId ?? null,
        bank: result.bank,
      });
    }

    await supabaseAdmin.from("prepayment_audit").insert({
      appointment_id: appointmentId,
      salon_id: salonId,
      actor_kind: "system",
      action: finalStatus,
      detail: {
        reasons: result.reasons,
        reasonCodes: result.reasonCodes,
        confidence: result.confidence,
        usedFallback: result.usedFallback,
      },
    });

    if (finalStatus === "verified") {
      await supabaseAdmin.rpc("confirm_prepayment" as any, { _appointment_id: appointmentId });
    }

    return {
      ok: true as const,
      verdict: finalStatus as "verified" | "manual_review" | "rejected",
      reasons: result.reasons,
      bank: result.bank,
      confidence: result.confidence,
    };
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

function extForMime(mime: string, filename: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  const dot = filename.lastIndexOf(".");
  const rest = dot >= 0 ? filename.slice(dot + 1) : "bin";
  return rest.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "bin";
}

function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function cryptoRandomId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  let hex = "";
  for (let i = 0; i < 16; i += 1) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}
