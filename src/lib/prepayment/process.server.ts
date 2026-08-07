// Channel-agnostic receipt processing: bytes in, verdict out.
//
// This is everything that happens to a receipt AFTER some channel has produced
// the raw bytes, and BEFORE that channel words the answer to the client:
//
//   validate file → dedup → verify → apply verify_mode → persist → confirm
//
// It deliberately knows nothing about how the bytes arrived. The browser upload
// path (prepayment.functions.ts, credential = appointments.manage_token) and the
// Instagram path (ig.$salonId.ts, credential = an authenticated conversation)
// both call this with an appointment id and a Uint8Array.
//
// Receipts are stored in the private `prepayment-receipts` bucket and NOWHERE
// else. In particular never in `wa-media`: that bucket is purged daily by the
// cleanup-wa-media function after 30 days, and a receipt is the only evidence
// the salon has in a "I paid" / "no you didn't" dispute months later.

import { sha256Hex } from "./hashes";
import { verifyReceipt } from "./verify";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

// Who handed us this file. Ends up in prepayment_audit so a dispute can be
// replayed: a receipt that arrived over Instagram and one an admin uploaded on
// the client's behalf are very different things.
export type ReceiptActor = "client_via_token" | "wa_agent" | "ig_agent" | "admin";

export interface ProcessReceiptInput {
  appointmentId: string;
  bytes: Uint8Array;
  mime: string;
  filename?: string;
  actorKind: ReceiptActor;
}

export interface ProcessReceiptResult {
  ok: boolean;
  // null when we rejected the file before verification could even run.
  verdict: "verified" | "manual_review" | "rejected" | null;
  reasons: string[];
  // Set when ok === false: a client-facing sentence explaining the refusal.
  error?: string;
  // True when this appointment was already paid — resending is harmless.
  already?: boolean;
  bank?: string | null;
  confidence?: number;
}

// Magic-byte guard — never trust the declared Content-Type alone. An .html file
// with a .png extension and image/png Content-Type would otherwise reach
// storage. Applies to every channel: Meta's CDN is not a trusted source either.
export function isMimeContentPlausible(mime: string, bytes: Uint8Array): boolean {
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

export async function processReceipt(input: ProcessReceiptInput): Promise<ProcessReceiptResult> {
  const { appointmentId, bytes, mime, actorKind } = input;

  // ── 1) File sanity, before anything touches the DB or costs a Vision call ──
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, verdict: null, reasons: [], error: "Файл такого типа не поддерживается" };
  }
  if (bytes.length > MAX_BYTES) {
    return { ok: false, verdict: null, reasons: [], error: "Файл больше 10 МБ" };
  }
  if (!isMimeContentPlausible(mime, bytes)) {
    return {
      ok: false,
      verdict: null,
      reasons: [],
      error: "Содержимое файла не совпадает с заявленным типом",
    };
  }

  const mod = await import("@/integrations/supabase/client.server");
  const supabaseAdmin = mod.supabaseAdmin as any;

  // ── 2) Resolve the appointment and its prepayment row ──────────────────────
  const { data: appt } = await supabaseAdmin
    .from("appointments")
    .select("id, salon_id, status")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) {
    return { ok: false, verdict: null, reasons: [], error: "Запись не найдена" };
  }
  const salonId: string = appt.salon_id;

  if (appt.status === "cancelled" || appt.status === "payment_expired") {
    return { ok: false, verdict: null, reasons: [], error: "Бронь уже неактивна" };
  }

  const { data: pp } = await supabaseAdmin
    .from("appointment_prepayments")
    .select("id, created_at, hold_expires_at, expected_amount, currency, status")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (!pp) {
    return {
      ok: false,
      verdict: null,
      reasons: [],
      error: "Предоплата не настроена для этой записи",
    };
  }

  // Paying twice is a no-op, not an error — the client just resent the same
  // screenshot because they did not see our confirmation.
  if (pp.status === "verified") {
    return {
      ok: true,
      verdict: "verified",
      already: true,
      reasons: ["Оплата уже подтверждена"],
    };
  }

  // ── 3) Anti-reuse material for this salon ──────────────────────────────────
  const sha = await sha256Hex(bytes);

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

  const { data: cfg } = await supabaseAdmin
    .from("prepayment_settings")
    .select("recipient_name, recipient_details, verify_mode, auto_max_amount")
    .eq("salon_id", salonId)
    .maybeSingle();
  const cfgAny = cfg as any;

  // ── 4) Mark processing before the slow Vision call ─────────────────────────
  const ext = extForMime(mime, input.filename ?? "");
  const objectPath = `${salonId}/${appointmentId}/${cryptoRandomId()}.${ext}`;

  await supabaseAdmin
    .from("appointment_prepayments")
    .update({
      status: "processing",
      receipt_path: objectPath,
      receipt_mime: mime,
      receipt_bytes: bytes.length,
      file_sha256: sha,
    })
    .eq("id", pp.id);
  await supabaseAdmin.from("prepayment_audit").insert({
    appointment_id: appointmentId,
    salon_id: salonId,
    actor_kind: actorKind,
    action: "uploaded",
    detail: { filename: input.filename ?? null, mime, bytes: bytes.length },
  });

  // ── 5) Verify ──────────────────────────────────────────────────────────────
  const result = await verifyReceipt({
    bytes,
    mime,
    filename: input.filename,
    fileSha256: sha,
    expectations: {
      expectedAmount: Number(pp.expected_amount),
      expectedCurrency: pp.currency,
      recipientName: cfgAny?.recipient_name ?? null,
      recipientPhone: cfgAny?.recipient_details?.phone ?? null,
      recipientAccount:
        cfgAny?.recipient_details?.account ?? cfgAny?.recipient_details?.card ?? null,
      holdStartedAt: new Date(pp.created_at),
      holdExpiresAt: new Date(pp.hold_expires_at),
      existingFileSha256s: shaSet,
      existingTxnIds: txnSet,
      existingPhashes: phashList,
    },
  });

  // Even a rejected file is kept: it is the evidence behind the refusal.
  const { error: upErr } = await supabaseAdmin.storage
    .from("prepayment-receipts")
    .upload(objectPath, bytes, { contentType: mime, upsert: false });
  if (upErr) {
    // Non-fatal: record it but keep the verdict — the admin can re-request.
    await supabaseAdmin.from("prepayment_audit").insert({
      appointment_id: appointmentId,
      salon_id: salonId,
      actor_kind: "system",
      action: "upload_failed",
      detail: { error: upErr.message },
    });
  }

  // ── 6) Apply the salon's verify_mode on top of the technical verdict ───────
  const verifyMode = cfgAny?.verify_mode ?? "auto";
  const autoMax = cfgAny?.auto_max_amount ? Number(cfgAny.auto_max_amount) : null;
  const expected = Number(pp.expected_amount);
  let finalStatus: string = result.verdict;

  if (finalStatus === "verified") {
    if (verifyMode === "manual_always" || verifyMode === "manual_after_verify") {
      finalStatus = "manual_review";
    } else if (verifyMode === "auto_under_amount" && autoMax !== null && expected > autoMax) {
      finalStatus = "manual_review";
    }
  }

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
    .eq("id", pp.id);

  // Only burn the hash/txn when we ACCEPTED the file for this appointment.
  // A rejected duplicate is already in the index by definition.
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
    ok: true,
    verdict: finalStatus as "verified" | "manual_review" | "rejected",
    reasons: result.reasons,
    bank: result.bank,
    confidence: result.confidence,
  };
}

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

function cryptoRandomId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  let hex = "";
  for (let i = 0; i < 16; i += 1) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}
