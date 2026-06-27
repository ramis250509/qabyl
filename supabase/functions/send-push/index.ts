// Sends Web Push messages to subscribers for a given notification.
// Invoked by a Postgres trigger via pg_net AFTER INSERT on public.notifications.
//
// Body: { notification_id: string }  OR  { salon_id, branch_id, title, body, url, tag }

// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import webpush from "https://esm.sh/web-push@3.6.7";

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function isValidVapidPublic(s: string): boolean {
  try {
    const b = b64urlDecode(s);
    return b.length === 65 && b[0] === 0x04;
  } catch { return false; }
}

const VAPID_PUBLIC_KEY = (Deno.env.get("VAPID_PUBLIC_KEY") ?? "").trim().replace(/\s+/g, "").replace(/^["']|["']$/g, "");
const VAPID_PRIVATE_KEY = (Deno.env.get("VAPID_PRIVATE_KEY") ?? "").trim().replace(/\s+/g, "").replace(/^["']|["']$/g, "");
const VAPID_SUBJECT = (Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@qabyl.com").trim();

const VAPID_OK = isValidVapidPublic(VAPID_PUBLIC_KEY) && !!VAPID_PRIVATE_KEY;
if (VAPID_OK) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.error("VAPID misconfigured", {
    pub_len: VAPID_PUBLIC_KEY.length,
    pub_prefix: VAPID_PUBLIC_KEY.slice(0, 6),
    priv_len: VAPID_PRIVATE_KEY.length,
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        vapidPublicKey: VAPID_PUBLIC_KEY,
        vapidPublicKeyLength: VAPID_PUBLIC_KEY.length,
        vapidReady: VAPID_OK,
      }),
      { headers: { ...cors, "content-type": "application/json" } },
    );
  }

  // Authenticate internal caller (DB trigger via pg_net) with vault-stored secret.
  // Prefer CRON_SECRET env (simple + reliable). Fallback to vault via RPC.
  try {
    const provided = req.headers.get("x-cron-secret");
    let expected = (Deno.env.get("CRON_SECRET") ?? "").trim();
    if (!expected) {
      const { data: sec, error: rpcErr } = await supabase.rpc("internal_get_cron_secret");
      if (rpcErr) console.error("cron secret rpc error", rpcErr.message);
      expected = (sec as unknown as string) ?? "";
    }
    if (!expected || !provided || provided !== expected) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "content-type": "application/json" } });
    }
  } catch (e) {
    console.error("auth check failed", e);
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "content-type": "application/json" } });
  }

  try {
    if (!VAPID_OK) {
      return new Response(JSON.stringify({ error: "vapid_not_configured", pub_len: VAPID_PUBLIC_KEY.length, priv_len: VAPID_PRIVATE_KEY.length }), { status: 503, headers: { ...cors, "content-type": "application/json" } });
    }
    const payload = await req.json().catch(() => ({}));
    let title: string = payload.title || "Qabyl";
    let body: string = payload.body || "";
    let salonId: string | null = payload.salon_id ?? null;
    let branchId: string | null = payload.branch_id ?? null;
    let url: string = payload.url || "/admin/notifications";
    let tag: string = payload.tag || `n-${Date.now()}`;

    if (payload.notification_id) {
      const { data: n } = await supabase
        .from("notifications")
        .select("id, salon_id, branch_id, title, body, type")
        .eq("id", payload.notification_id)
        .maybeSingle();
      if (n) {
        title = n.title ?? title;
        body = n.body ?? body;
        salonId = n.salon_id;
        branchId = n.branch_id;
        tag = n.id;
      }
    }

    // Compute recipient user_ids via user_roles — strict multi-tenant filter.
    // Rules:
    //   - super_admin: always receives
    //   - salon_admin: only if user_roles.salon_id = notification.salon_id
    //   - master: only if user_roles.salon_id = notification.salon_id
    //             AND (notification.branch_id IS NULL OR user_roles.branch_id IS NULL
    //                  OR user_roles.branch_id = notification.branch_id)
    // A subscription is NEVER selected by salon_id alone — role+salon must match.
    const recipientUserIds = new Set<string>();
    const superAdminIds = new Set<string>();
    let adminCount = 0;
    let masterCount = 0;

    const { data: supers, error: supErr } = await supabase
      .from("user_roles").select("user_id").eq("role", "super_admin");
    if (supErr) throw supErr;
    (supers ?? []).forEach((r: any) => {
      if (r.user_id) {
        recipientUserIds.add(r.user_id);
        superAdminIds.add(r.user_id);
      }
    });

    if (salonId) {
      const { data: admins, error: adminErr } = await supabase
        .from("user_roles").select("user_id")
        .eq("role", "salon_admin").eq("salon_id", salonId);
      if (adminErr) throw adminErr;
      (admins ?? []).forEach((r: any) => {
        if (r.user_id) {
          recipientUserIds.add(r.user_id);
          adminCount++;
        }
      });

      const { data: masters, error: mErr } = await supabase
        .from("user_roles").select("user_id, branch_id")
        .eq("role", "master").eq("salon_id", salonId);
      if (mErr) throw mErr;
      (masters ?? []).forEach((r: any) => {
        if (!r.user_id) return;
        if (!branchId || !r.branch_id || r.branch_id === branchId) {
          recipientUserIds.add(r.user_id);
          masterCount++;
        }
      });
    }

    if (recipientUserIds.size === 0) {
      return new Response(
        JSON.stringify({ sent: 0, failed: 0, removed: 0, reason: "no_recipients" }),
        { headers: { ...cors, "content-type": "application/json" } },
      );
    }

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, user_id, branch_id, salon_id")
      .in("user_id", Array.from(recipientUserIds));
    if (error) throw error;

    // Defense-in-depth: drop subscriptions whose stored scope doesn't match the
    // notification's salon/branch — except for super_admin, who receives all.
    const subsTotal = (subs ?? []).length;
    const filtered = (subs ?? []).filter((s: any) => {
      if (superAdminIds.has(s.user_id)) return true;
      if (salonId && s.salon_id && s.salon_id !== salonId) return false;
      if (branchId && s.branch_id && s.branch_id !== branchId) return false;
      return true;
    });

    console.log("send-push scope", {
      notification: { salon_id: salonId, branch_id: branchId },
      recipients_by_role: { super: superAdminIds.size, admin: adminCount, master: masterCount },
      subs_total: subsTotal,
      subs_after_scope_filter: filtered.length,
    });


    const msg = JSON.stringify({
      title: String(title || "Qabyl"),
      body: String(body || ""),
      url,
      tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      timestamp: Date.now(),
      data: {
        notification_id: payload.notification_id ?? null,
        salon_id: salonId,
        branch_id: branchId,
        type: payload.type ?? null,
      },
    });
    const results = await Promise.allSettled(
      filtered.map((s: any) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          msg,
          {
            TTL: 60 * 60 * 24, // 1 day
            urgency: "high",
            headers: { Urgency: "high" },
          },
        ),
      ),
    );

    // Cleanup dead subscriptions (404/410).
    const dead: string[] = [];
    const failures: Array<{ endpoint: string; code: number | null; reason: string }> = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const err: any = r.reason;
        const code = err?.statusCode;
        const reason = String(err?.body ?? err?.message ?? err).slice(0, 300);
        const endpoint = filtered[i].endpoint;
        console.log("push fail", endpoint.slice(0, 60), "code", code, "body", reason);
        failures.push({ endpoint: endpoint.slice(0, 80), code: code ?? null, reason });
        const isMobileEndpoint = endpoint.includes("web.push.apple.com") || endpoint.includes("notify.windows.com");
        const isStaleVapid = reason.includes("VapidPkHashMismatch") || reason.includes("BadJwtToken") || reason.includes("Unauthorized") || reason.includes("invalid token");
        const isRejectedMobileAuth = isMobileEndpoint && (code === 401 || (code === 400 && isStaleVapid));
        if (code === 404 || code === 410 || isRejectedMobileAuth) dead.push(endpoint);
      } else {
        console.log("push ok", filtered[i].endpoint.slice(0, 60));
      }
    });
    if (dead.length) {
      await supabase.from("push_subscriptions").delete().in("endpoint", dead);
    }

    return new Response(
      JSON.stringify({
        sent: results.filter((r) => r.status === "fulfilled").length,
        failed: results.filter((r) => r.status === "rejected").length,
        removed: dead.length,
        failure_reasons: failures.slice(0, 5),
      }),
      { headers: { ...cors, "content-type": "application/json" } },
    );
  } catch (e) {
    console.error("send-push error", e);
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
});
