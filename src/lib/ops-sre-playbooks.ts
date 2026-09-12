// Что Деби считает проблемой и что он вправе починить сам. Без базы и сети.
//
// ГЛАВНЫЙ ВОПРОС ЭТОГО ФАЙЛА: какое лечение можно применять БЕЗ человека. Правило одно и жёсткое —
// само выполняется только то, что:
//   • идемпотентно (повторный запуск ничего не портит),
//   • ничего не удаляет и не пишет клиентам салона,
//   • проверяемо: после лечения тот же признак должен исчезнуть.
// Всё остальное уходит владельцу: кнопкой, если лечение есть, и инцидентом, если его нет. Проблемы, которые лечатся только правкой кода, честно называются
// инцидентом: агент, делающий вид, что починил, хуже агента, который молчит.

export type Signals = {
  /** Задачи по расписанию, падающие с таймаутом за последние сутки. */
  cronTimeouts: { job: string; count: number }[];
  /** Входящие сообщения клиентов, которые никто не обработал. */
  stuckInbound: number;
  /** События шины, лежащие необработанными больше часа. */
  unhandledEvents: number;
  /** Счета с просроченной датой повторной попытки. */
  pendingInvoicesDue: number;
  /** Ошибки истёкшего токена WhatsApp (code 190). */
  waTokenErrors: number;
  /** Ошибки шаблонов Meta (132xxx). */
  templateErrors: number;
  /** Самая частая новая ошибка за период, если она бьёт заметно. */
  errorSpike: { fingerprint: string; count: number; sample: string } | null;
};

export type Finding = {
  /** Ключ лечения или инцидента. */
  key: string;
  /** Что случилось — словами владельца. */
  title: string;
  /** Подробность с числами: без неё «что-то не так» бесполезно. */
  detail: string;
  /**
   * auto — Деби делает сам и проверяет;
   * approval — предложит кнопкой;
   * none — лечится только руками, открывает инцидент.
   */
  remedy: "auto" | "approval" | "none";
  action?: Record<string, unknown>;
};

export const AUTO_REMEDIES = ["route_events", "rerun_billing"] as const;

const SPIKE_THRESHOLD = 20;

/** Разбор сигналов в находки. Порядок — по важности для владельца. */
export function diagnose(s: Signals): Finding[] {
  const out: Finding[] = [];

  // 1. Клиент написал, и его сообщение никто не разобрал. Худшее из возможного — и, к сожалению,
  // не лечится состоянием: перезапуск обработки в базе стучится в удалённый транспорт (Green-API),
  // поэтому это инцидент с диагнозом, а не «сейчас поправлю».
  if (s.stuckInbound > 0) {
    out.push({
      key: "stuck_inbound",
      title: `Сообщений клиентов без ответа: ${s.stuckInbound}`,
      detail:
        "Клиент написал, а ассистент не взял сообщение в работу больше 15 минут. Сам перезапустить " +
        "не могу: механизм перезапуска в базе до сих пор настроен на удалённый транспорт — нужна " +
        "правка. Проверьте переписки в кабинете и ответьте вручную.",
      remedy: "none",
    });
  }

  // 2. Шина: задачи агентов не появились, потому что события никто не разобрал.
  if (s.unhandledEvents > 0) {
    out.push({
      key: "route_events",
      title: `Событий без разбора: ${s.unhandledEvents}`,
      detail: "Агенты не узнали о том, что произошло. Разбираю очередь.",
      remedy: "auto",
      action: { type: "sre_fix", key: "route_events" },
    });
  }

  // 3. Счета: просроченная повторная попытка списания — это деньги, которые не пришли.
  if (s.pendingInvoicesDue > 0) {
    out.push({
      key: "rerun_billing",
      title: `Счетов ждут повторной попытки: ${s.pendingInvoicesDue}`,
      detail: "Запускаю цикл оплаты вне расписания.",
      remedy: "auto",
      action: { type: "sre_fix", key: "rerun_billing" },
    });
  }

  // 4. Токен WhatsApp: сам не починится — нужен вход владельца салона в Meta.
  if (s.waTokenErrors > 0) {
    out.push({
      key: "wa_token_expired",
      title: "У салона отвалился WhatsApp",
      detail:
        `Ошибок доступа за сутки: ${s.waTokenErrors}. Обычно это истёкший доступ: салону нужно ` +
        "заново нажать «Подключить WhatsApp». Сам этого сделать не могу — нужен вход владельца салона.",
      remedy: "none",
    });
  }

  // 5. Шаблоны Meta: тоже руками — отправить на модерацию или вписать имя шаблона.
  if (s.templateErrors > 0) {
    out.push({
      key: "templates_rejected",
      title: "Уведомления не уходят из-за шаблонов",
      detail:
        `Ошибок шаблонов за сутки: ${s.templateErrors}. Клиент за пределами 24 часов получает ` +
        "только одобренный шаблон — нужно проверить их в настройках салона.",
      remedy: "none",
    });
  }

  // 6. Падающая по таймауту задача расписания — это код, а не состояние. Инцидент, не лечение.
  for (const t of s.cronTimeouts) {
    if (t.count < 3) continue;
    out.push({
      key: `cron_timeout:${t.job}`,
      title: `Задача «${t.job}» не укладывается во время`,
      detail:
        `Падает с таймаутом ${t.count} раз за сутки. Сама не пройдёт: нужно ускорить запросы ` +
        "или уменьшить порцию за один проход. Открываю инцидент.",
      remedy: "none",
    });
  }

  // 7. Всплеск одной ошибки: показать владельцу до того, как он услышит это от салона.
  if (s.errorSpike && s.errorSpike.count >= SPIKE_THRESHOLD) {
    out.push({
      key: `spike:${s.errorSpike.fingerprint}`,
      title: `Одна ошибка повторилась ${s.errorSpike.count} раз`,
      detail: s.errorSpike.sample.slice(0, 200),
      remedy: "none",
    });
  }

  return out;
}

/** Короткий отчёт для Telegram: что нашёл, что сделал сам, что осталось человеку. */
export function formatHealingReport(
  findings: Finding[],
  results: { key: string; ok: boolean; note: string }[],
): string {
  if (findings.length === 0) return "🛠 Деби: всё чисто, чинить нечего.";
  const done = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const manual = findings.filter((f) => f.remedy === "none");

  const lines = ["🛠 <b>Деби: проверка и лечение</b>", ""];
  for (const f of findings) {
    const res = results.find((r) => r.key === f.key);
    const mark = res ? (res.ok ? "✅" : "⚠️") : f.remedy === "none" ? "📌" : "⏳";
    lines.push(`${mark} <b>${f.title}</b>`, f.detail);
    if (res) lines.push(`   → ${res.note}`);
    lines.push("");
  }
  lines.push(
    `Починил сам: ${done.length}${failed.length ? `, не получилось: ${failed.length}` : ""}${
      manual.length ? `, нужна твоя рука: ${manual.length}` : ""
    }`,
  );
  if (manual.length > 0) lines.push("Задачи по ним на доске: /tasks");
  return lines.join("\n");
}
