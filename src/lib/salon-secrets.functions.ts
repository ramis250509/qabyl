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
      .select("owner_notify_phone")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      owner_notify_phone: row?.owner_notify_phone ?? "",
    };
  });

export const upsertSalonSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      salonId: z.string().uuid(),
      owner_notify_phone: z.string().max(20).nullable(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        owner_notify_phone: data.owner_notify_phone || null,
      },
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
