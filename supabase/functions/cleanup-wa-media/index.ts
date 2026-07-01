import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Called by cron once a day — deletes WhatsApp client photos older than the retention
// window from the wa-media bucket. Photos are only needed briefly (price estimation,
// and the low-confidence escalation to a human admin); keeping them forever was an
// unbounded, unintentional storage cost with no product reason behind it.
const RETENTION_DAYS = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: sec } = await supabase.rpc("internal_get_cron_secret");
    const expected = sec as string | null;
    const provided = req.headers.get("x-cron-secret");
    if (!expected || !provided || provided !== expected) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();

    const { data: rows, error } = await supabase
      .from("wa_messages")
      .select("id, media_path")
      .eq("kind", "image")
      .not("media_path", "is", null)
      .lt("created_at", cutoff)
      .limit(500);
    if (error) throw error;

    const list = rows ?? [];
    if (list.length === 0) {
      return new Response(JSON.stringify({ ok: true, deleted: 0 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const paths = list.map((r: any) => r.media_path as string);
    const { error: removeErr } = await supabase.storage.from("wa-media").remove(paths);
    if (removeErr) throw removeErr;

    const { error: updateErr } = await supabase
      .from("wa_messages")
      .update({ media_path: null })
      .in("id", list.map((r: any) => r.id));
    if (updateErr) throw updateErr;

    return new Response(JSON.stringify({ ok: true, deleted: list.length }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
