// Шина событий и доска задач ops-агентов — ТОЛЬКО СЕРВЕР.
//
// ЗАЧЕМ. Владелец хотел, чтобы агенты знали друг о друге: Мира запускает промо — Айдар готов к
// потоку. Прямые вызовы между агентами дали бы клубок, где падение одного роняет другого и никто
// не помнит, кто кого разбудил. Поэтому один публикует событие в ops_events, другой читает на своём
// запуске, а правила связи лежат в одном месте — ops-routes.ts.
//
// ЗАЩИТА ОТ ЦИКЛОВ: hops растёт от события к событию, planEventFanout обрывает цепочку на MAX_HOPS.
// Обработанное событие помечается handled_at, поэтому повторный запуск шины не плодит задачи заново.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { audit } from "@/lib/ops-agents.server";
import { planEventFanout, type TaskSpec } from "@/lib/ops-routes";

const db = () => supabaseAdmin as any; // таблицы ops_* ещё не в сгенерированных типах

export async function emitEvent(
  type: string,
  sourceAgent: string,
  payload: Record<string, unknown> = {},
  hops = 0,
): Promise<void> {
  const { error } = await db().from("ops_events").insert({
    type,
    source_agent: sourceAgent,
    payload,
    hops,
  });
  if (error) console.error(`[ops-bus] emit ${type}: ${error.message}`);
}

export async function createTask(
  agent: string,
  title: string,
  detail?: Record<string, unknown>,
  status: "proposed" | "approved" | "in_progress" = "proposed",
): Promise<number | null> {
  const { data, error } = await db()
    .from("ops_tasks")
    .insert({ agent, title, status, detail: detail ?? null })
    .select("id")
    .single();
  if (error) {
    console.error(`[ops-bus] task "${title}": ${error.message}`);
    return null;
  }
  return Number(data.id);
}

export type OpsTask = {
  id: number;
  agent: string;
  title: string;
  status: string;
  created_at: string;
};

export async function listOpenTasks(limit = 12): Promise<OpsTask[]> {
  const { data } = await db()
    .from("ops_tasks")
    .select("id, agent, title, status, created_at")
    .in("status", ["proposed", "awaiting_approval", "approved", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as OpsTask[];
}

export async function closeTask(id: number, by: string): Promise<boolean> {
  const { error } = await db()
    .from("ops_tasks")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return false;
  await audit(by, "task.done", {}, { type: "task", id: String(id) });
  return true;
}

/**
 * Разобрать необработанные события. Возвращает, сколько прочитано и сколько задач создано —
 * задача, чей обычный исход «ничего не произошло», обязана говорить, что именно она проверила.
 */
export async function routeEvents(limit = 25): Promise<{
  handled: number;
  tasksCreated: number;
  stopped: number;
}> {
  const { data: events, error } = await db()
    .from("ops_events")
    .select("id, type, payload, hops, source_agent")
    .is("handled_at", null)
    .order("at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error(`[ops-bus] read events: ${error.message}`);
    return { handled: 0, tasksCreated: 0, stopped: 0 };
  }

  let tasksCreated = 0;
  let stopped = 0;
  for (const ev of events ?? []) {
    const fanout = planEventFanout(
      ev.type,
      (ev.payload ?? {}) as Record<string, unknown>,
      ev.hops ?? 0,
    );
    for (const t of fanout.tasks as TaskSpec[]) {
      const id = await createTask(t.agent, t.title, {
        ...(t.detail ?? {}),
        from_event: ev.type,
        from_agent: ev.source_agent ?? null,
      });
      if (id) tasksCreated++;
    }
    if (fanout.stop) stopped++;
    await db().from("ops_events").update({ handled_at: new Date().toISOString() }).eq("id", ev.id);
    if (fanout.tasks.length > 0 || fanout.stop === "max_hops") {
      await audit("bus", "bus.routed", {
        type: ev.type,
        tasks: fanout.tasks.length,
        stop: fanout.stop ?? null,
      });
    }
  }

  return { handled: (events ?? []).length, tasksCreated, stopped };
}
