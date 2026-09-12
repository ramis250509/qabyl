// Айдар (Sales) без базы и сети: разбор команд владельца, воронка, тексты, следующее касание.
//
// ЗАЧЕМ ОТДЕЛЬНО. Всё, что решает судьбу лида — на какой он стадии, когда к нему вернуться, что
// ему написать — должно читаться и проверяться без Telegram и без базы. Плюс здесь живёт разбор
// того, что владелец печатает одной строкой на телефоне: «/lead 0700112233 Нурзат Lashes» — с
// пробелами как получится, номер в любом формате.
//
// КАНАЛ. Первое сообщение холодному лиду в WhatsApp нельзя отправить свободным текстом — Meta
// пускает вне 24-часового окна только одобренный шаблон. Поэтому Айдар ГОТОВИТ текст, а отправка
// либо идёт по шаблону с нашего номера, либо владелец отправляет вручную. Черновик — не отправка.

export type LeadStage = "new" | "qualifying" | "meeting_set" | "won" | "lost";

export const LEAD_STAGES: LeadStage[] = ["new", "qualifying", "meeting_set", "won", "lost"];

const STAGE_LABEL: Record<LeadStage, string> = {
  new: "🆕 новый",
  qualifying: "🔎 выясняем",
  meeting_set: "📅 встреча назначена",
  won: "✅ подключился",
  lost: "❌ отказ",
};

/** Владелец пишет по-русски и как получится — принимаем и ключ, и слово. */
const STAGE_ALIASES: Record<string, LeadStage> = {
  new: "new",
  новый: "new",
  qualifying: "qualifying",
  выясняем: "qualifying",
  квалификация: "qualifying",
  meeting_set: "meeting_set",
  meeting: "meeting_set",
  встреча: "meeting_set",
  won: "won",
  наш: "won",
  подключился: "won",
  lost: "lost",
  отказ: "lost",
  слив: "lost",
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage as LeadStage] ?? stage;
}

export function parseStage(raw: string): LeadStage | null {
  return (
    STAGE_ALIASES[
      String(raw ?? "")
        .trim()
        .toLowerCase()
    ] ?? null
  );
}

/**
 * Номер к цифрам. Кыргызский номер владелец пишет как 0700112233 — приводим к 996700112233,
 * иначе один и тот же лид заведётся дважды.
 */
export function normalizeLeadPhone(raw: string): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 9 && !d.startsWith("0")) d = `996${d}`;
  else if (d.length === 10 && d.startsWith("0")) d = `996${d.slice(1)}`;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

export type ParsedLead = { phone: string; name: string | null; company: string | null };

/**
 * «/lead 0700112233 Нурзат Lashes Nurzhan» → номер, имя, салон.
 * Первое слово с цифрами — телефон, следующее слово — имя, остальное — название салона.
 */
export function parseLeadCommand(text: string): ParsedLead | null {
  const parts = String(text ?? "")
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const phone = normalizeLeadPhone(parts[0]);
  if (!phone) return null;
  const name = parts[1] ?? null;
  const company = parts.length > 2 ? parts.slice(2).join(" ").slice(0, 80) : null;
  return { phone, name: name ? name.slice(0, 40) : null, company };
}

/** Вопросы квалификации — то, что Айдар должен выяснить, прежде чем звать владельца на созвон. */
export const QUALIFY_QUESTIONS = [
  "Сколько мастеров принимает сейчас?",
  "Где клиенты записываются: в переписке, по звонку или как-то ещё?",
  "Сколько заявок в неделю остаётся без ответа?",
  "Кто отвечает клиентам вечером и в выходной?",
];

export type Lead = {
  id: number;
  name: string | null;
  phone: string | null;
  company: string | null;
  industry: string | null;
  stage: string;
  needs: string | null;
  objections: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Когда вернуться к лиду. Молчание — самая частая причина потерять салон, который был «почти
 * готов»: на второй день о нас просто забывают.
 */
export function nextTouchAt(stage: string, lastTouch: Date): Date {
  const days = stage === "new" ? 1 : stage === "qualifying" ? 2 : stage === "meeting_set" ? 1 : 0;
  if (days === 0) return new Date(8640000000000000); // won/lost — не трогаем
  return new Date(lastTouch.getTime() + days * 86_400_000);
}

export function isTouchDue(lead: Lead, now: Date): boolean {
  if (lead.stage === "won" || lead.stage === "lost") return false;
  return nextTouchAt(lead.stage, new Date(lead.updated_at)).getTime() <= now.getTime();
}

/** Черновик первого сообщения без модели: факты платформы + вопрос в конце. */
export function draftOutreachFallback(lead: Lead, facts: { aiBookings7d: number }): string {
  const who = lead.name ? `${lead.name}, здравствуйте!` : "Здравствуйте!";
  const salon = lead.company ? ` «${lead.company}»` : "";
  return (
    `${who} Меня зовут Рамис, я из Qabyl. Мы делаем онлайн-запись и ИИ-администратора для салонов: ` +
    `он отвечает клиентам в WhatsApp круглосуточно, подбирает время и записывает сам. ` +
    `За прошлую неделю у наших салонов он оформил ${facts.aiBookings7d} записей, пока мастера работали. ` +
    `Скажите, у вас${salon} клиенты записываются в переписке? Если да — покажу за 10 минут, как это выглядит.`
  );
}

export function formatLeadList(leads: Lead[], now: Date): string {
  if (leads.length === 0) return "🤝 Лидов пока нет. Добавить: /lead 0700112233 Имя Салон";
  const lines = ["🤝 <b>Лиды</b>", ""];
  for (const l of leads) {
    const due = isTouchDue(l, now) ? " ⏰" : "";
    const title = [l.name, l.company].filter(Boolean).join(" · ") || l.phone || "без имени";
    lines.push(`#${l.id} ${title} — ${stageLabel(l.stage)}${due}`);
  }
  lines.push("", "Карточка: /lead 7 · Стадия: /stage 7 встреча · Текст: /pitch 7");
  return lines.join("\n");
}

export function formatLeadCard(lead: Lead, now: Date): string {
  const lines = [
    `🤝 <b>Лид #${lead.id}</b> — ${stageLabel(lead.stage)}`,
    "",
    `Имя: ${lead.name ?? "—"}`,
    `Салон: ${lead.company ?? "—"}`,
    `Телефон: +${lead.phone ?? "—"}`,
  ];
  if (lead.needs) lines.push(`Что нужно: ${lead.needs}`);
  if (lead.objections) lines.push(`Возражения: ${lead.objections}`);
  if (lead.notes) lines.push(`Заметки: ${lead.notes}`);
  const due = isTouchDue(lead, now);
  lines.push(
    "",
    due ? "⏰ Пора вернуться к нему" : `Следующее касание: ${touchLabel(lead, now)}`,
    "",
    "Что дальше: /pitch " +
      lead.id +
      " — черновик сообщения · /note " +
      lead.id +
      " текст — заметка",
  );
  return lines.join("\n");
}

function touchLabel(lead: Lead, now: Date): string {
  if (lead.stage === "won" || lead.stage === "lost") return "не требуется";
  const at = nextTouchAt(lead.stage, new Date(lead.updated_at));
  const days = Math.max(0, Math.round((at.getTime() - now.getTime()) / 86_400_000));
  return days === 0 ? "сегодня" : days === 1 ? "завтра" : `через ${days} дн.`;
}

export function formatFunnel(counts: Record<string, number>, dueCount: number): string {
  const total = LEAD_STAGES.reduce((a, s) => a + (counts[s] ?? 0), 0);
  const lines = ["📊 <b>Воронка Айдара</b>", ""];
  for (const s of LEAD_STAGES) lines.push(`${stageLabel(s)}: ${counts[s] ?? 0}`);
  lines.push("", `Всего лидов: ${total}`);
  if (dueCount > 0) lines.push(`⏰ Ждут касания: ${dueCount} — /leads`);
  return lines.join("\n");
}
