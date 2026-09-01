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
    return res.ok
      ? { ok: true, messageId: res.messageId ?? null }
      : { ok: false, error: res.error };
  }

  if (channel === "whatsapp_cloud") {
    // Мост Make идёт первым: у салона на мосту облачные реквизиты пустые, и без этой ветки
    // ответ администратора из панели молча упирался бы в «WhatsApp не подключён», хотя клиенту
    // ассистент отвечает. Признак моста — обе колонки заполнены; половина реквизитов мостом не
    // считается (см. миграцию 20260901090000).
    if (s.wa_make_outbound_url && s.wa_make_token) {
      const { makeTransport } = await import("@/lib/wa-transport.server");
      const tx = makeTransport({
        outboundUrl: s.wa_make_outbound_url,
        token: s.wa_make_token,
      });
      const res = await tx.sendText(conv.external_id || conv.client_phone || "", text);
      return res.ok
        ? { ok: true, messageId: res.messageId ?? null }
        : { ok: false, error: res.error };
    }

    const { waCloudSendMessage } = await import("@/lib/wa-cloud.server");
    const res = await waCloudSendMessage(
      {
        phoneNumberId: s.whatsapp_cloud_phone_number_id ?? "",
        token: s.whatsapp_cloud_token ?? "",
      },
      conv.external_id || conv.client_phone || "",
      text,
    );
    return res.ok
      ? { ok: true, messageId: res.messageId ?? null }
      : { ok: false, error: res.error };
  }

  // Сюда попадает канал whatsapp у салона без облачных учётных данных. Раньше на этом месте был
  // откат на Green-API — неофициальный транспорт поверх обычного аккаунта, за который Meta банит
  // номера. Отката больше нет: салон либо подключён официально, либо не подключён вовсе.
  return {
    ok: false,
    error: "WhatsApp не подключён. Откройте настройки салона и нажмите «Подключить WhatsApp».",
  };
}
