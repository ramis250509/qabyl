import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Reschedule an appointment from the admin calendar. Previously the calendar wrote
// `starts_at`/`ends_at`/`master_id` directly from the browser, which bypassed the atomic
// server-side validation in reschedule_appointment_v2 — two admins (or an admin and the WA
// agent) could drop bookings onto the same master/time and create a double-booking. Routing
// the move through this server function makes the write validated and atomic, and gives us a
// single place to notify the client over WhatsApp.

// Caller must be super_admin OR salon_admin of this salon. This mirrors the appointments
// UPDATE RLS policy (has_salon_access), so WHO can reschedule does not change — masters have
// no appointment-update policy and could not reschedule before either.
async function assertCanManageSalon(userId: string, salonId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role, salon_id")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const allowed = (roles ?? []).some(
    (r: any) =>
      r.role === "super_admin" || (r.role === "salon_admin" && r.salon_id === salonId),
  );
  if (!allowed) throw new Error("Forbidden");
}

// Translate the RPC's RAISE messages into friendly Russian for the calendar toast.
function mapRescheduleError(msg: string): string {
  const m = msg || "";
  if (m.includes("Time slot is no longer available")) return "Это время уже занято";
  if (m.includes("Cannot reschedule to the past")) return "Нельзя перенести на прошедшее время";
  if (m.includes("Only confirmed appointments")) return "Переносить можно только подтверждённые записи";
  if (m.includes("Master does not offer this service")) return "Этот мастер не оказывает данную услугу";
  if (m.includes("Master not found")) return "Мастер не найден";
  if (m.includes("Service not found")) return "Услуга не найдена";
  if (m.includes("Appointment not found")) return "Запись не найдена";
  // The break-overlap message is already raised in Russian ("У мастера установлен перерыв…").
  if (m.startsWith("У мастера")) return m;
  return m;
}

// Best-effort WhatsApp notification to the client. The reschedule ran under service_role, so
// the AFTER UPDATE trigger (dispatch_whatsapp_appointment_change) deliberately skipped it —
// auth.uid() is NULL there — to avoid double-messaging the WA agent's own changes. Since a
// calendar reschedule IS an admin action that the client should hear about, this function owns
// the notification instead, reusing the same send-whatsapp edge function (one templating place).
async function notifyClientReschedule(appointmentId: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: secret } = await supabaseAdmin.rpc("internal_get_cron_secret" as any);
    if (!secret) {
      console.warn("[reschedule] cron secret missing — skipping WhatsApp notify");
      return;
    }
    const base = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    if (!base) {
      console.warn("[reschedule] SUPABASE_URL missing — skipping WhatsApp notify");
      return;
    }
    // Send BOTH the function's own auth (x-cron-secret) AND a real bearer JWT (the service-role
    // key). The bearer makes this call pass the Edge gateway even if "Verify JWT" is ON for
    // send-whatsapp — so an accidental dashboard redeploy that re-enables it can't silently break
    // reschedule notifications (see supabase/config.toml for the full story).
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resp = await fetch(`${base}/functions/v1/send-whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": String(secret),
        ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
      },
      body: JSON.stringify({ appointment_id: appointmentId, kind: "reschedule" }),
    });
    if (!resp.ok) {
      console.error(`[reschedule] send-whatsapp returned ${resp.status}: ${await resp.text()}`);
    }
  } catch (e: any) {
    // A notification failure must never fail the reschedule itself.
    console.error("[reschedule] WhatsApp notify failed", e?.message ?? e);
  }
}

// History of one appointment, for the "кто это изменил" question in the calendar.
//
// Goes through a server function rather than a direct client query for one reason: the
// actor is stored as a bare auth.uid(), and turning it into a human-readable name needs
// the admin auth API, which must never reach the browser. Falls back to the raw id when
// the account has since been deleted.
export const getAppointmentHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ appointmentId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: appt } = await supabaseAdmin
      .from("appointments")
      .select("salon_id")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (!appt) return { entries: [] as AuditEntry[] };
    await assertCanManageSalon(context.userId, (appt as any).salon_id);

    const { data: rows, error } = await supabaseAdmin
      .from("appointment_audit" as any)
      .select("action, detail, actor_id, actor_kind, created_at")
      .eq("appointment_id", data.appointmentId)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);

    // One lookup per distinct actor, not per row: a busy appointment is mostly the same
    // person acting several times.
    const ids = [...new Set((rows ?? []).map((r: any) => r.actor_id).filter(Boolean))];
    const names = new Map<string, string>();
    for (const id of ids) {
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(id as string);
        const email = u?.user?.email;
        if (email) names.set(id as string, email);
      } catch {
        // Deleted account — leave it unresolved rather than failing the whole panel.
      }
    }

    return {
      entries: (rows ?? []).map((r: any) => ({
        action: r.action as AuditEntry["action"],
        detail: r.detail ?? {},
        at: r.created_at as string,
        // "Система" covers the AI assistant, the cron jobs and the edge functions —
        // everything that runs under the service role, where auth.uid() is NULL.
        actor:
          r.actor_kind === "system"
            ? "Система"
            : (names.get(r.actor_id) ?? "Администратор"),
      })) as AuditEntry[],
    };
  });

export type AuditEntry = {
  action:
    | "created"
    | "status_changed"
    | "rescheduled"
    | "master_changed"
    | "contact_changed"
    | "deleted";
  detail: Record<string, unknown>;
  at: string;
  actor: string;
};

export const rescheduleAppointment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        appointmentId: z.string().uuid(),
        newStartsAt: z.string().datetime(), // ISO 8601 (UTC) start time
        newMasterId: z.string().uuid().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Authorize against the appointment's REAL salon (never a client-supplied one).
    const { data: appt, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .select("id, salon_id, salons(whatsapp_enabled)")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (apptErr) throw new Error(apptErr.message);
    if (!appt) throw new Error("Запись не найдена");
    await assertCanManageSalon(context.userId, (appt as any).salon_id);

    // Atomic, validated reschedule: double-booking, master break, past-time and
    // "master offers this service" are all enforced inside the RPC.
    const { error: rpcErr } = await supabaseAdmin.rpc("reschedule_appointment_v2" as any, {
      _appointment_id: data.appointmentId,
      _new_starts_at: data.newStartsAt,
      _new_master_id: data.newMasterId ?? null,
    });
    if (rpcErr) {
      return { ok: false as const, error: mapRescheduleError(rpcErr.message) };
    }

    // Respect the salon's WhatsApp toggle, consistent with the confirmation/cancel triggers.
    if ((appt as any).salons?.whatsapp_enabled) {
      await notifyClientReschedule(data.appointmentId);
    }

    return { ok: true as const };
  });
