// Server functions behind the admin panel's WhatsApp Cloud API section.
//
// Credentials live in salon_secrets, which has no SELECT grant for `authenticated` — the browser can
// only reach them through these functions, and every one checks has_salon_access first. Same shape
// as the Instagram tab (src/lib/instagram.functions.ts) and the Green-API one
// (src/lib/salon-secrets.functions.ts).
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

function publicBaseUrl(): string {
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || "https://qabyl.com";
}

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The message kinds that can fall outside Meta's 24-hour window and therefore need a template. */
const TEMPLATE_KINDS = [
  "confirmation",
  "reminder",
  "reschedule",
  "cancellation",
  "owner_alert",
  "owner_change",
] as const;

// BOTH fields are optional on the way IN, deliberately. The form builds these entries key by key as
// the owner types, so a half-filled row — a template name with the language box still untouched — is
// the NORMAL intermediate state, not a malformed request. Requiring `lang` here made the whole save
// fail on a zod error, taking the credentials down with it and showing the owner a raw validator
// dump; the language is defaulted to "ru" in the handler anyway, and a row with no name is dropped
// there rather than rejected.
const templateSchema = z.record(
  z.string(),
  z
    .object({ name: z.string().max(128).optional(), lang: z.string().max(16).optional() })
    .nullable(),
);

export const getWaCloudConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: row }, { data: salon }] = await Promise.all([
      supabaseAdmin.from("salon_secrets").select("*").eq("salon_id", data.salonId).maybeSingle(),
      supabaseAdmin
        .from("salons")
        .select("wa_provider, wa_cloud_templates_ready")
        .eq("id", data.salonId)
        .maybeSingle(),
    ]);

    const s = (row ?? {}) as Record<string, any>;

    // Generated on first open rather than made a manual step: the salon has to paste it into Meta
    // during setup, and a field that starts empty with a "generate" button is one more thing to
    // forget. Stable afterwards.
    //
    // CLAIMED CONDITIONALLY, AND READ BACK. A plain read-then-upsert loses a race that happens on
    // literally the first render: React mounts the component twice in development, both calls see
    // NULL, both generate a different token, and both write. The screen then shows whichever
    // response resolved last while the database keeps whichever write landed last — and the owner
    // pastes a verify token into Meta that we will never accept, with nothing anywhere explaining
    // why the handshake fails. Observed on the very first load of this screen.
    //
    // So: make sure the row exists, claim the token only while the column is still empty, then
    // return what is ACTUALLY stored rather than what this call generated.
    let verifyToken = s.whatsapp_cloud_verify_token ?? null;
    if (!verifyToken) {
      await supabaseAdmin
        .from("salon_secrets")
        .upsert({ salon_id: data.salonId } as any, { onConflict: "salon_id" });
      await supabaseAdmin
        .from("salon_secrets")
        .update({ whatsapp_cloud_verify_token: genToken() } as any)
        .eq("salon_id", data.salonId)
        .is("whatsapp_cloud_verify_token", null);
      const { data: fresh } = await supabaseAdmin
        .from("salon_secrets")
        .select("whatsapp_cloud_verify_token")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      verifyToken = (fresh as any)?.whatsapp_cloud_verify_token ?? null;
    }

    // Токен моста Make — по той же схеме и по той же причине, что и verify_token выше: он нужен
    // владельцу для вставки в сценарий, а поле с кнопкой «сгенерировать» — лишний шаг, который
    // забывают. Сам по себе токен мост не включает: маршрут отправки требует ещё и адрес
    // вебхука, поэтому у салона, который Make не касался, он просто лежит неиспользованным.
    let makeToken = s.wa_make_token ?? null;
    if (!makeToken) {
      await supabaseAdmin
        .from("salon_secrets")
        .upsert({ salon_id: data.salonId } as any, { onConflict: "salon_id" });
      await supabaseAdmin
        .from("salon_secrets")
        .update({ wa_make_token: genToken() } as any)
        .eq("salon_id", data.salonId)
        .is("wa_make_token", null);
      const { data: fresh } = await supabaseAdmin
        .from("salon_secrets")
        .select("wa_make_token")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      makeToken = (fresh as any)?.wa_make_token ?? null;
    }

    return {
      make_token: (makeToken ?? "") as string,
      make_outbound_url: (s.wa_make_outbound_url ?? "") as string,
      make_inbound_url: `${publicBaseUrl()}/api/public/wamake/${data.salonId}`,
      // Мостом салон считается только при обоих реквизитах: половина — это молчащий ассистент.
      make_active: Boolean(s.wa_make_token && s.wa_make_outbound_url),
      phone_number_id: s.whatsapp_cloud_phone_number_id ?? "",
      token: s.whatsapp_cloud_token ?? "",
      app_secret: s.whatsapp_cloud_app_secret ?? "",
      waba_id: s.whatsapp_cloud_waba_id ?? "",
      templates: (s.whatsapp_cloud_templates ?? {}) as Record<
        string,
        { name?: string; lang?: string } | undefined
      >,
      verify_token: verifyToken as string,
      webhook_url: `${publicBaseUrl()}/api/public/wacloud/${data.salonId}`,
      provider: ((salon as any)?.wa_provider ?? "green_api") as "green_api" | "cloud",
      templates_ready: Boolean((salon as any)?.wa_cloud_templates_ready),
      // Whether the hybrid safety net is still available — the UI warns when it is not.
      has_green_api: Boolean(s.greenapi_instance && s.greenapi_token),
      template_kinds: TEMPLATE_KINDS as unknown as string[],
    };
  });

/**
 * Включить или выключить мост Make для салона.
 *
 * Единственное, что владелец сюда вводит, — адрес custom webhook своего сценария Make. Токен
 * генерируется нами и только показывается. Пустая строка выключает мост: салон возвращается на
 * прямой Cloud API, если у него заполнены облачные реквизиты, и становится неподключённым, если
 * нет. Это и есть выключатель, которым мост гасится после выдачи Advanced Access.
 */
export const upsertWaMakeConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        outbound_url: z.string().max(500).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);

    const url = data.outbound_url?.trim() || null;
    // Мост шлёт наружу сообщения клиентов салона. Адрес, который случайно ввели с опечаткой в
    // схеме, отправил бы их куда угодно — поэтому только https, и проверяем здесь, а не в
    // транспорте: там уже поздно, там уже есть что отправлять.
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) {
      throw new Error("Адрес вебхука Make должен начинаться с https://");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("salon_secrets")
      .upsert({ salon_id: data.salonId, wa_make_outbound_url: url } as any, {
        onConflict: "salon_id",
      });
    if (error) throw new Error(error.message);
    return { ok: true, active: Boolean(url) };
  });

export const upsertWaCloudConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        phone_number_id: z.string().max(64).nullable(),
        token: z.string().max(1024).nullable(),
        app_secret: z.string().max(128).nullable(),
        waba_id: z.string().max(64).nullable(),
        templates: templateSchema.nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Drop half-filled template rows rather than storing them: a kind whose name is blank must look
    // exactly like a kind that was never configured, because that is what makes the outbound path
    // fall back to Green-API instead of sending a template Meta will reject.
    const cleanTemplates: Record<string, { name: string; lang: string }> = {};
    for (const [kind, tpl] of Object.entries(data.templates ?? {})) {
      const name = tpl?.name?.trim();
      if (!name) continue;
      cleanTemplates[kind] = { name, lang: tpl?.lang?.trim() || "ru" };
    }

    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        whatsapp_cloud_phone_number_id: data.phone_number_id?.trim() || null,
        whatsapp_cloud_token: data.token?.trim() || null,
        whatsapp_cloud_app_secret: data.app_secret?.trim() || null,
        whatsapp_cloud_waba_id: data.waba_id?.trim() || null,
        ...(data.templates !== undefined ? { whatsapp_cloud_templates: cleanTemplates } : {}),
      } as any,
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Flip the salon between transports. THIS is the migration switch.
 *
 * Switching to 'cloud' with incomplete credentials produces the worst failure mode there is: the
 * owner believes the number has moved, clients write, and the webhook silently 403s because there is
 * no app secret to verify the signature against. Refuse instead, naming exactly what is missing.
 *
 * Switching BACK to 'green_api' is never blocked — it is the rollback, and a rollback that can fail
 * validation is not a rollback.
 */
export const setWaProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), provider: z.enum(["green_api", "cloud"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const warnings: string[] = [];
    if (data.provider === "cloud") {
      const [{ data: row }, { data: salon }] = await Promise.all([
        supabaseAdmin.from("salon_secrets").select("*").eq("salon_id", data.salonId).maybeSingle(),
        supabaseAdmin
          .from("salons")
          .select("wa_cloud_templates_ready")
          .eq("id", data.salonId)
          .maybeSingle(),
      ]);
      const s = (row ?? {}) as Record<string, any>;
      const missing: string[] = [];
      if (!s.whatsapp_cloud_phone_number_id) missing.push("Phone Number ID");
      if (!s.whatsapp_cloud_token) missing.push("Access Token");
      // Not optional, unlike Instagram's: without it the inbound POST has no authentication at all,
      // and the route refuses every delivery.
      if (!s.whatsapp_cloud_app_secret) missing.push("App Secret");
      if (missing.length) {
        throw new Error(`Сначала заполните и сохраните: ${missing.join(", ")}`);
      }

      // Not a refusal — a warning the owner must see before clients feel it. Outside the 24-hour
      // window a salon in this state can send nothing at all: no template, no Green-API fallback.
      const hasGreen = Boolean(s.greenapi_instance && s.greenapi_token);
      const templatesReady = Boolean((salon as any)?.wa_cloud_templates_ready);
      if (!hasGreen && !templatesReady) {
        warnings.push(
          "Green-API отключён, а шаблоны Meta ещё не одобрены: напоминания, перенос и отмена НЕ будут отправляться клиентам, которые писали больше 24 часов назад.",
        );
      }
    }

    const { error } = await supabaseAdmin
      .from("salons")
      .update({ wa_provider: data.provider } as any)
      .eq("id", data.salonId);
    if (error) throw new Error(error.message);
    return { ok: true as const, warnings };
  });

export const setWaCloudTemplatesReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), ready: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Turning this ON tells the outbound path to stop using Green-API for out-of-window messages, so
    // an empty template list here means those messages stop going out entirely.
    if (data.ready) {
      const { data: row } = await supabaseAdmin
        .from("salon_secrets")
        .select("whatsapp_cloud_templates")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      const templates = ((row as any)?.whatsapp_cloud_templates ?? {}) as Record<string, any>;
      if (!Object.keys(templates).length) {
        throw new Error(
          "Сначала укажите имена одобренных шаблонов хотя бы для одного вида сообщений",
        );
      }
    }

    const { error } = await supabaseAdmin
      .from("salons")
      .update({ wa_cloud_templates_ready: data.ready } as any)
      .eq("id", data.salonId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Live credential check against Meta, so the salon finds out the token is wrong HERE and not by
 * watching client messages go unanswered.
 *
 * Reads the phone number itself — the cheapest call that proves the token AND the phone number id
 * are both right, and it returns the display number so the owner can confirm they connected the one
 * they meant to.
 */
export const testWaCloudConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", data.salonId)
      .maybeSingle();

    const s = (row ?? {}) as Record<string, any>;
    const token = s.whatsapp_cloud_token ?? "";
    const phoneNumberId = s.whatsapp_cloud_phone_number_id ?? "";
    if (!token) return { ok: false as const, error: "Access Token не заполнен" };
    if (!phoneNumberId) return { ok: false as const, error: "Phone Number ID не заполнен" };

    const version = process.env.WA_CLOUD_API_VERSION || "v25.0";
    try {
      const res = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        const err = body?.error;
        // 190 is the one an owner will actually hit: a system-user token that was revoked, or a
        // temporary token that expired. Saying so beats echoing Meta's generic wording.
        if (err?.code === 190) {
          return {
            ok: false as const,
            error: "Токен недействителен или отозван — создайте новый в Meta Business Settings",
          };
        }
        if (err?.code === 100) {
          return {
            ok: false as const,
            error:
              "Meta не знает такой Phone Number ID. Проверьте, что скопирован именно ID номера, а не сам номер телефона",
          };
        }
        return {
          ok: false as const,
          error: err?.message ? `Meta: ${err.message}` : `Meta ответила ${res.status}`,
        };
      }
      return {
        ok: true as const,
        phone: (body?.display_phone_number ?? null) as string | null,
        name: (body?.verified_name ?? null) as string | null,
        quality: (body?.quality_rating ?? null) as string | null,
      };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e) };
    }
  });

/**
 * Answer the one question that matters when a client's message goes unanswered: did Meta actually
 * call our webhook?
 *
 * Needs no new tables, because the three outcomes each leave their own trace:
 *   - Meta called and we accepted it → an inbound row on a whatsapp_cloud conversation
 *   - Meta called and we refused it  → a warn row in error_logs from source 'wacloud-webhook'
 *   - Meta never called              → neither
 * The third is the common one and is always a Meta-side setup problem (webhook field not subscribed,
 * app in development mode, the number not added to the app) — never something fixable on our side,
 * which is exactly what the salon needs to be told.
 */
export const getWaCloudDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: convs } = await supabaseAdmin
      .from("wa_conversations")
      .select("id")
      .eq("salon_id", data.salonId)
      .eq("channel", "whatsapp_cloud");
    const convIds = (convs ?? []).map((c: any) => c.id as string);

    const [inbound, outbound, webhookIssue] = await Promise.all([
      convIds.length
        ? supabaseAdmin
            .from("wa_messages")
            .select("created_at, text_body")
            .in("conversation_id", convIds)
            .eq("direction", "in")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // "Last reply" must mean the last reply Meta actually ACCEPTED, not the last one we composed.
      // A refused send still writes its row (the text is worth keeping for the admin) but with a
      // null message id — counting those as success would report a healthy channel to a salon whose
      // every answer is being bounced.
      convIds.length
        ? supabaseAdmin
            .from("wa_messages")
            .select("created_at, text_body")
            .in("conversation_id", convIds)
            .eq("direction", "out")
            .eq("kind", "text")
            .not("green_api_message_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from("error_logs" as any)
        .select("ts, message")
        .eq("salon_id", data.salonId)
        .eq("source", "wacloud-webhook")
        .order("ts", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return {
      conversationCount: convIds.length,
      lastInboundAt: (inbound as any)?.data?.created_at ?? null,
      lastInboundText: ((inbound as any)?.data?.text_body ?? null) as string | null,
      lastOutboundAt: (outbound as any)?.data?.created_at ?? null,
      lastWebhookIssueAt: (webhookIssue as any)?.data?.ts ?? null,
      lastWebhookIssue: ((webhookIssue as any)?.data?.message ?? null) as string | null,
    };
  });
