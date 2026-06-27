// Server functions to manage the AI WhatsApp webhook configuration for a salon.
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
  // Stable production URL pattern. Override with PUBLIC_APP_URL if needed.
  return (
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://qabyl.lovable.app"
  );
}

function genToken(): string {
  // 32 hex chars
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const getWaWebhookConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("greenapi_webhook_token")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    const token = row?.greenapi_webhook_token ?? null;
    return {
      has_token: !!token,
      webhook_url: token
        ? `${publicBaseUrl()}/api/public/wa/${data.salonId}?token=${token}`
        : null,
    };
  });

export const regenerateWaWebhookToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = genToken();
    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      { salon_id: data.salonId, greenapi_webhook_token: token },
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return {
      has_token: true,
      webhook_url: `${publicBaseUrl()}/api/public/wa/${data.salonId}?token=${token}`,
    };
  });
