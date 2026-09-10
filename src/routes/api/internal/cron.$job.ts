// Cron-triggered endpoints — Cloudflare Worker route.
//   /api/internal/cron/digest              → Chief of Staff daily digest (Кэп)
//   /api/internal/cron/sre-scan            → SRE new-error scan (Деби)
//   /api/internal/cron/prepayment-expired  → tell the client their held slot was released
//   /api/internal/cron/wa-health           → проверка подключений WhatsApp у всех салонов
//
// Called by pg_cron via net.http_post with header x-cron-secret (see migrations
// 20260730120000 and 20260807130000).
//
// The secret is read from env CRON_SECRET when set, and otherwise from the
// Supabase vault entry 'cron_secret' that reminders, cleanup-wa-media and the
// reschedule trigger already use — so a new cron job works with no extra setup,
// and forgetting the env var cannot silently disable delivery.
//
// The ops agents deliver to Telegram (env TELEGRAM_CHAT_ID; optional forum-topic
// ids TELEGRAM_TOPIC_CHIEF / TELEGRAM_TOPIC_SRE) and honour the kill-switch.
// Those guards belong to those two jobs only — a job that has nothing to do with
// Telegram must not be skipped because no chat is configured.

import { createFileRoute } from "@tanstack/react-router";
import { sendMessage } from "@/lib/ops-telegram.server";
import {
  agentsEnabled,
  isAgentActive,
  buildDailyDigest,
  scanErrors,
  audit,
} from "@/lib/ops-agents.server";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function topicId(envName: string): number | null {
  const v = process.env[envName];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export const Route = createFileRoute("/api/internal/cron/$job")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const provided = request.headers.get("x-cron-secret") ?? "";
        if (!provided) return json({ error: "unauthorized" }, 401);

        let secret = (process.env.CRON_SECRET ?? "").trim();
        if (!secret) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: sec, error: rpcErr } = await (supabaseAdmin as any).rpc(
            "internal_get_cron_secret",
          );
          if (rpcErr) console.error("[cron] secret rpc error", rpcErr.message);
          secret = ((sec as string) ?? "").trim();
        }
        // An unset secret must never authorise anything.
        if (!secret || provided !== secret) {
          return json({ error: "unauthorized" }, 401);
        }

        const job = params.job;

        try {
          // Prepayment hold expiry — nothing to do with Telegram or the ops
          // agents, so it is dispatched before their guards.
          // One nudge to leads who went quiet, inside the platform messaging window. Nothing to
          // do with Telegram or the ops agents, so it is dispatched before their guards.
          if (job === "followups") {
            const { runFollowups } = await import("@/lib/followups.server");
            const report = await runFollowups();
            // Logged in full every run: a job whose whole purpose is "usually send nothing"
            // is indistinguishable from a broken one unless it says why it sent nothing.
            console.log(`[cron followups] ${JSON.stringify(report)}`);
            return json({ ok: true, ...report });
          }

          // Здоровье подключений WhatsApp. К Telegram и ops-агентам отношения не имеет, поэтому
          // стоит до их проверок: отсутствие настроенного чата не повод не проверять салоны.
          if (job === "wa-health") {
            const { runWaHealthCheck } = await import("@/lib/wa-connection.server");
            const report = await runWaHealthCheck();
            // Баланс кредитной линии YCloud — в той же ежечасной задаче: он один на все салоны, и
            // когда кончается, молчат все разом. Без YCLOUD_API_KEY проверка ничего не делает.
            const { checkYcloudBalance } = await import("@/lib/ycloud.server");
            const balance = await checkYcloudBalance();
            // Логируем каждый прогон целиком: задача, чей нормальный исход — «ничего не
            // произошло», неотличима от сломанной, пока не скажет, ЧТО именно она проверила.
            console.log(`[cron wa-health] ${JSON.stringify({ ...report, balance })}`);
            return json({ ok: true, ...report, balance });
          }

          if (job === "prepayment-expired") {
            const body = await request.json().catch(() => null);
            const appointmentId = String((body as any)?.appointment_id ?? "");
            if (!appointmentId) return json({ error: "missing_appointment_id" }, 400);
            const { notifyHoldExpired } = await import("@/lib/prepayment/expiry-notify.server");
            const res = await notifyHoldExpired(appointmentId);
            return json({ ok: true, ...res });
          }

          // ---- Ops agents (Кэп / Деби) ----
          const chatId = process.env.TELEGRAM_CHAT_ID;
          if (!chatId) {
            console.error("[ops-cron] TELEGRAM_CHAT_ID not set — cannot deliver");
            return json({ skipped: true, reason: "no_chat_id" });
          }
          // Global kill-switch.
          if (!(await agentsEnabled())) {
            return json({ skipped: true, reason: "agents_disabled" });
          }

          if (job === "digest") {
            if (!(await isAgentActive("chief")))
              return json({ skipped: true, reason: "chief_paused" });
            const text = await buildDailyDigest();
            if (!text) return json({ skipped: true, reason: "no_snapshot" });
            await sendMessage({
              chatId,
              threadId: topicId("TELEGRAM_TOPIC_CHIEF"),
              parseMode: "HTML",
              text,
            });
            await audit("cron", "digest.sent");
            return json({ ok: true });
          }

          if (job === "sre-scan") {
            if (!(await isAgentActive("sre"))) return json({ skipped: true, reason: "sre_paused" });
            const alert = await scanErrors(30);
            if (!alert) return json({ ok: true, new_errors: false });
            await sendMessage({
              chatId,
              threadId: topicId("TELEGRAM_TOPIC_SRE"),
              parseMode: "HTML",
              text: alert.text,
            });
            await audit("cron", "sre.sent");
            return json({ ok: true, new_errors: true });
          }

          return json({ error: "unknown_job", job }, 404);
        } catch (e: any) {
          console.error(`[ops-cron] job=${job} threw:`, e?.message ?? e);
          const { logError } = await import("@/lib/error-log.server");
          await logError({
            source: "cron",
            message: `ops-cron ${job}: ${e?.message ?? e}`,
            error: e,
          });
          return json({ error: "internal" }, 500);
        }
      },
    },
  },
});
