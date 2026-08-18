// Tell the client that their held slot was released.
//
// prepayment_expire_holds() runs every minute and flips unpaid holds to
// payment_expired, which frees the slot. Until now that happened in total
// silence: the client had been told "держим слот до 14:30", then nothing — they
// either showed up to a booking that no longer existed, or waited for a
// confirmation that was never coming.
//
// Called from the cron route (/api/internal/cron/prepayment-expired), once per
// expired appointment.
//
// Scope: Instagram conversations. WhatsApp holds are not messaged here — that
// channel's outbound path goes through the send-whatsapp edge function and its
// own template rules, and wiring it in blind would risk double-messaging.

import { igSendMessage, type IgCreds } from "@/lib/ig-api.server";
import { isExcludedContact } from "@/lib/excluded-contacts.server";

export type ExpiryNotifyResult =
  | { sent: true }
  | {
      sent: false;
      reason: "not_instagram" | "already_notified" | "no_credentials" | "excluded_contact";
    };

export async function notifyHoldExpired(appointmentId: string): Promise<ExpiryNotifyResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;

  // The conversation that created this hold. state_data still carries the
  // appointment id until the client pays or the state is reset.
  const { data: convs } = await db
    .from("wa_conversations")
    .select("id, salon_id, channel, client_phone, external_id, state, state_data")
    .eq("channel", "instagram")
    .contains("state_data", { prepayment_appointment_id: appointmentId })
    .limit(1);
  const conv = (convs ?? [])[0];
  if (!conv?.external_id) return { sent: false, reason: "not_instagram" };

  // The owner silenced this account ("Контакты без Админа"), and an automated "your slot was
  // released" is still the assistant talking. Fails closed like every other exclusion check.
  if (
    await isExcludedContact(db, conv.salon_id, conv.client_phone, (m, ...r) =>
      console.error(`[prepayment-expiry] ${m}`, ...r),
    )
  ) {
    return { sent: false, reason: "excluded_contact" };
  }

  // Idempotency: pg_cron retries and net.http_post has no delivery guarantee, so
  // a second call for the same appointment must not send a second message.
  const { data: already } = await db
    .from("prepayment_audit")
    .select("id")
    .eq("appointment_id", appointmentId)
    .eq("action", "expired_notified")
    .limit(1);
  if ((already ?? []).length > 0) return { sent: false, reason: "already_notified" };

  const { data: secrets } = await db
    .from("salon_secrets")
    .select("instagram_user_id, instagram_token")
    .eq("salon_id", conv.salon_id)
    .maybeSingle();
  if (!secrets?.instagram_token || !secrets?.instagram_user_id) {
    return { sent: false, reason: "no_credentials" };
  }

  const creds: IgCreds = {
    igUserId: secrets.instagram_user_id,
    token: secrets.instagram_token,
  };

  const text =
    "Время удержания истекло, и слот освободился — оплата так и не пришла. " +
    "Если всё ещё хотите записаться, напишите — подберём новое время.";

  const sent = await igSendMessage(creds, conv.external_id, text);

  await db.from("wa_messages").insert({
    conversation_id: conv.id,
    salon_id: conv.salon_id,
    direction: "out",
    kind: "text",
    text_body: text,
    green_api_message_id: sent.ok ? (sent.messageId ?? null) : null,
    meta: { hold_expired: true },
  });

  await db.from("prepayment_audit").insert({
    appointment_id: appointmentId,
    salon_id: conv.salon_id,
    actor_kind: "system",
    action: "expired_notified",
    detail: { channel: "instagram", delivered: sent.ok },
  });

  // The hold is gone, so the conversation is no longer waiting for a receipt.
  const nextData = { ...(conv.state_data ?? {}) };
  delete nextData.prepayment_appointment_id;
  delete nextData.prepayment_amount;
  delete nextData.prepayment_currency;
  delete nextData.prepayment_hold_expires_at;
  await db
    .from("wa_conversations")
    .update({ state: "collecting", state_data: nextData })
    .eq("id", conv.id);

  return { sent: true };
}
