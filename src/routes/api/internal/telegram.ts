// Inbound Telegram webhook for the internal ops-agents team — Cloudflare Worker route.
// URL: https://qabyl.com/api/internal/telegram
//
// SECURITY (defense in depth):
//   1) Telegram secret header (X-Telegram-Bot-Api-Secret-Token) must match env
//      TELEGRAM_WEBHOOK_SECRET — proves the request really came from Telegram.
//   2) Sender allowlist: only user ids in env TELEGRAM_OWNER_ID (comma list) are served.
//      Anyone else is silently ignored (200 ok, no reply — don't confirm the bot exists).
//   3) Kill-switch: /stopall & /resume always work; other agent commands are refused
//      while agents_enabled = false.
//
// BOOTSTRAP: if TELEGRAM_OWNER_ID is unset, the bot is in setup mode and replies to ANY
// sender with their numeric user id, so the founder can discover it and set the allowlist.
// Once the allowlist is configured, this bootstrap is off.
//
// Always returns 200 fast so Telegram doesn't retry.

import { createFileRoute } from "@tanstack/react-router";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  type TgUpdate,
} from "@/lib/ops-telegram.server";
import {
  agentsEnabled,
  setKillSwitch,
  audit,
  buildDailyDigest,
  fetchDigestSnapshot,
  formatDigest,
  errorReport,
  isAgentActive,
  listAgents,
  setAgentPaused,
} from "@/lib/ops-agents.server";
import { buildWeeklyPlan } from "@/lib/ops-marketer.server";
import { executeApproval, pendingApprovals, requestApproval } from "@/lib/ops-approvals.server";
import { closeTask, listOpenTasks } from "@/lib/ops-bus.server";

/** Владелец пишет «мира», а в базе ключ «marketer» — имена для людей, ключи для кода. */
const AGENT_ALIASES: Record<string, string> = {
  мира: "marketer",
  mira: "marketer",
  marketer: "marketer",
  айдар: "sales",
  aidar: "sales",
  sales: "sales",
  деби: "sre",
  debi: "sre",
  sre: "sre",
  кэп: "chief",
  kep: "chief",
  chief: "chief",
};

const AGENT_NAMES: Record<string, string> = {
  marketer: "📣 Мира",
  sales: "🤝 Айдар",
  sre: "🛠 Деби",
  chief: "🧭 Кэп",
  bus: "🔁 Шина",
};

function agentLabel(key: string): string {
  return AGENT_NAMES[key] ?? key;
}

/** Заголовки задач приходят из плана модели — в HTML-режиме их надо обезвредить. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const HELP = [
  "🤖 <b>Команда агентов Qabyl</b>",
  "",
  "<b>Сводки</b>",
  "/status — быстрая проверка здоровья бизнеса",
  "/digest — полная сводка Кэпа сейчас",
  "/errors — недавние ошибки (Деби)",
  "",
  "<b>Мира (маркетинг)</b>",
  "/mira — план контента на неделю с кнопкой одобрения",
  "",
  "<b>Доска и одобрения</b>",
  "/tasks — что в работе у агентов",
  "/done 12 — закрыть задачу №12",
  "/approvals — что ждёт твоего решения",
  "",
  "<b>Управление</b>",
  "/agents — кто включён",
  "/pause mira — остановить одного агента",
  "/unpause mira — включить обратно",
  "/stopall — аварийная остановка всех",
  "/resume — включить всех",
  "/whoami — показать мой Telegram id",
].join("\n");

function ok() {
  return new Response("ok", { status: 200 });
}

export const Route = createFileRoute("/api/internal/telegram")({
  server: {
    handlers: {
      GET: async () => new Response("ok", { status: 200 }),
      POST: async ({ request }) => {
        // 1) Telegram secret header
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
        const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!secret || provided !== secret) {
          return new Response("forbidden", { status: 403 });
        }

        let update: TgUpdate;
        try {
          update = (await request.json()) as TgUpdate;
        } catch {
          return ok();
        }

        try {
          await handleUpdate(update);
        } catch (e: any) {
          console.error("[ops-tg] handleUpdate threw:", e?.message ?? e);
          const { logError } = await import("@/lib/error-log.server");
          await logError({ source: "server-fn", message: `ops-tg: ${e?.message ?? e}`, error: e });
        }
        return ok();
      },
    },
  },
});

// ---------------------------------------------------------------------------

function ownerIds(): string[] {
  return (process.env.TELEGRAM_OWNER_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handleUpdate(update: TgUpdate): Promise<void> {
  // ---- Button taps (approval gate) --------------------------------------
  if (update.callback_query) {
    const cq = update.callback_query;
    const fromId = String(cq.from.id);
    if (!isAllowed(fromId)) {
      await answerCallbackQuery(cq.id);
      return;
    }
    await handleCallback(cq);
    return;
  }

  // ---- Text commands ----------------------------------------------------
  const msg = update.message;
  if (!msg || !msg.text) return;
  const fromId = String(msg.from?.id ?? "");
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id ?? null;
  const text = msg.text.trim();

  // BOOTSTRAP mode: no allowlist yet → help the founder find their id.
  if (ownerIds().length === 0) {
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text:
        `👋 Бот работает, но список владельцев пуст.\n\n` +
        `Твой Telegram id: <b>${fromId}</b>\nChat id: <b>${chatId}</b>\n\n` +
        `Добавь их в переменные окружения Cloudflare (TELEGRAM_OWNER_ID, TELEGRAM_CHAT_ID) и передеплой.`,
    });
    return;
  }

  if (!isAllowed(fromId)) return; // silent ignore for strangers

  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");

  // Kill-switch commands always work.
  if (cmd === "/stopall") {
    await setKillSwitch(false, "owner");
    await sendMessage({
      chatId,
      threadId,
      text: "🛑 Все агенты остановлены. /resume чтобы включить.",
    });
    return;
  }
  if (cmd === "/resume") {
    await setKillSwitch(true, "owner");
    await sendMessage({ chatId, threadId, text: "✅ Агенты снова включены." });
    return;
  }
  if (cmd === "/whoami") {
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text: `Твой id: <b>${fromId}</b>\nChat id: <b>${chatId}</b>${threadId ? `\nTopic id: <b>${threadId}</b>` : ""}`,
    });
    return;
  }
  if (cmd === "/help" || cmd === "/start") {
    await sendMessage({ chatId, threadId, parseMode: "HTML", text: HELP });
    return;
  }

  // Remaining commands respect the kill-switch.
  if (!(await agentsEnabled())) {
    await sendMessage({ chatId, threadId, text: "⏸ Агенты на паузе. /resume чтобы включить." });
    return;
  }

  if (cmd === "/status") {
    const snap = await fetchDigestSnapshot();
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text: snap
        ? formatDigest(snap, "сейчас")
        : "Не удалось получить сводку (проверь подключение к БД).",
    });
    await audit("owner", "cmd.status");
    return;
  }
  if (cmd === "/digest") {
    const text2 = await buildDailyDigest();
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text: text2 ?? "Не удалось собрать дайджест.",
    });
    return;
  }
  if (cmd === "/errors") {
    const report = await errorReport(24 * 60);
    await sendMessage({ chatId, threadId, parseMode: "HTML", text: report });
    await audit("owner", "cmd.errors");
    return;
  }

  // ---- Мира: план недели под одобрение ----------------------------------
  if (cmd === "/mira") {
    if (!(await isAgentActive("marketer"))) {
      await sendMessage({
        chatId,
        threadId,
        text: "⏸ Мира на паузе. Включить: /unpause marketer",
      });
      return;
    }
    await sendMessage({ chatId, threadId, text: "📣 Мира собирает план недели…" });
    const plan = await buildWeeklyPlan();
    const id = await requestApproval({
      agent: "marketer",
      kind: "content_plan",
      summary: plan.text,
      action: plan.action as any,
      chatId,
      threadId,
    });
    if (!id) {
      await sendMessage({ chatId, threadId, text: "Не удалось сохранить план. Ошибки: /errors" });
    }
    await audit("owner", "cmd.mira", { from_model: plan.fromModel });
    return;
  }

  // ---- Доска задач ------------------------------------------------------
  if (cmd === "/tasks") {
    const tasks = await listOpenTasks(12);
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text: tasks.length
        ? [
            "📋 <b>В работе</b>",
            "",
            ...tasks.map((t) => `#${t.id} · ${agentLabel(t.agent)} — ${escapeHtml(t.title)}`),
            "",
            "Закрыть: /done 12",
          ].join("\n")
        : "📋 Доска пустая — у агентов нет открытых задач.",
    });
    return;
  }

  if (cmd === "/done") {
    const id = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(id)) {
      await sendMessage({ chatId, threadId, text: "Укажи номер задачи: /done 12" });
      return;
    }
    const ok2 = await closeTask(id, "owner");
    await sendMessage({
      chatId,
      threadId,
      text: ok2 ? `✅ Задача #${id} закрыта.` : `Не нашёл задачу #${id}.`,
    });
    return;
  }

  if (cmd === "/approvals") {
    const list = await pendingApprovals(5);
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text: list.length
        ? [
            "⏳ <b>Ждут решения</b>",
            "",
            ...list.map((a) => `#${a.id} · ${agentLabel(a.agent)} · ${escapeHtml(a.kind)}`),
            "",
            "Кнопки — в сообщении, где агент это предложил.",
          ].join("\n")
        : "✅ Ничего не ждёт одобрения.",
    });
    return;
  }

  // ---- Управление агентами ---------------------------------------------
  if (cmd === "/agents") {
    const list = await listAgents();
    await sendMessage({
      chatId,
      threadId,
      parseMode: "HTML",
      text: [
        "👥 <b>Команда</b>",
        "",
        ...list.map(
          (a) =>
            `${a.paused || !a.enabled ? "⏸" : "🟢"} ${a.name} — ${escapeHtml(a.role_title)} <code>${a.key}</code>`,
        ),
        "",
        "Пауза: /pause sales · Включить: /unpause sales",
      ].join("\n"),
    });
    return;
  }

  if (cmd === "/pause" || cmd === "/unpause") {
    const raw = (text.split(/\s+/)[1] ?? "").toLowerCase();
    const key = AGENT_ALIASES[raw] ?? raw;
    if (!key) {
      await sendMessage({ chatId, threadId, text: "Кого? /pause mira, /pause sales, /pause sre" });
      return;
    }
    const okAgent = await setAgentPaused(key, cmd === "/pause", "owner");
    await sendMessage({
      chatId,
      threadId,
      text: okAgent
        ? `${cmd === "/pause" ? "⏸ Остановил" : "🟢 Включил"}: ${key}`
        : `Не знаю агента «${key}». Список: /agents`,
    });
    return;
  }

  await sendMessage({ chatId, threadId, text: "Не понял команду. /help — список." });
}

function isAllowed(userId: string): boolean {
  const ids = ownerIds();
  return ids.length === 0 ? false : ids.includes(userId);
}

// ---- Approval gate: a button tap flips ops_approvals, then executes --------
// Phase 1 creates no approvals, but the handler is live so phase-2 agents plug in.
async function handleCallback(cq: {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}): Promise<void> {
  const data = cq.data ?? "";
  const [verb, idStr] = data.split(":");
  const approvalId = Number(idStr);

  if ((verb !== "approve" && verb !== "reject") || !Number.isFinite(approvalId)) {
    await answerCallbackQuery(cq.id, "Неизвестное действие");
    return;
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const dbc = supabaseAdmin as any;
  const { data: appr } = await dbc
    .from("ops_approvals")
    .select("id, status, summary, agent, kind")
    .eq("id", approvalId)
    .maybeSingle();

  if (!appr) {
    await answerCallbackQuery(cq.id, "Запрос не найден");
    return;
  }
  if (appr.status !== "pending") {
    await answerCallbackQuery(cq.id, `Уже обработано: ${appr.status}`);
    return;
  }

  const decided = verb === "approve" ? "approved" : "rejected";
  await dbc
    .from("ops_approvals")
    .update({ status: decided, decided_at: new Date().toISOString() })
    .eq("id", approvalId);
  await audit(
    "owner",
    `approval.${decided}`,
    { agent: appr.agent, kind: appr.kind },
    {
      type: "approval",
      id: String(approvalId),
    },
  );

  // Одобренное исполняется сразу: действие лежит в ops_approvals.action, кнопка несла только id.
  let tail = decided === "approved" ? "✅ Одобрено" : "❌ Отклонено";
  if (decided === "approved") {
    const res = await executeApproval(approvalId);
    tail = res.ok ? `✅ Одобрено — ${res.note}` : `⚠️ Одобрено, но не выполнилось: ${res.note}`;
  }

  await answerCallbackQuery(cq.id, decided === "approved" ? "Одобрено ✅" : "Отклонено ❌");
  if (cq.message) {
    await editMessageText({
      chatId: cq.message.chat.id,
      messageId: cq.message.message_id,
      parseMode: "HTML",
      text: `${appr.summary}\n\n${tail}`,
    });
  }
}
