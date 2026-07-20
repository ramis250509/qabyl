import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeGreenApiChatId(rawPhone: string | null | undefined) {
  const phone = String(rawPhone ?? "").replace(/[^\d]/g, "");
  if (phone.length < 5) return null;
  return `${phone}@c.us`;
}

// Public base URL of the app, for the client's self-service management link. Override with
// PUBLIC_APP_URL if the domain ever changes; production default is qabyl.com.
function manageUrl(token: string | null | undefined) {
  if (!token) return null;
  const base = (Deno.env.get("PUBLIC_APP_URL") ?? "https://qabyl.com").replace(/\/+$/, "");
  return `${base}/manage/${token}`;
}

async function readGreenApiBody(resp: Response) {
  const raw = await resp.text();
  try {
    return { raw, parsed: raw ? JSON.parse(raw) : null };
  } catch {
    return { raw, parsed: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Authenticate internal caller (DB trigger / send-reminders) with vault-stored secret.
    const { data: expected, error: secretError } = await supabase.rpc("internal_get_cron_secret");
    if (secretError) console.error("send-whatsapp cron secret lookup failed", secretError);
    const provided = req.headers.get("x-cron-secret");
    if (!expected || !provided || provided !== expected) {
      console.error("send-whatsapp unauthorized internal call", { hasExpected: Boolean(expected), hasProvided: Boolean(provided) });
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const { appointment_id, kind } = await req.json();
    if (!appointment_id) {
      return jsonResponse({ error: "appointment_id required" }, 400);
    }

    const { data: appt, error } = await supabase
      .from("appointments")
      .select("*, salons(id, name, address, phone, timezone), masters(name), services(name)")
      .eq("id", appointment_id)
      .single();
    if (error || !appt) {
      console.error("send-whatsapp appointment lookup failed", { appointment_id, error });
      return jsonResponse({ error: "Appointment not found" }, 404);
    }

    const salonBase = appt.salons as any;
    const { data: secrets } = await supabase
      .from("salon_secrets")
      .select("greenapi_instance, greenapi_token, owner_notify_phone")
      .eq("salon_id", appt.salon_id)
      .maybeSingle();
    const salon = { ...salonBase, ...(secrets ?? {}) } as any;
    if (!salon?.greenapi_instance || !salon?.greenapi_token) {
      console.warn("Salon has no GreenAPI credentials configured", appt.salon_id);
      return jsonResponse({ skipped: true, reason: "no_credentials" });
    }

    console.log("send-whatsapp using salon GreenAPI credentials", {
      appointment_id,
      salon_id: appt.salon_id,
      instance: String(salon.greenapi_instance).slice(0, 4) + "***",
      hasToken: Boolean(salon.greenapi_token),
      ownerPhoneConfigured: Boolean(salon.owner_notify_phone),
    });

    const clientChatId = normalizeGreenApiChatId(appt.client_phone as string);
    if (!clientChatId) {
      console.error("send-whatsapp invalid client phone", { appointment_id, client_phone: appt.client_phone });
      return jsonResponse({ error: "Invalid phone" }, 400);
    }

    const start = new Date(appt.starts_at);
    const tz = salon.timezone ?? "Asia/Bishkek";
    const when = start.toLocaleString("ru-RU", { dateStyle: "full", timeStyle: "short", timeZone: tz });
    const timeStr = start.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz });
    const weekday = start.toLocaleString("ru-RU", { weekday: "long", timeZone: tz });
    const dateStr = start.toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: tz });
    const serviceName = (appt.services as any)?.name ?? "услугу";
    const masterName = (appt.masters as any)?.name ?? "—";
    const priceStr = `${Number(appt.price ?? 0).toLocaleString("ru-RU")} сом`;
    const clientFirstName = String(appt.client_name ?? "").trim().split(/\s+/)[0] || "клиент";
    const manage = manageUrl((appt as any).manage_token as string | undefined);
    // Appended to messages the CLIENT receives, so they can self-manage without the assistant.
    const manageLine = manage ? `\n\n🔗 Перенести или отменить запись: ${manage}` : "";

    // Owner-only notes for client-initiated self-service changes. The client already saw the
    // result on the manage page, so we don't re-message them — only the salon owner is informed.
    if (kind === "self_reschedule" || kind === "self_cancel") {
      const ownerPhone = salon.owner_notify_phone;
      if (!ownerPhone) return jsonResponse({ skipped: true, reason: "no_owner_phone" });
      const ownerChatId = normalizeGreenApiChatId(ownerPhone as string);
      if (!ownerChatId) return jsonResponse({ error: "Invalid owner phone" }, 400);
      const ownerText =
        kind === "self_reschedule"
          ? `🔄 Клиент сам перенёс запись (через ссылку) в "${salon.name}"\n\n👤 ${appt.client_name}\n📞 ${appt.client_phone}\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 Новое время: ${when}`
          : `❌ Клиент сам отменил запись (через ссылку) в "${salon.name}"\n\n👤 ${appt.client_name}\n📞 ${appt.client_phone}\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 Было: ${when}`;
      // sendGreenApi is a hoisted function declaration in this scope — safe to call before its text.
      const res = await sendGreenApi(ownerChatId, ownerText, "owner");
      if (!res.ok) return jsonResponse({ error: "Notification provider failed", target: "owner", status: res.status }, 502);
      return jsonResponse({ ok: true, owner: res });
    }

    let text = "";
    if (kind === "reminder") {
      text = `Здравствуйте, ${clientFirstName}! ⏰\n\nНапоминаем: у вас запись примерно через 2 часа в "${salon.name}":\n\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 ${timeStr} — ${weekday}, ${dateStr}${salon.address ? `\n📍 ${salon.address}` : ""}\n\nЖдём вас!${manageLine}`;
    } else if (kind === "reschedule") {
      // Sent when a salon admin moves an existing booking (new time and/or master) in the
      // calendar. The row already holds the NEW values, so we just state the current details.
      text = `Здравствуйте, ${clientFirstName}! 🔄\n\nВаша запись в "${salon.name}" перенесена.\n\nНовое время:\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 ${timeStr} — ${weekday}, ${dateStr}${salon.address ? `\n📍 ${salon.address}` : ""}\n\nЕсли новое время не подходит — просто напишите нам, подберём другое. Ждём вас!${manageLine}`;
    } else if (kind === "cancellation") {
      // Sent when a salon admin cancels a booking in the calendar. starts_at still points at
      // the (now cancelled) slot, which is exactly what the client needs to recognise it.
      text = `Здравствуйте, ${clientFirstName}.\n\nК сожалению, ваша запись в "${salon.name}" на ${timeStr} — ${weekday}, ${dateStr} (${serviceName}) была отменена.\n\nПриносим извинения за неудобства. Чтобы записаться на другое время — просто напишите нам. 🙏${salon.phone ? `\n📞 ${salon.phone}` : ""}`;
    } else {
      text = `Здравствуйте, ${clientFirstName}! 🎉\n\nВы успешно записаны на ${serviceName} в ${timeStr} — ${weekday}, ${dateStr}.\n\nЖдём вас в ${salon.name}!${salon.address ? `\n📍 ${salon.address}` : ""}${salon.phone ? `\n📞 ${salon.phone}` : ""}${manageLine}`;
    }

    async function sendGreenApi(chatId: string, message: string, target: "client" | "owner") {
      const url = `https://api.green-api.com/waInstance${salon.greenapi_instance}/sendMessage/${salon.greenapi_token}`;
      const body = { chatId, message };
      try {
        console.log("GreenAPI request", {
          appointment_id,
          salon_id: appt.salon_id,
          target,
          chatId,
          endpoint: `waInstance${String(salon.greenapi_instance).slice(0, 4)}***/sendMessage/***`,
        });
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await readGreenApiBody(resp);
        if (!resp.ok) {
          console.error("GreenAPI response error", {
            appointment_id,
            salon_id: appt.salon_id,
            target,
            status: resp.status,
            statusText: resp.statusText,
            responseText: result.raw,
            responseJson: result.parsed,
            requestBody: body,
          });
        } else {
          console.log("GreenAPI response ok", { appointment_id, target, status: resp.status, response: result.parsed ?? result.raw });
        }
        return { ok: resp.ok, status: resp.status, result };
      } catch (err: any) {
        console.error("GreenAPI network/unexpected error", {
          appointment_id,
          salon_id: appt.salon_id,
          target,
          message: err?.message,
          stack: err?.stack,
          requestBody: body,
        });
        throw err;
      }
    }

    const clientRes = await sendGreenApi(clientChatId, text, "client");
    if (!clientRes.ok) {
      return jsonResponse({ error: "Notification provider failed", target: "client", status: clientRes.status }, 502);
    }

    // Notify salon owner on new bookings only. Reminders are automated, and
    // reschedule/cancellation were performed by the owner themselves in the calendar,
    // so pinging them back would be noise.
    const isNewBooking = kind == null || kind === "confirmation";
    let ownerRes: any = null;
    if (isNewBooking && salon.owner_notify_phone) {
      const ownerChatId = normalizeGreenApiChatId(salon.owner_notify_phone as string);
      if (ownerChatId) {
        const ownerText = `🔔 Новая запись в "${salon.name}"\n\n👤 Клиент: ${appt.client_name}\n📞 ${appt.client_phone}\n💇 Услуга: ${serviceName}\n💅 Мастер: ${masterName}\n🕐 ${when}\n💰 ${priceStr}${appt.client_notes ? `\n\n📝 ${appt.client_notes}` : ""}`;
        ownerRes = await sendGreenApi(ownerChatId, ownerText, "owner");
        if (!ownerRes.ok) console.error("GreenAPI owner notify error", ownerRes.status, ownerRes.result);
      } else {
        console.error("send-whatsapp invalid owner phone", { appointment_id, owner_notify_phone: salon.owner_notify_phone });
      }
    }

    if (kind === "reminder") {
      await supabase.from("appointments").update({ reminder_sent: true }).eq("id", appointment_id);
    }

    return jsonResponse({ ok: true, client: clientRes, owner: ownerRes });
  } catch (err: any) {
    console.error("send-whatsapp error", err);
    return jsonResponse({ error: "Internal error", details: err?.message ?? String(err) }, 500);
  }
});
