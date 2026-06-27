import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const WORDS = [
  "Aksakal", "Beauty", "Cosmos", "Delta", "Echo", "Falcon", "Galaxy", "Horizon",
  "Indigo", "Jade", "Kappa", "Lotus", "Marble", "Nova", "Orion", "Pearl",
  "Quartz", "River", "Sigma", "Tango", "Ultra", "Velvet", "Willow", "Xenon",
  "Yacht", "Zenith", "Atlas", "Breeze", "Coral", "Dune", "Ember", "Frost",
];

function memorablePassword() {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  const word = WORDS[arr[0] % WORDS.length];
  const num = 1000 + (arr[1] % 9000);
  return `${word}-${num}`;
}

// Caller must be super_admin OR salon_admin of this salon.
async function assertCanManageSalon(userId: string, salonId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles").select("role, salon_id").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const allowed = (roles ?? []).some(
    (r: any) =>
      r.role === "super_admin" ||
      (r.role === "salon_admin" && r.salon_id === salonId),
  );
  if (!allowed) throw new Error("Forbidden");
}

export const createSalonMaster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      salonId: z.string().uuid(),
      email: z.string().email().max(255),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await assertCanManageSalon(context.userId, data.salonId);

    const password = memorablePassword();

    let userId: string | null = null;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list?.users?.find((u) => u.email?.toLowerCase() === data.email.toLowerCase());
      if (!existing) throw new Error(createErr.message);
      userId = existing.id;
    } else {
      userId = created.user!.id;
    }

    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role: "master" as any, salon_id: data.salonId, branch_id: null });
    if (roleErr && !roleErr.message.includes("duplicate")) {
      throw new Error(roleErr.message);
    }

    return {
      userId,
      email: data.email,
      password: createErr ? null : password,
      alreadyExisted: !!createErr,
    };
  });

export const listSalonMasters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await assertCanManageSalon(context.userId, data.salonId);
    const { data: roles, error } = await supabaseAdmin
      .from("user_roles")
      .select("id, user_id, created_at")
      .eq("role", "master" as any)
      .eq("salon_id", data.salonId)
      .is("branch_id", null);
    if (error) throw new Error(error.message);

    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const byId = new Map((list?.users ?? []).map((u) => [u.id, u.email] as const));
    return (roles ?? []).map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      email: byId.get(r.user_id) ?? "(неизвестно)",
      createdAt: r.created_at,
    }));
  });

export const revokeSalonMaster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ roleId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error: getErr } = await supabaseAdmin
      .from("user_roles").select("salon_id, branch_id, role").eq("id", data.roleId).maybeSingle();
    if (getErr) throw new Error(getErr.message);
    if (!row?.salon_id || row.role !== "master" || row.branch_id) throw new Error("Роль не найдена");
    await assertCanManageSalon(context.userId, row.salon_id);
    const { error } = await supabaseAdmin
      .from("user_roles").delete().eq("id", data.roleId).eq("role", "master" as any);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
