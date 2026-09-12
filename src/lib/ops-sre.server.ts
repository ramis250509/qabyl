// Деби (Dev/SRE) — ТОЛЬКО СЕРВЕР. Находит проблемы и лечит те, что можно лечить без человека.
//
// ГРАНИЦА ПОЛНОМОЧИЙ. Деби не деплоит, не меняет код, не удаляет данные и не пишет клиентам
// салонов. Его лечение — это возврат СОСТОЯНИЯ в норму: разобрать очередь событий шины,
// прогнать цикл оплаты вне расписания. Каждое такое действие идемпотентно и
// проверяемо: после него тот же признак пересчитывается заново, и в отчёт идёт факт, а не надежда.
//
// Всё, что лечится только правкой кода (задача расписания не укладывается во время) или руками
// владельца салона (истёк доступ к WhatsApp), становится инцидентом с диагнозом и задачей на
// доске. Агент, делающий вид, что починил, опаснее агента, который молчит.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { audit, kvGet, kvSet } from "@/lib/ops-agents.server";
import { createTask, emitEvent, routeEvents } from "@/lib/ops-bus.server";
import { diagnose, formatHealingReport, type Finding, type Signals } from "@/lib/ops-sre-playbooks";

const db = () => supabaseAdmin as any;
/** Пятнадцать минут: дольше этого необработанное сообщение клиента — уже не задержка, а поломка. */
const STUCK_INBOUND_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Сбор признаков
// ---------------------------------------------------------------------------

async function countRows(table: string, build: (q: any) => any): Promise<number> {
  const { count, error } = await build(
    db().from(table).select("id", { count: "exact", head: true }),
  );
  if (error) {
    console.error(`[ops-sre] count ${table}: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

/** Имя задачи из строки лога «ops-cron followups: Gateway Timeout». */
function cronJobFromMessage(message: string): string | null {
  const m = /ops-cron\s+([a-z0-9-]+)\s*:/i.exec(message);
  return m ? m[1] : null;
}

export async function collectSignals(): Promise<Signals> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const stuckCutoff = new Date(Date.now() - STUCK_INBOUND_MS).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();

  const [{ data: errors }, stuckInbound, unhandledEvents, pendingInvoicesDue, { data: groups }] =
    await Promise.all([
      db().from("error_logs").select("message").gte("ts", dayAgo).limit(2000),
      // Необработанные входящие: замок обработки сюда не входит — он истекает сам, и следующая
      // попытка его игнорирует, так что «зависший замок» ничего не означает.
      countRows("wa_messages", (q: any) =>
        q
          .eq("direction", "in")
          .is("processed_at", null)
          .lt("created_at", stuckCutoff)
          .gte("created_at", twoDaysAgo),
      ),
      countRows("ops_events", (q: any) => q.is("handled_at", null).lt("at", hourAgo)),
      countRows("billing_invoices", (q: any) =>
        q.eq("status", "pending").lte("next_attempt_at", new Date().toISOString()),
      ),
      db().rpc("ops_recent_errors", { _since: dayAgo }),
    ]);

  const messages = ((errors ?? []) as any[]).map((e) => String(e.message ?? ""));
  const timeouts = new Map<string, number>();
  for (const m of messages) {
    if (!/timeout|timed out|504|524/i.test(m)) continue;
    const job = cronJobFromMessage(m);
    if (job) timeouts.set(job, (timeouts.get(job) ?? 0) + 1);
  }

  const top = ((groups ?? []) as any[]).sort((a, b) => (b.cnt ?? 0) - (a.cnt ?? 0))[0];

  return {
    cronTimeouts: [...timeouts.entries()].map(([job, count]) => ({ job, count })),
    stuckInbound,
    unhandledEvents,
    pendingInvoicesDue,
    waTokenErrors: messages.filter((m) => /code=190|OAuthException/i.test(m)).length,
    templateErrors: messages.filter((m) => /code=132\d\d\d/.test(m)).length,
    errorSpike: top
      ? {
          fingerprint: String(top.fingerprint ?? "—"),
          count: Number(top.cnt ?? 0),
          sample: String(top.sample_message ?? ""),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Лечение
// ---------------------------------------------------------------------------

type RemedyResult = { ok: boolean; note: string };

const REMEDIES: Record<string, () => Promise<RemedyResult>> = {
  /** Разобрать очередь событий — задачи агентов появятся на доске. */
  route_events: async () => {
    const res = await routeEvents(50);
    return {
      ok: true,
      note: `разобрано событий: ${res.handled}, задач создано: ${res.tasksCreated}`,
    };
  },

  /** Прогнать цикл оплаты вне расписания. Идемпотентен по устройству. */
  rerun_billing: async () => {
    const { runBillingCycle } = await import("@/lib/billing.server");
    const r = await runBillingCycle();
    return {
      ok: true,
      note: `оплата: проверено ${r.checked}, списано ${r.charged}, повторов ${r.retried}`,
    };
  },
};

export async function executeRemedy(key: string): Promise<RemedyResult> {
  const remedy = REMEDIES[key];
  if (!remedy) return { ok: false, note: `неизвестное лечение: ${key}` };
  try {
    const res = await remedy();
    await audit("sre", res.ok ? "sre.fixed" : "sre.fix_failed", { key, note: res.note });
    return res;
  } catch (e: any) {
    const note = `ошибка лечения: ${e?.message ?? e}`;
    await audit("sre", "sre.fix_failed", { key, note });
    return { ok: false, note };
  }
}

/** Инцидент заводится один раз в сутки на ключ — иначе доска превращается в поток дублей. */
async function openIncidentOnce(f: Finding): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const kvKey = `incident:${f.key}`;
  const seen = (await kvGet(kvKey)) as { date?: string } | null;
  if (seen?.date === today) return false;
  await kvSet(kvKey, { date: today });
  await createTask("sre", f.title, { detail: f.detail, key: f.key });
  await emitEvent("incident.opened", "sre", { summary: f.title, fingerprint: f.key });
  await audit("sre", "incident.opened", { key: f.key });
  return true;
}

/**
 * Полный проход: посмотреть, полечить, проверить, доложить.
 *
 * Возвращает текст для Telegram (null — если докладывать нечего) и числа для лога крона.
 * Проверка после лечения — не формальность: «снял замки» и «замков больше нет» это разные
 * утверждения, а владельцу нужно второе.
 */
export async function runSelfHealing(opts: {
  chatId?: string | number | null;
  threadId?: number | null;
  quiet?: boolean;
}): Promise<{ text: string | null; findings: number; fixed: number; incidents: number }> {
  const signals = await collectSignals();
  const findings = diagnose(signals);
  if (findings.length === 0) {
    return {
      text: opts.quiet ? null : formatHealingReport([], []),
      findings: 0,
      fixed: 0,
      incidents: 0,
    };
  }

  const results: { key: string; ok: boolean; note: string }[] = [];
  let incidents = 0;

  for (const f of findings) {
    if (f.remedy === "auto") {
      results.push({ key: f.key, ...(await executeRemedy(f.key)) });
    } else if (f.remedy === "approval" && opts.chatId) {
      const { requestApproval } = await import("@/lib/ops-approvals.server");
      const id = await requestApproval({
        agent: "sre",
        kind: "sre_fix",
        summary: `🛠 <b>${f.title}</b>\n${f.detail}\n\nПочинить?`,
        action: (f.action as any) ?? { type: "sre_fix", key: f.key },
        chatId: opts.chatId,
        threadId: opts.threadId ?? null,
      });
      results.push({
        key: f.key,
        ok: Boolean(id),
        note: id ? "спросил разрешения кнопкой" : "не удалось спросить",
      });
    } else {
      const opened = await openIncidentOnce(f);
      results.push({
        key: f.key,
        ok: false,
        note: opened ? "инцидент открыт, задача на доске" : "инцидент уже открыт сегодня",
      });
      if (opened) incidents++;
    }
  }

  // Проверка: пересчитываем признаки и говорим, что осталось. Без этого «починил» — это вера.
  const after = diagnose(await collectSignals());
  const leftAuto = after.filter((f) => f.remedy === "auto").length;
  const text =
    formatHealingReport(findings, results) +
    (leftAuto > 0
      ? `\n\n⚠️ После лечения осталось признаков состояния: ${leftAuto} — смотрю на следующем проходе.`
      : "\n\n✅ Проверил после лечения: состояние чистое.");

  await audit("sre", "sre.healing_run", {
    findings: findings.length,
    fixed: results.filter((r) => r.ok).length,
    incidents,
  });

  return {
    text,
    findings: findings.length,
    fixed: results.filter((r) => r.ok).length,
    incidents,
  };
}

/** Только диагноз, без лечения — для команды /health. */
export async function healthReport(): Promise<string> {
  const findings = diagnose(await collectSignals());
  if (findings.length === 0) return "🛠 Деби: всё чисто.";
  return [
    "🛠 <b>Деби: что вижу</b>",
    "",
    ...findings.map(
      (f) =>
        `${f.remedy === "auto" ? "🔧" : f.remedy === "approval" ? "⏳" : "📌"} <b>${f.title}</b>\n${f.detail}`,
    ),
    "",
    "Починить сейчас: /fix",
  ].join("\n");
}
