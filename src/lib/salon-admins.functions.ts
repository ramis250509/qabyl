import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function assertSuperAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: super_admin only");
}

function randomPassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const arr = new Uint32Array(14);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 14; i++) s += chars[arr[i] % chars.length];
  return s;
}

export const createSalonAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      salonId: z.string().uuid(),
      email: z.string().email().max(255),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);

    const password = randomPassword();

    // Try to create user; if exists, fetch existing
    let userId: string | null = null;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      // user may already exist — look up by paginating through all users
      let existing: { id: string; email?: string } | undefined;
      let page = 1;
      while (!existing) {
        const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        const users = list?.users ?? [];
        existing = users.find((u) => u.email?.toLowerCase() === data.email.toLowerCase());
        if (existing || users.length < 1000) break;
        page++;
      }
      if (!existing) throw new Error(createErr.message);
      userId = existing.id;
    } else {
      userId = created.user!.id;
    }

    // Insert role (ignore if already present)
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role: "salon_admin", salon_id: data.salonId });
    if (roleErr && !roleErr.message.includes("duplicate")) {
      throw new Error(roleErr.message);
    }

    return {
      userId,
      email: data.email,
      password: createErr ? null : password, // only return new password if user was just created
      alreadyExisted: !!createErr,
    };
  });

export const listSalonAdmins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { data: roles, error } = await supabaseAdmin
      .from("user_roles")
      .select("id, user_id, created_at")
      .eq("role", "salon_admin")
      .eq("salon_id", data.salonId);
    if (error) throw new Error(error.message);

    // Lookup emails — paginate to handle >1000 users on the platform
    const allUsers: { id: string; email?: string }[] = [];
    let page = 1;
    while (true) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      const users = list?.users ?? [];
      allUsers.push(...users);
      if (users.length < 1000) break;
      page++;
    }
    const byId = new Map(allUsers.map((u) => [u.id, u.email] as const));
    return (roles ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: byId.get(r.user_id) ?? "(неизвестно)",
      createdAt: r.created_at,
    }));
  });

export const revokeSalonAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ roleId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { error } = await supabaseAdmin.from("user_roles").delete().eq("id", data.roleId).eq("role", "salon_admin");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
