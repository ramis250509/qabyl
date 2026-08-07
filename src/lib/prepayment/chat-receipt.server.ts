// Receipt intake from a chat conversation.
//
// When a conversation is in `awaiting_receipt`, an inbound photo is a payment
// receipt — not a "I want this hairstyle" reference. This module short-circuits
// that case: it verifies the file and produces the exact reply, without going
// near the language model.
//
// That is deliberate. Money is the one place in this assistant where a
// non-deterministic answer is unacceptable: the model must never be in a
// position to improvise "оплата принята". The verdict comes from
// processReceipt, and the wording below is a fixed function of that verdict.
//
// The client's photo arrives in the wa-media bucket (that is where both webhooks
// put inbound images). Receipts must not LIVE there — cleanup-wa-media deletes
// its contents after 30 days — so processReceipt re-stores the bytes in the
// private prepayment-receipts bucket, and the wa-media copy is left to expire as
// a normal chat attachment.

import { processReceipt, type ReceiptActor } from "./process.server";

export interface ChatReceiptOutcome {
  // The message to send back to the client, already in final wording.
  reply: string;
  // Where the conversation goes next: a paid booking is done, anything else
  // keeps waiting for a (better) receipt until the hold expires.
  nextState: "done" | "awaiting_receipt";
  verdict: "verified" | "manual_review" | "rejected" | null;
  // True when the salon should be told a human needs to look at this receipt.
  needsSalonReview: boolean;
}

export async function handleChatReceipt(opts: {
  db: any;
  appointmentId: string;
  mediaPath: string;
  actorKind: ReceiptActor;
  timezone: string;
  errLog?: (msg: string, ...rest: unknown[]) => void;
}): Promise<ChatReceiptOutcome> {
  const { db, appointmentId, mediaPath, actorKind } = opts;
  const errLog = opts.errLog ?? (() => {});

  // Pull the bytes back out of the chat-media bucket.
  const { data: blob, error: dlErr } = await db.storage.from("wa-media").download(mediaPath);
  if (dlErr || !blob) {
    errLog(`receipt download failed for ${mediaPath}: ${dlErr?.message ?? "no data"}`);
    return {
      reply:
        "Не получилось открыть присланный файл. Пришлите, пожалуйста, скриншот чека ещё раз одним изображением.",
      nextState: "awaiting_receipt",
      verdict: null,
      needsSalonReview: false,
    };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || guessMimeFromPath(mediaPath);

  const result = await processReceipt({
    appointmentId,
    bytes,
    mime,
    filename: mediaPath.split("/").pop() ?? "receipt",
    actorKind,
  });

  // Hard refusal before verification could run (wrong file type, dead booking…).
  if (!result.ok) {
    return {
      reply: `${result.error ?? "Не удалось обработать файл"}. Пришлите, пожалуйста, скриншот чека ещё раз.`,
      nextState: "awaiting_receipt",
      verdict: null,
      needsSalonReview: false,
    };
  }

  if (result.already) {
    return {
      reply: "Оплата по этой записи уже подтверждена — всё в порядке, ждём вас 🌸",
      nextState: "done",
      verdict: "verified",
      needsSalonReview: false,
    };
  }

  if (result.verdict === "verified") {
    const when = await describeAppointment(db, appointmentId, opts.timezone);
    return {
      reply: `Оплата подтверждена ✅ Вы записаны${when ? ` — ${when}` : ""}. Ждём вас!`,
      nextState: "done",
      verdict: "verified",
      needsSalonReview: false,
    };
  }

  if (result.verdict === "manual_review") {
    return {
      reply:
        "Чек получен, передаю администратору на проверку — обычно это занимает несколько минут. Слот за вами, ничего больше делать не нужно.",
      nextState: "awaiting_receipt",
      verdict: "manual_review",
      needsSalonReview: true,
    };
  }

  // Rejected: say WHY in the client's words, so a fixable mistake (paid less,
  // wrong recipient, sent the same screenshot twice) can actually be fixed.
  const why = (result.reasons ?? []).filter(Boolean).join("; ");
  return {
    reply: why
      ? `Не получилось принять чек: ${why.toLowerCase()}. Проверьте, пожалуйста, и пришлите правильный скриншот — слот пока держим.`
      : "Не получилось распознать чек. Пришлите, пожалуйста, скриншот целиком, чтобы были видны сумма, получатель и время перевода.",
    nextState: "awaiting_receipt",
    verdict: "rejected",
    needsSalonReview: false,
  };
}

async function describeAppointment(
  db: any,
  appointmentId: string,
  timezone: string,
): Promise<string | null> {
  try {
    const { data } = await db
      .from("appointments")
      .select("starts_at, services(name), masters(name)")
      .eq("id", appointmentId)
      .maybeSingle();
    if (!data?.starts_at) return null;
    const when = new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone || "UTC",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(data.starts_at));
    const master = (data as any).masters?.name;
    const service = (data as any).services?.name;
    return [service, when, master ? `мастер ${master}` : null].filter(Boolean).join(", ");
  } catch {
    return null;
  }
}

function guessMimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}
