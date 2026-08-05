// Server functions behind the admin panel's Instagram tab.
//
// Credentials live in salon_secrets, which has no SELECT grant for `authenticated` — the browser
// can only reach them through these functions, and every one of them checks has_salon_access first.
// That mirrors how the Green-API credentials are handled (src/lib/salon-secrets.functions.ts).
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

function igWebhookUrl(salonId: string): string {
  return `${publicBaseUrl()}/api/public/ig/${salonId}`;
}

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const getInstagramConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: row }, { data: salon }] = await Promise.all([
      supabaseAdmin
        .from("salon_secrets")
        .select("instagram_user_id, instagram_token, instagram_app_secret, instagram_verify_token")
        .eq("salon_id", data.salonId)
        .maybeSingle(),
      supabaseAdmin
        .from("salons")
        .select("instagram_enabled")
        .eq("id", data.salonId)
        .maybeSingle(),
    ]);

    // The verify token is generated on first open rather than made a manual step: the salon has to
    // paste it into Meta during setup, and a field that starts empty with a "generate" button is
    // one more thing to forget. It stays stable afterwards.
    let verifyToken = (row as any)?.instagram_verify_token ?? null;
    if (!verifyToken) {
      verifyToken = genToken();
      await supabaseAdmin
        .from("salon_secrets")
        .upsert(
          { salon_id: data.salonId, instagram_verify_token: verifyToken } as any,
          { onConflict: "salon_id" },
        );
    }

    return {
      instagram_user_id: (row as any)?.instagram_user_id ?? "",
      instagram_token: (row as any)?.instagram_token ?? "",
      instagram_app_secret: (row as any)?.instagram_app_secret ?? "",
      verify_token: verifyToken as string,
      webhook_url: igWebhookUrl(data.salonId),
      enabled: Boolean((salon as any)?.instagram_enabled),
    };
  });

export const upsertInstagramConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        instagram_user_id: z.string().max(64).nullable(),
        instagram_token: z.string().max(512).nullable(),
        instagram_app_secret: z.string().max(128).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        instagram_user_id: data.instagram_user_id?.trim() || null,
        instagram_token: data.instagram_token?.trim() || null,
        instagram_app_secret: data.instagram_app_secret?.trim() || null,
      } as any,
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setInstagramEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Turning the channel ON without working credentials produces the worst possible failure mode:
    // the salon believes the assistant is live, clients write, and the webhook silently 403s.
    // Refuse instead, naming what is missing.
    if (data.enabled) {
      const { data: row } = await supabaseAdmin
        .from("salon_secrets")
        .select("instagram_user_id, instagram_token, instagram_app_secret")
        .eq("salon_id", data.salonId)
        .maybeSingle();
      const missing: string[] = [];
      if (!(row as any)?.instagram_user_id) missing.push("Instagram account ID");
      if (!(row as any)?.instagram_token) missing.push("Access Token");
      if (!(row as any)?.instagram_app_secret) missing.push("App Secret");
      if (missing.length) {
        throw new Error(`Сначала заполните и сохраните: ${missing.join(", ")}`);
      }
    }

    const { error } = await supabaseAdmin
      .from("salons")
      .update({ instagram_enabled: data.enabled } as any)
      .eq("id", data.salonId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Live credential check against Meta, so the salon finds out the token is wrong HERE and not by
 * watching client messages go unanswered. Calls /me on the Instagram Graph API — the cheapest call
 * that proves the token is valid, and it returns the account id we can compare with what was typed.
 */
export const testInstagramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("instagram_user_id, instagram_token")
      .eq("salon_id", data.salonId)
      .maybeSingle();

    const token = (row as any)?.instagram_token ?? "";
    if (!token) return { ok: false as const, error: "Access Token не заполнен" };

    try {
      const res = await fetch(
        "https://graph.instagram.com/v23.0/me?fields=id,username,account_type",
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        const err = body?.error;
        // Code 190 is by far the most common real-world failure: Instagram tokens expire after
        // 60 days and have to be refreshed. Say so instead of echoing Meta's generic wording.
        if (err?.code === 190) {
          return {
            ok: false as const,
            error: "Токен недействителен или истёк — сгенерируйте новый в Meta App Dashboard",
          };
        }
        return {
          ok: false as const,
          error: err?.message ? `Meta: ${err.message}` : `Meta ответила ${res.status}`,
        };
      }

      const configured = (row as any)?.instagram_user_id ?? "";
      const actual = body?.id ? String(body.id) : "";
      if (configured && actual && configured !== actual) {
        return {
          ok: false as const,
          error: `Токен принадлежит аккаунту ${actual}, а в поле Instagram account ID указан ${configured}. Исправьте ID.`,
        };
      }
      return {
        ok: true as const,
        username: body?.username ?? null,
        accountId: actual || null,
        accountType: body?.account_type ?? null,
      };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? "Не удалось связаться с Meta" };
    }
  });
