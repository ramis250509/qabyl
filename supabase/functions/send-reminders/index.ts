import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Called by cron every 15 min — sends WhatsApp reminders for appointments 24h ahead
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

    const now = new Date();
    const from = new Date(now.getTime() + 23 * 3600 * 1000);
    const to = new Date(now.getTime() + 25 * 3600 * 1000);

    const { data: appts } = await supabase
      .from("appointments")
      .select("id")
      .eq("status", "confirmed")
      .eq("reminder_sent", false)
      .gte("starts_at", from.toISOString())
      .lte("starts_at", to.toISOString())
      .limit(100);

    const list = appts ?? [];
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
