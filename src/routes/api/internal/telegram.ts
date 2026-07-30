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
} from "@/lib/ops-agents.server";

const HELP = [
  "🤖 <b>Команда агентов Qabyl</b>",
  "",
  "/status — быстрая проверка здоровья бизнеса",
  "/digest — полная сводка Кэпа сейчас",
  "/errors — недавние ошибки (Деби)",
  "/stopall — аварийная остановка всех агентов",
  "/resume — включить агентов обратно",
  "/whoami — показать мой Telegram id",
  "/help — эта справка",
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

  // NOTE (phase 2): on 'approved' a worker reads ops_approvals.action and executes it,
  // then sets status='executed'. Phase 1 has no executable actions yet.

  await answerCallbackQuery(cq.id, decided === "approved" ? "Одобрено ✅" : "Отклонено ❌");
  if (cq.message) {
    await editMessageText({
      chatId: cq.message.chat.id,
      messageId: cq.message.message_id,
      text: `${appr.summary}\n\n${decided === "approved" ? "✅ Одобрено" : "❌ Отклонено"}`,
    });
  }
}
