// Гейт одобрения: агент просит — владелец нажимает кнопку — сервер исполняет. ТОЛЬКО СЕРВЕР.
//
// ГЛАВНОЕ ПРАВИЛО: кнопка в Telegram несёт только id строки в ops_approvals. Само действие лежит в
// базе, на сервере. Подделать callback_data и заставить систему сделать что-то другое нельзя —
// максимум одобрить или отклонить то, что уже было предложено.
//
// Исполнители перечислены в EXECUTORS: тип действия → что произойдёт. Новое действие агента — это
// новая запись здесь, а не новый путь исполнения в обход гейта.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { audit } from "@/lib/ops-agents.server";
import { createTask, emitEvent, routeEvents } from "@/lib/ops-bus.server";
import { sendMessage } from "@/lib/ops-telegram.server";

const db = () => supabaseAdmin as any;

export type ApprovalAction = Record<string, unknown> & { type: string };

/** Просьба об одобрении: строка в базе + сообщение с кнопками. Возвращает id или null. */
export async function requestApproval(opts: {
  agent: string;
  kind: string;
  summary: string;
  action: ApprovalAction;
  chatId: string | number;
  threadId?: number | null;
}): Promise<number | null> {
  const { data, error } = await db()
    .from("ops_approvals")
    .insert({
      agent: opts.agent,
      kind: opts.kind,
      summary: opts.summary.slice(0, 3500),
      action: opts.action,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[ops-approval] insert: ${error.message}`);
    return null;
  }
  const id = Number(data.id);

  const messageId = await sendMessage({
    chatId: opts.chatId,
    threadId: opts.threadId ?? null,
    parseMode: "HTML",
    text: opts.summary,
    buttons: [
      [
        { text: "✅ Одобрить", callback_data: `approve:${id}` },
        { text: "❌ Отклонить", callback_data: `reject:${id}` },
      ],
    ],
  });

  if (messageId) {
    await db().from("ops_approvals").update({ tg_message_id: messageId }).eq("id", id);
  }
  await audit(
    opts.agent,
    "approval.requested",
    { kind: opts.kind, delivered: Boolean(messageId) },
    { type: "approval", id: String(id) },
  );
  return id;
}

type ExecResult = { ok: boolean; note: string };

const EXECUTORS: Record<string, (action: ApprovalAction) => Promise<ExecResult>> = {
  /** План Миры: каждый пост — задача на публикацию, промо — событие для остальных агентов. */
  content_plan: async (action) => {
    const posts = Array.isArray(action.posts) ? (action.posts as any[]) : [];
    let created = 0;
    for (const p of posts.slice(0, 5)) {
      const id = await createTask(
        "marketer",
        `Опубликовать (${String(p?.format ?? "пост")}): ${String(p?.hook ?? "").slice(0, 80)}`,
        {
          source: "content_plan",
          format: p?.format ?? "Пост",
          hook: p?.hook ?? "",
          caption: p?.caption ?? "",
          cta: p?.cta ?? "",
        },
        "approved",
      );
      if (id) created++;
    }
    const promo = action.promo as { title?: string; offer?: string } | null;
    if (promo?.title) {
      await emitEvent("promo.approved", "marketer", {
        title: promo.title,
        offer: promo.offer ?? null,
      });
    }
    await emitEvent("content.approved", "marketer", { posts: created });
    return {
      ok: true,
      note: `Задач на публикацию: ${created}${promo?.title ? ", промо передано Айдару" : ""}`,
    };
  },

  /**
   * Сообщение лиду от Айдара. Уходит с номера Qabyl, если он подключён; иначе владельцу приходит
   * текст и задача — отправить самому. Отказ Meta (вне 24-часового окна) передаётся словами.
   */
  sales_message: async (action) => {
    const leadId = Number(action.leadId ?? 0);
    const text = String(action.text ?? "");
    const phone = String(action.phone ?? "");
    if (!leadId || !text) return { ok: false, note: "нет текста или лида" };
    const { logLeadMessage, sendLeadMessage } = await import("@/lib/ops-sales.server");
    const res = phone
      ? await sendLeadMessage(phone, text)
      : { ok: false, note: "у лида нет номера" };
    await logLeadMessage(leadId, res.ok ? "agent" : "system", text);
    if (!res.ok) {
      await createTask("sales", `Отправить лиду #${leadId} вручную`, { text, phone }, "approved");
      return { ok: true, note: `${res.note} — текст сохранён, задача на доске` };
    }
    return { ok: true, note: res.note };
  },

  /** Лечение от Деби, которое требует разрешения владельца. */
  sre_fix: async (action) => {
    const key = String(action.key ?? "");
    const { executeRemedy } = await import("@/lib/ops-sre.server");
    return await executeRemedy(key);
  },

  /** Простая задача — агент просит поставить дело на доску. */
  task: async (action) => {
    const agent = String(action.agent ?? "chief");
    const title = String(action.title ?? "").slice(0, 200);
    if (!title) return { ok: false, note: "пустая задача" };
    const id = await createTask(agent, title, { source: "approval" }, "approved");
    return id ? { ok: true, note: "Задача на доске" } : { ok: false, note: "не удалось создать" };
  },
};

/**
 * Исполнить одобренное действие. Вызывается сразу после нажатия «Одобрить».
 *
 * Идемпотентно: исполняется только строка в статусе approved, дальше статус становится executed
 * или failed. Повторный колбэк (Telegram умеет повторять) второй раз ничего не сделает.
 */
export async function executeApproval(id: number): Promise<ExecResult> {
  const { data: appr } = await db()
    .from("ops_approvals")
    .select("id, status, action, agent, kind")
    .eq("id", id)
    .maybeSingle();
  if (!appr) return { ok: false, note: "запрос не найден" };
  if (appr.status !== "approved") return { ok: false, note: `статус ${appr.status}` };

  const action = (appr.action ?? {}) as ApprovalAction;
  const exec = EXECUTORS[String(action.type ?? "")];
  let res: ExecResult;
  if (!exec) {
    res = { ok: false, note: `неизвестное действие: ${action.type ?? "—"}` };
  } else {
    try {
      res = await exec(action);
    } catch (e: any) {
      res = { ok: false, note: `ошибка исполнения: ${e?.message ?? e}` };
    }
  }

  await db()
    .from("ops_approvals")
    .update({
      status: res.ok ? "executed" : "failed",
      executed_at: new Date().toISOString(),
      result: { note: res.note },
    })
    .eq("id", id);
  await audit(
    appr.agent,
    res.ok ? "approval.executed" : "approval.failed",
    { note: res.note },
    { type: "approval", id: String(id) },
  );

  // Событие, рождённое исполнением, тут же разбирается в задачи — иначе Айдар узнает о промо
  // только на следующем запуске крона.
  if (res.ok) await routeEvents();
  return res;
}

export async function pendingApprovals(
  limit = 5,
): Promise<{ id: number; agent: string; kind: string; summary: string; created_at: string }[]> {
  const { data } = await db()
    .from("ops_approvals")
    .select("id, agent, kind, summary, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as any[];
}
