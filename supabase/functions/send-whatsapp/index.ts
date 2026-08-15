import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chooseTransport, explainNoTransport } from "../_shared/wa-transport.ts";

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
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  return `${phone}@c.us`;
}

/** Digits only — the shape wa_conversations.client_phone stores and the Cloud API expects. */
function normalizePhone(rawPhone: string | null | undefined) {
  const phone = String(rawPhone ?? "").replace(/[^\d]/g, "");
  return phone.length < 5 ? null : phone;
}

// ---------------------------------------------------------------------------
// WhatsApp Cloud API
// ---------------------------------------------------------------------------
// Implemented inline rather than imported from src/lib/wa-cloud.server.ts: edge functions run in a
// separate Deno runtime and cannot import application code. The two must therefore be kept in step
// by hand — which is why this half is deliberately tiny (send text, send template, nothing else).

const WA_GRAPH_VERSION = Deno.env.get("WA_CLOUD_API_VERSION") ?? "v25.0";

/**
 * Template parameters, IN ORDER, for each kind of business-initiated message.
 *
 * This is a CONTRACT WITH META, not an internal detail: the salon submits a template for approval
 * with a fixed number of {{n}} placeholders, and Meta rejects the send with 132000 if we supply a
 * different count. So the order and count below are what the owner must be told to submit. They are
 * documented for the owner in docs/WA-CLOUD-MIGRATION.md.
 */
type TemplateKind = "confirmation" | "reminder" | "reschedule" | "cancellation" | "owner_alert";

async function sendCloudApi(opts: {
  phoneNumberId: string;
  token: string;
  toPhone: string;
  /** Free-form body. Used only inside the 24-hour window. */
  text?: string;
  /** Approved template to use instead, when outside the window. */
  template?: { name: string; lang: string; params: string[] };
}): Promise<{ ok: boolean; status: number; messageId: string | null; error: string | null }> {
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const body = opts.template
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: opts.toPhone,
        type: "template",
        template: {
          name: opts.template.name,
          language: { code: opts.template.lang },
          ...(opts.template.params.length
            ? {
                components: [
                  {
                    type: "body",
                    parameters: opts.template.params.map((t) => ({ type: "text", text: t })),
                  },
                ],
              }
            : {}),
        },
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: opts.toPhone,
        type: "text",
        text: { body: opts.text ?? "", preview_url: false },
      };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await resp.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON error body — keep the raw text for the log */
    }
    if (!resp.ok) {
      const err = parsed?.error;
      // Meta's own code is carried through because the fix differs completely per code:
      //   131047 — outside the 24-hour window, needs a template rather than a retry
      //   132xxx — template missing / not approved / wrong parameter count
      //   190    — token expired or revoked
      const detail = err
        ? `код ${err.code ?? "?"}: ${err.message ?? ""}`.trim()
        : raw.slice(0, 300);
      console.error("CloudAPI response error", { status: resp.status, detail, requestBody: body });
      return { ok: false, status: resp.status, messageId: null, error: detail };
    }
    return {
      ok: true,
      status: resp.status,
      messageId: parsed?.messages?.[0]?.id ?? null,
      error: null,
    };
  } catch (err: any) {
    console.error("CloudAPI network error", { message: err?.message });
    return { ok: false, status: 0, messageId: null, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
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
      .select(
        "*, salons(id, name, address, phone, timezone, wa_provider, wa_cloud_templates_ready), masters(name), services(name)",
      )
      .eq("id", appointment_id)
      .single();
    if (error || !appt) {
      console.error("send-whatsapp appointment lookup failed", { appointment_id, error });
      return jsonResponse({ error: "Appointment not found" }, 404);
    }

    const salonBase = appt.salons as any;
    // select("*") rather than a column list: this row keeps gaining channel credentials (Instagram,
    // now Cloud API), and naming a column a not-yet-migrated database lacks fails the WHOLE query —
    // which would stop every confirmation for every salon, not just the migrated ones.
    const { data: secrets } = await supabase
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", appt.salon_id)
      .maybeSingle();
    const salon = { ...salonBase, ...(secrets ?? {}) } as any;

    // Confirmation delivery is the only thing the salon owner can act on, so only the
    // confirmation kind writes the status. Reminders and reschedule notices must not
    // overwrite it — the owner's question is always "did THIS client ever hear from us
    // when they booked?".
    const isConfirmation = kind == null || kind === "confirmation";
    async function markConfirmation(
      status: "sent" | "failed" | "skipped",
      detail: string | null,
      messageId?: string | null,
    ) {
      if (!isConfirmation) return;
      const patch: Record<string, unknown> = {
        confirmation_status: status,
        confirmation_detail: detail,
        confirmation_at: new Date().toISOString(),
      };
      if (messageId !== undefined) patch.confirmation_message_id = messageId;
      const { error: markErr } = await supabase
        .from("appointments")
        .update(patch)
        .eq("id", appointment_id);
      // Never fail the send because bookkeeping failed.
      if (markErr) console.error("send-whatsapp confirmation mark failed", { appointment_id, markErr });
    }

    // ---- Which transport carries THIS message.
    //
    // Everything here is business-INITIATED — nobody asked for it. That is the whole difficulty of
    // the Cloud API: free-form text is legal only within 24 hours of the client's last message, and
    // outside that window Meta accepts nothing but a pre-approved template (131047). Template
    // approval depends on Meta business verification and takes days, so a salon can be fully live on
    // Cloud API for conversation long before it can send a single reminder.
    //
    // The hybrid answer (docs/WA-CLOUD-MIGRATION.md, Р1): a migrated salon keeps sending these over
    // Green-API until its templates exist. A salon never silently loses its reminders just because
    // its inbound channel moved.
    const provider = salon?.wa_provider === "cloud" ? "cloud" : "green_api";
    const hasGreen = Boolean(salon?.greenapi_instance && salon?.greenapi_token);
    const hasCloud = Boolean(salon?.whatsapp_cloud_phone_number_id && salon?.whatsapp_cloud_token);
    const templatesReady = salon?.wa_cloud_templates_ready === true;
    const templates = (salon?.whatsapp_cloud_templates ?? {}) as Record<
      string,
      { name?: string; lang?: string } | undefined
    >;

    if (!hasGreen && !hasCloud) {
      console.warn("Salon has no WhatsApp credentials configured", appt.salon_id);
      // Reached only when the salon has whatsapp_enabled but no credentials — a
      // misconfiguration the owner needs to see, not a deliberate opt-out.
      await markConfirmation("failed", "WhatsApp включён, но учётные данные не настроены");
      return jsonResponse({ skipped: true, reason: "no_credentials" });
    }

    console.log("send-whatsapp transport", {
      appointment_id,
      salon_id: appt.salon_id,
      provider,
      hasGreen,
      hasCloud,
      templatesReady,
      ownerPhoneConfigured: Boolean(salon.owner_notify_phone),
    });

    /**
     * Is this number inside Meta's 24-hour customer service window?
     *
     * Worth the query rather than assuming: a client who booked through the AI assistant just wrote
     * to us, so free-form text is legal and the rich formatted message goes out unchanged. A client
     * who booked through the WEB WIDGET has never messaged the business at all — for them the very
     * first confirmation is already outside the window and needs a template. Assuming either way
     * would be wrong for half of all bookings.
     */
    async function withinServiceWindow(rawPhone: string | null | undefined): Promise<boolean> {
      const phone = normalizePhone(rawPhone);
      if (!phone) return false;
      const { data: conv } = await supabase
        .from("wa_conversations")
        .select("id")
        .eq("salon_id", appt.salon_id)
        .eq("client_phone", phone)
        .maybeSingle();
      if (!conv) return false;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("wa_messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("direction", "in")
        .gte("created_at", since)
        .limit(1);
      return (recent ?? []).length > 0;
    }

    /**
     * Send one message by whatever route is legal for it right now.
     *
     * Order matters and encodes the migration policy:
     *   1. Green-API salon → Green-API. Untouched, and the overwhelming majority of traffic.
     *   2. Cloud salon inside the window → Cloud API free-form, so the client still gets the full
     *      formatted message rather than a rigid template.
     *   3. Cloud salon outside the window with an approved template → that template.
     *   4. Anything left over → Green-API, if the salon still has it. This is the hybrid.
     *   5. Nothing available → report WHY, loudly. Never return a silent success.
     */
    async function deliver(opts: {
      rawPhone: string;
      text: string;
      target: "client" | "owner";
      templateKind: TemplateKind;
      templateParams: string[];
    }): Promise<{ ok: boolean; messageId: string | null; detail: string | null; via: string }> {
      const { rawPhone, text, target, templateKind, templateParams } = opts;

      const viaGreen = async () => {
        const chatId = normalizeGreenApiChatId(rawPhone);
        if (!chatId) return { ok: false, messageId: null, detail: "Номер телефона нераспознаваем", via: "green_api" };
        const res = await sendGreenApi(chatId, text, target);
        return {
          ok: res.ok,
          messageId: (res.result?.parsed as any)?.idMessage ?? null,
          detail: res.ok ? null : `Green-API отказал (HTTP ${res.status})`,
          via: "green_api",
        };
      };

      const toPhone = normalizePhone(rawPhone);
      if (!toPhone) {
        return { ok: false, messageId: null, detail: "Номер телефона нераспознаваем", via: "none" };
      }
      const tpl = templates[templateKind];
      // The window costs a query, so it is only asked for when the answer can change the decision:
      // a Green-API salon never needs it.
      const inWindow =
        provider === "cloud" && hasCloud ? await withinServiceWindow(rawPhone) : false;
      const inputs = {
        provider: provider as "green_api" | "cloud",
        hasGreen,
        hasCloud,
        templatesReady,
        hasTemplateForKind: Boolean(tpl?.name),
        inWindow,
      };

      const cloudCreds = {
        phoneNumberId: String(salon.whatsapp_cloud_phone_number_id ?? ""),
        token: String(salon.whatsapp_cloud_token ?? ""),
      };

      const decision = chooseTransport(inputs);
      console.log("send-whatsapp transport decision", { appointment_id, target, templateKind, decision, inWindow });

      if (decision === "cloud_text") {
        const res = await sendCloudApi({ ...cloudCreds, toPhone, text });
        if (res.ok) return { ok: true, messageId: res.messageId, detail: null, via: "cloud_text" };
        // A rejected send is not the end of the road while Green-API is still connected — the
        // client getting the message late over the old transport beats not getting it.
        console.error("CloudAPI free-form send failed, falling back", { target, error: res.error });
        if (hasGreen) return await viaGreen();
        return { ok: false, messageId: null, detail: res.error, via: "none" };
      }

      if (decision === "cloud_template") {
        const res = await sendCloudApi({
          ...cloudCreds,
          toPhone,
          template: { name: tpl!.name!, lang: tpl!.lang || "ru", params: templateParams },
        });
        if (res.ok) {
          return { ok: true, messageId: res.messageId, detail: null, via: "cloud_template" };
        }
        console.error("CloudAPI template send failed, falling back", { target, error: res.error });
        if (hasGreen) return await viaGreen();
        return { ok: false, messageId: null, detail: res.error, via: "none" };
      }

      if (decision === "green_api") return await viaGreen();

      // Nothing could carry it. This case must never look like success: the owner needs to know
      // their client heard nothing, and exactly why.
      const why = explainNoTransport(inputs, templateKind);
      console.error("send-whatsapp: no legal transport", { appointment_id, target, templateKind, why });
      return { ok: false, messageId: null, detail: why, via: "none" };
    }

    // Validated as digits rather than as a Green-API chat id: the same rule applies to both
    // transports, and a cloud salon has no chat ids at all.
    if (!normalizePhone(appt.client_phone as string)) {
      console.error("send-whatsapp invalid client phone", { appointment_id, client_phone: appt.client_phone });
      await markConfirmation("failed", "Номер телефона нераспознаваем");
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
      if (!normalizePhone(ownerPhone as string)) {
        return jsonResponse({ error: "Invalid owner phone" }, 400);
      }
      const ownerText =
        kind === "self_reschedule"
          ? `🔄 Клиент сам перенёс запись (через ссылку) в "${salon.name}"\n\n👤 ${appt.client_name}\n📞 ${appt.client_phone}\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 Новое время: ${when}`
          : `❌ Клиент сам отменил запись (через ссылку) в "${salon.name}"\n\n👤 ${appt.client_name}\n📞 ${appt.client_phone}\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 Было: ${when}`;
      // deliver and sendGreenApi are hoisted function declarations in this scope — safe to call
      // before their text.
      const res = await deliver({
        rawPhone: ownerPhone as string,
        text: ownerText,
        target: "owner",
        templateKind: "owner_alert",
        templateParams: [
          String(salon.name ?? ""),
          String(appt.client_name ?? ""),
          String(appt.client_phone ?? ""),
          serviceName,
          when,
        ],
      });
      if (!res.ok) {
        return jsonResponse(
          { error: "Notification provider failed", target: "owner", detail: res.detail },
          502,
        );
      }
      return jsonResponse({ ok: true, owner: res });
    }

    let text = "";
    if (kind === "reminder") {
      text = `Здравствуйте, ${clientFirstName}! ⏰\n\nНапоминаем о вашей записи в "${salon.name}":\n\n💇 ${serviceName}\n💅 Мастер: ${masterName}\n🕐 ${timeStr} — ${weekday}, ${dateStr}${salon.address ? `\n📍 ${salon.address}` : ""}\n\nЖдём вас!${manageLine}`;
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        let resp: Response;
        try {
          resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
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

    // Which template this message would need if it falls outside the 24-hour window. The parameter
    // order here IS the contract the salon's approved template must match, one entry per {{n}}.
    const clientTemplateKind: TemplateKind =
      kind === "reminder"
        ? "reminder"
        : kind === "reschedule"
          ? "reschedule"
          : kind === "cancellation"
            ? "cancellation"
            : "confirmation";
    const clientTemplateParams =
      clientTemplateKind === "cancellation"
        ? [clientFirstName, String(salon.name ?? ""), `${timeStr} — ${weekday}, ${dateStr}`, serviceName]
        : [
            clientFirstName,
            String(salon.name ?? ""),
            serviceName,
            masterName,
            `${timeStr} — ${weekday}, ${dateStr}`,
          ];

    let clientRes: Awaited<ReturnType<typeof deliver>>;
    try {
      clientRes = await deliver({
        rawPhone: appt.client_phone as string,
        text,
        target: "client",
        templateKind: clientTemplateKind,
        templateParams: clientTemplateParams,
      });
    } catch (sendErr: any) {
      // sendGreenApi rethrows network/timeout failures. The client heard nothing, and that is
      // exactly what the owner must see in the calendar.
      await markConfirmation("failed", `Сеть или таймаут: ${sendErr?.message ?? sendErr}`);
      throw sendErr;
    }
    if (!clientRes.ok) {
      await markConfirmation("failed", clientRes.detail ?? "Провайдер отказал");
      return jsonResponse(
        { error: "Notification provider failed", target: "client", detail: clientRes.detail },
        502,
      );
    }
    // "sent" means the provider ACCEPTED the message, not that the client received it. Both
    // transports report the real outcome later on their status webhook — that is what upgrades this
    // to delivered/failed. The id stored here is what those webhooks match on: Green-API's
    // idMessage or Meta's wamid, in the same column.
    await markConfirmation("sent", null, clientRes.messageId);
    console.log("send-whatsapp client delivered", { appointment_id, via: clientRes.via });

    // Notify salon owner on new bookings only. Reminders are automated, and
    // reschedule/cancellation were performed by the owner themselves in the calendar,
    // so pinging them back would be noise.
    const isNewBooking = kind == null || kind === "confirmation";
    let ownerRes: any = null;
    if (isNewBooking && salon.owner_notify_phone) {
      if (normalizePhone(salon.owner_notify_phone as string)) {
        const ownerText = `🔔 Новая запись в "${salon.name}"\n\n👤 Клиент: ${appt.client_name}\n📞 ${appt.client_phone}\n💇 Услуга: ${serviceName}\n💅 Мастер: ${masterName}\n🕐 ${when}\n💰 ${priceStr}${appt.client_notes ? `\n\n📝 ${appt.client_notes}` : ""}`;
        ownerRes = await deliver({
          rawPhone: salon.owner_notify_phone as string,
          text: ownerText,
          target: "owner",
          templateKind: "owner_alert",
          templateParams: [
            String(salon.name ?? ""),
            String(appt.client_name ?? ""),
            String(appt.client_phone ?? ""),
            serviceName,
            when,
          ],
        });
        // The owner's own alert failing is not a reason to fail the request — the client already got
        // their confirmation — but it must not be silent either.
        if (!ownerRes.ok) console.error("owner notify failed", { appointment_id, detail: ownerRes.detail });
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
