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

export const getSalonSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("salon_secrets")
      .select("greenapi_instance, greenapi_token, owner_notify_phone")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      greenapi_instance: row?.greenapi_instance ?? "",
      greenapi_token: row?.greenapi_token ?? "",
      owner_notify_phone: row?.owner_notify_phone ?? "",
    };
  });

export const upsertSalonSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      salonId: z.string().uuid(),
      greenapi_instance: z.string().max(64).nullable(),
      greenapi_token: z.string().max(256).nullable(),
      owner_notify_phone: z.string().max(20).nullable(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        greenapi_instance: data.greenapi_instance || null,
        greenapi_token: data.greenapi_token || null,
        owner_notify_phone: data.owner_notify_phone || null,
      },
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
