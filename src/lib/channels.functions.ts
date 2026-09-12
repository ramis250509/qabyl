// Область действия канала: общий на сеть или закреплённый за точкой.
//
// Сама таблица salon_channels недоступна из браузера — в ней лежат токены, и политик на чтение у
// неё нет вовсе. Поэтому всё, что кабинету нужно знать и менять, проходит через эти две функции:
// они отдают наружу область действия и ни одного реквизита.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const kindEnum = z.enum(["whatsapp", "instagram"]);

async function assertAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Нет доступа к этому салону");
}

export const getChannelScopes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await (supabaseAdmin as any)
      .from("salon_channels")
      .select("kind, scope, branch_id, ai_enabled, external_id")
      .eq("salon_id", data.salonId);

    const byKind: Record<string, { scope: string; branchId: string | null; connected: boolean }> =
      {};
    for (const r of rows ?? []) {
      byKind[r.kind] = {
        scope: r.scope,
        branchId: r.branch_id ?? null,
        connected: Boolean(r.external_id),
      };
    }
    return byKind;
  });

/**
 * Задать область действия канала.
 *
 * Строка заводится заранее, ДО подключения: владелец сети решает «этот номер будет для точки на
 * Чуй» в тот момент, когда думает о точках, а не в середине подключения через окно Meta, где
 * думать уже некогда. Когда подключение завершится, сюда же ляжет external_id, и маршрутизация
 * начнёт работать сама.
 */
export const setChannelScope = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        kind: kindEnum,
        scope: z.enum(["salon", "branch"]),
        branchId: z.string().uuid().nullable().optional(),
      })
      .refine((v) => v.scope !== "branch" || !!v.branchId, {
        message: "Выберите точку",
        path: ["branchId"],
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Точка обязана принадлежать этому салону: иначе канал одного бизнеса указывал бы на филиал
    // другого, и переписки поехали бы между салонами.
    if (data.branchId) {
      const { data: br } = await (supabaseAdmin as any)
        .from("branches")
        .select("id")
        .eq("id", data.branchId)
        .eq("salon_id", data.salonId)
        .maybeSingle();
      if (!br) throw new Error("Такой точки нет в этом салоне");
    }

    const { data: existing } = await (supabaseAdmin as any)
      .from("salon_channels")
      .select("id")
      .eq("salon_id", data.salonId)
      .eq("kind", data.kind)
      .limit(1);

    const patch = {
      scope: data.scope,
      branch_id: data.scope === "branch" ? data.branchId : null,
      updated_at: new Date().toISOString(),
    };

    if (existing?.length) {
      const { error } = await (supabaseAdmin as any)
        .from("salon_channels")
        .update(patch)
        .eq("id", existing[0].id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await (supabaseAdmin as any).from("salon_channels").insert({
        salon_id: data.salonId,
        kind: data.kind,
        display_name: data.kind === "whatsapp" ? "WhatsApp" : "Instagram",
        ...patch,
      });
      if (error) throw new Error(error.message);
    }

    return { ok: true as const };
  });
