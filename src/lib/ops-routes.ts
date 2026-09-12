// Кто на что реагирует — правила шины событий. Без базы и сети.
//
// Агенты не пишут друг другу напрямую: один публикует событие, правила ниже превращают его в
// задачи для других. Так новый агент не требует правок в чужом коде, а всю цепочку видно в одном
// файле.
//
// MAX_HOPS обрывает пинг-понг: событие, рождённое из события третьего уровня, дальше не идёт. Без
// этого два агента, реагирующие друг на друга, за ночь съедают бюджет и заваливают Telegram.

export const MAX_HOPS = 3;

export type TaskSpec = { agent: string; title: string; detail?: Record<string, unknown> };
export type Fanout = { tasks: TaskSpec[]; stop?: "max_hops" | "unknown_type" };

const short = (v: unknown, n = 60) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

/**
 * Что делать с событием. Возвращает задачи и причину, если ничего не делаем; запись в базу и
 * исполнение — забота вызывающего.
 */
export function planEventFanout(
  type: string,
  payload: Record<string, unknown>,
  hops: number,
): Fanout {
  if (hops >= MAX_HOPS) return { tasks: [], stop: "max_hops" };

  switch (type) {
    // Мира запустила промо → продажник должен быть готов к потоку, Кэп — проверить результат.
    case "promo.approved":
      return {
        tasks: [
          {
            agent: "sales",
            title: `Промо «${short(payload.title)}»: подготовить ответы на входящие`,
            detail: { promo: payload.title ?? null, offer: payload.offer ?? null },
          },
          {
            agent: "chief",
            title: `Проверить результат промо «${short(payload.title)}» через неделю`,
            detail: { check_after_days: 7 },
          },
        ],
      };

    // Лид дошёл до квалификации (фаза Айдара) → владельцу нужен созвон.
    case "lead.qualified":
      return {
        tasks: [
          {
            agent: "chief",
            title: `Созвон с лидом ${short(payload.name) || short(payload.phone)}`,
            detail: { lead_id: payload.lead_id ?? null },
          },
        ],
      };

    // Инцидент Деби уже кладёт на доску сам, когда открывает, — второй задачи не создаём.
    // Событие остаётся в журнале: по нему видно историю, и на него сможет подписаться новый агент.
    case "incident.opened":
      return { tasks: [] };

    // Публикация контента уже стала задачами при одобрении — второй раз не плодим.
    case "content.approved":
      return { tasks: [] };

    default:
      return { tasks: [], stop: "unknown_type" };
  }
}
