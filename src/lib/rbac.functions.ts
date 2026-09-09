// Employee management: invite / assign role / link master profile / revoke.
// Callable by super_admin OR salon_admin of the given salon. Every change is
// audited into public.rbac_audit for compliance.
//
// The invitation flow uses Supabase's built-in admin.inviteUserByEmail —
// no plain-text password ever leaves the server. If the user already exists
// (say, they are already a client of another salon), we skip the invite and
// just add the role.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AllowedRole = "salon_admin" | "manager" | "master";
const ROLE_LABELS: Record<AllowedRole, string> = {
  salon_admin: "Владелец / главный администратор",
  manager: "Администратор / регистратор",
  master: "Врач / мастер",
};

// Any of these can grant/revoke access for a given salon. Super admin always;
// salon_admin only within their own salon. Managers cannot promote themselves.
async function assertCanManageEmployees(userId: string, salonId: string) {
  const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role, salon_id")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const ok = (roles ?? []).some(
    (r: any) => r.role === "super_admin" || (r.role === "salon_admin" && r.salon_id === salonId),
  );
  if (!ok) throw new Error("Forbidden: owner or super_admin only");
}

async function audit(params: {
  salonId: string;
  actorId: string;
  action: string;
  subjectUser?: string | null;
  subjectMaster?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
  await supabaseAdmin.from("rbac_audit").insert({
    salon_id: params.salonId,
    actor_id: params.actorId,
    action: params.action,
    subject_user: params.subjectUser ?? null,
    subject_master: params.subjectMaster ?? null,
    before: params.before ?? null,
    after: params.after ?? null,
  });
}

// ─────────────────────────── invite / list / revoke ────────────────────────

export const inviteEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        email: z.string().email().max(255),
        role: z.enum(["salon_admin", "manager", "master"]),
        // For master role, the branch is required.
        branchId: z.string().uuid().nullable().optional(),
        // Optional: pre-link to an existing masters row (must belong to the salon).
        masterId: z.string().uuid().nullable().optional(),
      })
      .refine((v) => v.role !== "master" || !!v.branchId, {
        message: "branchId required for master role",
        path: ["branchId"],
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    // 1) Ensure the auth user exists — invite if new, look up if existing.
    let userId: string | null = null;
    let invited = false;
    const inviteResult = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email);
    if (inviteResult.error) {
      // "already registered" or similar — fall back to a lookup.
      let existing: { id: string; email?: string } | undefined;
      let page = 1;
      while (!existing) {
        const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        const users = list?.users ?? [];
        existing = users.find((u: { id: string; email?: string }) => u.email?.toLowerCase() === data.email.toLowerCase());
        if (existing || users.length < 1000) break;
        page += 1;
      }
      if (!existing) throw new Error(inviteResult.error.message);
      userId = existing.id;
    } else {
      userId = inviteResult.data.user!.id;
      invited = true;
    }

    // 2) Assign role (idempotent — dedup with 'duplicate' ignore).
    const rolePayload: any = {
      user_id: userId,
      role: data.role,
      salon_id: data.salonId,
    };
    if (data.role === "master") rolePayload.branch_id = data.branchId;
    const { error: roleErr } = await supabaseAdmin.from("user_roles").insert(rolePayload);
    if (roleErr && !roleErr.message.includes("duplicate")) throw new Error(roleErr.message);

    // 3) Optional master-profile link.
    if (data.masterId) {
      const { data: mrow, error: mErr } = await supabaseAdmin
        .from("masters")
        .select("id, salon_id, user_id")
        .eq("id", data.masterId)
        .maybeSingle();
      if (mErr) throw new Error(mErr.message);
      if (!mrow) throw new Error("Master not found");
      if ((mrow as any).salon_id !== data.salonId)
        throw new Error("Master belongs to a different salon");
      if ((mrow as any).user_id && (mrow as any).user_id !== userId) {
        throw new Error("Master profile is already linked to another user");
      }
      const { error: linkErr } = await supabaseAdmin
        .from("masters")
        .update({ user_id: userId })
        .eq("id", data.masterId);
      if (linkErr) throw new Error(linkErr.message);
    }

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: invited ? "invite" : "assign_role",
      subjectUser: userId,
      subjectMaster: data.masterId ?? null,
      after: { role: data.role, email: data.email, invited },
    });

    return { ok: true, userId, invited, roleLabel: ROLE_LABELS[data.role] };
  });

export const listSalonEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: roles, error } = await supabaseAdmin
      .from("user_roles")
      .select("id, user_id, role, branch_id, created_at")
      .eq("salon_id", data.salonId)
      .in("role", ["salon_admin", "manager", "master"]);
    if (error) throw new Error(error.message);

    // Batch-fetch masters (which one is linked to which user).
    const userIds = Array.from(new Set((roles ?? []).map((r: any) => r.user_id)));
    const { data: masters } = await supabaseAdmin
      .from("masters")
      .select("id, name, user_id, branch_id")
      .eq("salon_id", data.salonId)
      .in("user_id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);

    // Почта — точечно по каждому известному идентификатору, а не перебором всех пользователей.
    //
    // Здесь стоял listUsers по 1000 на страницу в цикле до конца списка. У салона из трёх
    // сотрудников это уже означало выгрузку ВСЕХ аккаунтов платформы на каждое открытие вкладки, и
    // стоимость росла с числом клиентов Qabyl, а не с размером салона. На сотне салонов такой
    // экран открывался бы секундами.
    const found = await Promise.all(
      userIds.map(async (id) => {
        const { data } = await supabaseAdmin.auth.admin.getUserById(id);
        return [id, data?.user?.email as string | undefined] as const;
      }),
    );
    const emailById = new Map(found);
    const masterByUserId = new Map((masters ?? []).map((m: any) => [m.user_id, m] as const));

    return (roles ?? []).map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      email: emailById.get(r.user_id) ?? "(неизвестно)",
      role: r.role as AllowedRole,
      roleLabel: ROLE_LABELS[r.role as AllowedRole] ?? r.role,
      branchId: r.branch_id ?? null,
      linkedMaster: masterByUserId.get(r.user_id) ?? null,
      createdAt: r.created_at,
    }));
  });

export const revokeEmployeeAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        userId: z.string().uuid(),
        // If true, also unlink from any masters row in this salon.
        unlinkMaster: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    if (data.userId === context.userId) {
      throw new Error("Нельзя отозвать доступ у самого себя");
    }
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: existing } = await supabaseAdmin
      .from("user_roles")
      .select("id, role")
      .eq("user_id", data.userId)
      .eq("salon_id", data.salonId)
      .in("role", ["salon_admin", "manager", "master"]);

    const { error: delErr } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.userId)
      .eq("salon_id", data.salonId)
      .in("role", ["salon_admin", "manager", "master"]);
    if (delErr) throw new Error(delErr.message);

    if (data.unlinkMaster) {
      await supabaseAdmin
        .from("masters")
        .update({ user_id: null })
        .eq("salon_id", data.salonId)
        .eq("user_id", data.userId);
    }

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "revoke",
      subjectUser: data.userId,
      before: { roles: existing ?? [] },
    });

    return { ok: true, removedCount: existing?.length ?? 0 };
  });

export const linkMasterToUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        masterId: z.string().uuid(),
        // Pass null to unlink.
        userId: z.string().uuid().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: mrow, error } = await supabaseAdmin
      .from("masters")
      .select("id, salon_id, user_id")
      .eq("id", data.masterId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!mrow) throw new Error("Master not found");
    if ((mrow as any).salon_id !== data.salonId)
      throw new Error("Master belongs to a different salon");

    if (data.userId) {
      // Reject double-linking: the target user must not already own a different master.
      const { data: other } = await supabaseAdmin
        .from("masters")
        .select("id")
        .eq("user_id", data.userId)
        .neq("id", data.masterId)
        .maybeSingle();
      if (other) throw new Error("Этот пользователь уже связан с другим профилем мастера");
    }

    const { error: updErr } = await supabaseAdmin
      .from("masters")
      .update({ user_id: data.userId })
      .eq("id", data.masterId);
    if (updErr) throw new Error(updErr.message);

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "link_master",
      subjectUser: data.userId ?? null,
      subjectMaster: data.masterId,
      before: { user_id: (mrow as any).user_id ?? null },
      after: { user_id: data.userId },
    });

    return { ok: true };
  });

// Staff isolation toggle for the salon. Only salon_admin / super_admin.
export const setStaffIsolation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: before } = await supabaseAdmin
      .from("salons")
      .select("staff_isolation")
      .eq("id", data.salonId)
      .maybeSingle();
    const { error } = await supabaseAdmin
      .from("salons")
      .update({ staff_isolation: data.enabled })
      .eq("id", data.salonId);
    if (error) throw new Error(error.message);
    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "toggle_isolation",
      before: { staff_isolation: (before as any)?.staff_isolation ?? false },
      after: { staff_isolation: data.enabled },
    });
    return { ok: true };
  });
