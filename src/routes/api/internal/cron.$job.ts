// Cron-triggered endpoints — Cloudflare Worker route.
//   /api/internal/cron/digest              → Chief of Staff daily digest (Кэп)
//   /api/internal/cron/sre-scan            → SRE new-error scan (Деби)
//   /api/internal/cron/prepayment-expired  → tell the client their held slot was released
//   /api/internal/cron/wa-health           → проверка подключений WhatsApp у всех салонов
//   /api/internal/cron/wa-reconcile        → перезапуск входящих, оставшихся без обработки
//   /api/internal/cron/billing             → цикл биллинга: продление, отсрочка, блокировка
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
          // Цикл биллинга: конец пробного периода, продление, повторы списаний, отсрочка,
          // блокировка, предупреждения. К Telegram и ops-агентам отношения не имеет.
          if (job === "billing") {
            const { runBillingCycle } = await import("@/lib/billing.server");
            const report = await runBillingCycle();
            console.log(`[cron billing] ${JSON.stringify(report)}`);
            return json({ ok: true, ...report });
          }

          // Перезапуск потерянных сообщений: вебхук Meta приходит один раз, и если тот запрос
          // упал, клиент остался бы без ответа навсегда. К Telegram и ops-агентам отношения не
          // имеет — поэтому до их проверок.
          if (job === "wa-reconcile") {
            const { runWaReconcile } = await import("@/lib/wa-reconcile.server");
            const report = await runWaReconcile();
            if (report.stuckMessages > 0 || report.errors.length > 0) {
              console.log(`[cron wa-reconcile] ${JSON.stringify(report)}`);
            }
            return json({ ok: true, ...report });
          }

          // Диагностика Gemini: какой ключ реально подставлен и отвечает ли модель. Ключ наружу
          // не отдаётся — только его источник, код ответа, время и начало текста ошибки.
          if (job === "gemini-ping") {
            const fromNew = (process.env.Gemini_API_Key ?? "").trim();
            const fromOld = (process.env.GEMINI_API_KEY ?? "").trim();
            const key = fromNew || fromOld;
            const keySource = fromNew ? "Gemini_API_Key" : fromOld ? "GEMINI_API_KEY" : "none";
            if (!key) return json({ ok: false, keySource });
            const t0 = Date.now();
            try {
              const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: "Ответь одним словом: да" }] }],
                    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
                  }),
                  signal: AbortSignal.timeout(30_000),
                },
              );
              const body = await res.text();
              return json({
                ok: res.ok,
                keySource,
                keyTail: key.slice(-4),
                status: res.status,
                ms: Date.now() - t0,
                body: body.slice(0, 400),
              });
            } catch (e: any) {
              return json({
                ok: false,
                keySource,
                keyTail: key.slice(-4),
                ms: Date.now() - t0,
                error: e?.message ?? String(e),
              });
            }
          }

          // Продление токенов Instagram, полученных кнопкой: живут 60 дней.
          if (job === "ig-token-refresh") {
            const { runIgTokenRefresh } = await import("@/lib/ig-oauth.server");
            const report = await runIgTokenRefresh();
            console.log(`[cron ig-token-refresh] ${JSON.stringify(report)}`);
            return json({ ok: true, ...report });
          }

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

            // Понедельник — Мира приносит план недели кнопкой одобрения. В остальные дни молчит:
            // ежедневный контент-план перестают читать на третий день.
            const weekday = new Date().toLocaleDateString("en-US", {
              weekday: "short",
              timeZone: "Asia/Bishkek",
            });
            let marketer: string | null = null;
            if (weekday === "Mon" && (await isAgentActive("marketer"))) {
              const { buildWeeklyPlan } = await import("@/lib/ops-marketer.server");
              const { requestApproval } = await import("@/lib/ops-approvals.server");
              const plan = await buildWeeklyPlan();
              const id = await requestApproval({
                agent: "marketer",
                kind: "content_plan",
                summary: plan.text,
                action: plan.action as any,
                chatId,
                threadId: topicId("TELEGRAM_TOPIC_MARKETER") ?? topicId("TELEGRAM_TOPIC_CHIEF"),
              });
              marketer = id ? `plan_${id}` : "plan_failed";
            }

            // Лиды, к которым пора вернуться: продажи умирают от молчания, а не от отказов.
            const { dueLeads } = await import("@/lib/ops-sales.server");
            const due = await dueLeads();
            if (due.length > 0) {
              await sendMessage({
                chatId,
                threadId: topicId("TELEGRAM_TOPIC_CHIEF"),
                text: `⏰ Лидов ждут касания: ${due.length}. Список: /leads`,
              });
            }

            // Разобрать события, накопившиеся за сутки: задачи из них появляются на доске.
            const { routeEvents } = await import("@/lib/ops-bus.server");
            const bus = await routeEvents();
            return json({ ok: true, marketer, bus });
          }

          if (job === "sre-scan") {
            if (!(await isAgentActive("sre"))) return json({ skipped: true, reason: "sre_paused" });
            const threadSre = topicId("TELEGRAM_TOPIC_SRE");
            const alert = await scanErrors(30);
            if (alert) {
              await sendMessage({
                chatId,
                threadId: threadSre,
                parseMode: "HTML",
                text: alert.text,
              });
              await audit("cron", "sre.sent");
            }

            // Деби не только сообщает, но и лечит то, что лечится без человека: зависшие замки
            // обработки, неразобранные события, просроченные попытки списания. Молчит, когда чисто,
            // — иначе раз в 15 минут приходило бы «всё хорошо», и важное перестали бы читать.
            const { runSelfHealing } = await import("@/lib/ops-sre.server");
            const healing = await runSelfHealing({
              chatId,
              threadId: threadSre,
              quiet: true,
            });
            if (healing.text && (healing.fixed > 0 || healing.incidents > 0)) {
              await sendMessage({
                chatId,
                threadId: threadSre,
                parseMode: "HTML",
                text: healing.text,
              });
            }
            return json({
              ok: true,
              new_errors: Boolean(alert),
              findings: healing.findings,
              fixed: healing.fixed,
              incidents: healing.incidents,
            });
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
