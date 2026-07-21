import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Called by cron every 15 min — sends WhatsApp reminders ~2 hours before each appointment.
// Source-agnostic: covers bookings made by the AI assistant, the public site widget and the
// admin calendar alike (any confirmed appointment with reminder_sent=false).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Authenticate internal caller (pg_cron via pg_net) with vault-stored secret.
    const { data: sec } = await supabase.rpc("internal_get_cron_secret");
    const expected = sec as string | null;
    const provided = req.headers.get("x-cron-secret");
    if (!expected || !provided || provided !== expected) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Which appointments are due for a reminder is decided in one place — get_due_reminders() —
    // using EACH salon's own configured lead time (salon_ai_assistant.reminder_lead_hours, default
    // 2h) against each appointment's starts_at, with a ±15-min band so the 15-min cron always
    // catches it and reminder_sent guarantees exactly one send. This keeps per-salon logic in the
    // DB and scales to any number of salons in a single query.
    const { data: appts, error: dueErr } = await supabase.rpc("get_due_reminders");
    if (dueErr) {
      console.error("send-reminders get_due_reminders failed", dueErr);
      return new Response(JSON.stringify({ error: "due lookup failed", details: dueErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const list = (appts ?? []) as { id: string }[];
    const results: any[] = [];
    for (const a of list) {
      try {
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-whatsapp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "x-cron-secret": expected,
          },
          body: JSON.stringify({ appointment_id: a.id, kind: "reminder" }),
        });
        results.push({ id: a.id, status: r.status });
      } catch (e: any) {
        results.push({ id: a.id, error: e.message });
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: list.length, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
