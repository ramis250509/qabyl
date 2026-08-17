// One place that knows how to put text in front of a client, whatever channel they arrived on.
//
// Extracted because there are now two senders that are not the agent — an admin typing in the
// panel, and the follow-up cron — and a copy each would mean the next channel gets wired into
// one of them and silently not the other. The agent has its own path (it also sends images,
// typing indicators and QR codes); this covers plain text, which is all either caller needs.

export type ChatChannel = "instagram" | "whatsapp_cloud" | "whatsapp";

export type ChatConversation = {
  id: string;
  salon_id: string;
  channel: string | null;
  client_phone: string | null;
  external_id: string | null;
};

export type ChatSendResult = { ok: true; messageId: string | null } | { ok: false; error: string };

export function normalizeChannel(raw: string | null | undefined): ChatChannel {
  return raw === "instagram" || raw === "whatsapp_cloud" ? raw : "whatsapp";
}

/**
 * Send plain text on whichever transport this conversation belongs to.
 *
 * `secrets` is the salon_secrets row as-is. Callers read it with select("*") on purpose: that
 * row keeps gaining channel credentials, and naming a column a not-yet-migrated database lacks
 * would fail the whole query and turn "send a message" into a hard error for every salon.
 *
 * Never throws for a transport failure — it returns it. A caller that writes the message into
 * the thread before knowing it was delivered shows the admin a reply the client never got.
 */
export async function sendChatText(
  conv: ChatConversation,
  secrets: Record<string, any> | null | undefined,
  text: string,
): Promise<ChatSendResult> {
  const s = secrets ?? {};
  const channel = normalizeChannel(conv.channel);

  if (channel === "instagram") {
    const recipient = conv.external_id ?? "";
    if (!recipient) return { ok: false, error: "У диалога нет Instagram-получателя" };
    const { igSendMessage } = await import("@/lib/ig-api.server");
    const res = await igSendMessage(
      { token: s.instagram_token ?? "", igUserId: s.instagram_user_id ?? null },
      recipient,
      text,
    );
    return res.ok ? { ok: true, messageId: res.messageId ?? null } : { ok: false, error: res.error };
  }

  if (channel === "whatsapp_cloud") {
    const { waCloudSendMessage } = await import("@/lib/wa-cloud.server");
    const res = await waCloudSendMessage(
      {
        phoneNumberId: s.whatsapp_cloud_phone_number_id ?? "",
        token: s.whatsapp_cloud_token ?? "",
      },
      conv.external_id || conv.client_phone || "",
      text,
    );
    return res.ok ? { ok: true, messageId: res.messageId ?? null } : { ok: false, error: res.error };
  }

  const { greenApiSendMessage, normalizeChatIdToPhone } = await import("@/lib/wa-agent.server");
  if (!s.greenapi_instance || !s.greenapi_token) {
    return { ok: false, error: "WhatsApp не подключён для этого салона" };
  }
  const phone = normalizeChatIdToPhone(conv.client_phone ?? "");
  const res = await greenApiSendMessage(
    { instance: s.greenapi_instance, token: s.greenapi_token },
    `${phone}@c.us`,
    text,
  );
  return res.ok
    ? { ok: true, messageId: res.idMessage ?? null }
    : { ok: false, error: res.error ?? "Green-API отклонил отправку" };
}
