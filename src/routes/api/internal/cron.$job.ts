// Cron-triggered ops endpoints — Cloudflare Worker route.
//   /api/internal/cron/digest    → Chief of Staff daily digest (Кэп)
//   /api/internal/cron/sre-scan  → SRE new-error scan (Деби)
//
// Called by pg_cron via net.http_post with header x-cron-secret (see migration
// 20260730120000). We compare it against env CRON_SECRET — set that to the same value
// stored in the Supabase vault as 'cron_secret'.
//
// Proactive messages go to env TELEGRAM_CHAT_ID; optional forum-topic ids
// TELEGRAM_TOPIC_CHIEF / TELEGRAM_TOPIC_SRE route each agent into its own topic.
// The kill-switch and per-agent pause are honoured here too.

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
        const secret = process.env.CRON_SECRET ?? "";
        const provided = request.headers.get("x-cron-secret") ?? "";
        if (!secret || provided !== secret) {
          return json({ error: "unauthorized" }, 401);
        }

        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) {
          console.error("[ops-cron] TELEGRAM_CHAT_ID not set — cannot deliver");
          return json({ skipped: true, reason: "no_chat_id" });
        }

        // Global kill-switch.
        if (!(await agentsEnabled())) {
          return json({ skipped: true, reason: "agents_disabled" });
        }

        const job = params.job;

        try {
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
