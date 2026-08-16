// Manual replies from the admin panel — the human takeover path.
//
// Until now the chats tab was read-only: when the assistant escalated ("нужен администратор"),
// the only way to answer was to pick up the phone and type in the WhatsApp app. That stops being
// possible the moment a salon moves to the WhatsApp Cloud API — a number registered there cannot
// be used in the app at all — so the panel has to become the place where a human answers.
//
// Three things this must get right, because each of them has already bitten us on another path:
//
//   1. The salon is derived from the CONVERSATION, never from the caller. Taking a salonId from
//      the client and checking access against it would let anyone with one salon send messages
//      into another salon's chats simply by pairing their own salonId with a foreign
//      conversationId.
//
//   2. The message is stored with kind "system". That is the exact shape both webhook routes
//      already look for when they build `handoffContext` — an admin's words reach the assistant's
//      next turn, so it resumes knowing what the human promised instead of contradicting it.
//
//   3. Sending pauses the assistant. Without this the client gets the admin's answer and the
//      bot's answer to the same question, in two different wordings, seconds apart.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertSalonAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const sendManualChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        conversationId: z.string().uuid(),
        // 4096 is the WhatsApp body limit; the transports chunk anything long, but there is no
        // legitimate reason for an admin to paste more than this into a chat box.
        text: z.string().trim().min(1).max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("wa_conversations")
      .select("id, salon_id, channel, client_phone, external_id")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv) throw new Error("Диалог не найден");

    // Authorisation against the conversation's OWN salon — see note 1 above.
    await assertSalonAccess(context.supabase, context.userId, conv.salon_id as string);

    // select("*") on purpose: this row keeps gaining channel credentials (Instagram yesterday,
    // Cloud API today), and naming a column a not-yet-migrated database lacks would fail the whole
    // query — turning "send a reply" into a hard error for every salon.
    const { data: secrets } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", conv.salon_id)
      .maybeSingle();

    const text = data.text.trim();
    const channel = (conv.channel ?? "whatsapp") as string;
    const s = (secrets ?? {}) as Record<string, any>;

    let sent: { ok: boolean; messageId?: string | null; error?: string };

    if (channel === "instagram") {
      const { igSendMessage } = await import("@/lib/ig-api.server");
      const recipient = (conv.external_id as string) ?? "";
      if (!recipient) throw new Error("У диалога нет Instagram-получателя");
      const res = await igSendMessage(
        { token: s.instagram_token ?? "", igUserId: s.instagram_user_id ?? null },
        recipient,
        text,
      );
      sent = res.ok
        ? { ok: true, messageId: res.messageId ?? null }
        : { ok: false, error: res.error };
    } else if (channel === "whatsapp_cloud") {
      const { waCloudSendMessage } = await import("@/lib/wa-cloud.server");
      const res = await waCloudSendMessage(
        {
          phoneNumberId: s.whatsapp_cloud_phone_number_id ?? "",
          token: s.whatsapp_cloud_token ?? "",
        },
        (conv.external_id as string) || (conv.client_phone as string),
        text,
      );
      sent = res.ok
        ? { ok: true, messageId: res.messageId ?? null }
        : { ok: false, error: res.error };
    } else {
      const { greenApiSendMessage, normalizeChatIdToPhone } = await import("@/lib/wa-agent.server");
      if (!s.greenapi_instance || !s.greenapi_token) {
        throw new Error("WhatsApp не подключён для этого салона");
      }
      const phone = normalizeChatIdToPhone(conv.client_phone as string);
      const res = await greenApiSendMessage(
        { instance: s.greenapi_instance, token: s.greenapi_token },
        `${phone}@c.us`,
        text,
      );
      sent = res.ok
        ? { ok: true, messageId: res.idMessage ?? null }
        : { ok: false, error: res.error };
    }

    // A failed send must NOT be written to the thread: an admin who sees their message in the
    // panel will assume the client got it, and will not try again.
    if (!sent.ok) {
      throw new Error(sent.error || "Не удалось отправить сообщение");
    }

    const nowIso = new Date().toISOString();
    await supabaseAdmin.from("wa_messages").insert({
      conversation_id: conv.id,
      salon_id: conv.salon_id,
      direction: "out",
      kind: "system",
      text_body: text,
      green_api_message_id: sent.messageId ?? null,
      processed_at: nowIso,
      // `manual` is what lets the chat UI draw this as a sent bubble instead of a grey system
      // note, and what distinguishes an admin's reply from the assistant's own bookkeeping.
      meta: { manual: true, sent_by: context.userId },
    });

    await supabaseAdmin
      .from("wa_conversations")
      .update({
        ai_paused: true,
        ai_paused_at: nowIso,
        last_message_at: nowIso,
        last_message_preview: text.slice(0, 200),
      })
      .eq("id", conv.id);

    return { ok: true as const, sentAt: nowIso };
  });
