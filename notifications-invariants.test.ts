// Регрессионный щит вокруг колокольчика уведомлений.
//
// 21.08.2026 салон «Эркеайым» перестал видеть уведомления и жаловался, что они
// «не приходят». Причин было две, и обе — тихие:
//
//   1. notify_appointment_event() перестал класть branch_id в notifications
//      (регрессия приехала с 20260801130000_prepayment_schema.sql). Читатель
//      фильтровал `.eq("branch_id", x)`, а в SQL NULL не равен ничему — список
//      становился пустым, без единой ошибки в консоли.
//   2. Тот же триггер форматировал время `AT TIME ZONE 'UTC'` вместо таймзоны
//      салона: запись на 14:00 приезжала в уведомление как «08:00».
//
// Оба бага были невидимы для типов, линтера и всех 758 тестов — переписать
// SQL-функцию целиком и потерять по дороге колонку ничего не стоило. Эти тесты
// читают миграции как текст именно поэтому: опереться тут больше не на что.
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { branchScopeFilter, matchesBranchScope } from "@/lib/branch-scope";

const MIGRATIONS = join(import.meta.dir, "supabase", "migrations");

/**
 * Тело последней (по номеру версии) редакции SQL-функции во всех миграциях —
 * то есть ровно то определение, которое в итоге живёт в базе.
 */
function latestFunctionBody(fnName: string): string {
  const header = `CREATE OR REPLACE FUNCTION public.${fnName}(`;
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: string | null = null;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    let at = sql.indexOf(header);
    while (at !== -1) {
      // Тело обрамлено долларовым делимитером: `AS $function$ … $function$`
      // (в старых миграциях из Lovable — `AS $$ … $$`).
      const asAt = sql.indexOf("AS $", at);
      if (asAt === -1) break;
      const delimEnd = sql.indexOf("$", asAt + 4);
      if (delimEnd === -1) break;
      const delim = sql.slice(asAt + 3, delimEnd + 1);
      const open = asAt + 3;
      const close = sql.indexOf(delim, open + delim.length);
      if (close === -1) break;
      found = sql.slice(open + delim.length, close);
      at = sql.indexOf(header, close);
    }
  }

  if (found === null) throw new Error(`не нашёл определение public.${fnName} ни в одной миграции`);
  return found;
}

/** Список колонок каждого `INSERT INTO public.notifications (...)` в теле функции. */
function notificationInsertColumns(body: string): string[][] {
  const marker = "INSERT INTO public.notifications";
  const out: string[][] = [];
  let at = body.indexOf(marker);
  while (at !== -1) {
    const open = body.indexOf("(", at);
    const close = body.indexOf(")", open);
    out.push(
      body
        .slice(open + 1, close)
        .split(",")
        .map((c) => c.trim()),
    );
    at = body.indexOf(marker, close);
  }
  return out;
}

describe("notify_appointment_event", () => {
  const body = latestFunctionBody("notify_appointment_event");

  test("каждый INSERT в notifications проставляет branch_id", () => {
    const inserts = notificationInsertColumns(body);
    expect(inserts.length).toBeGreaterThan(0);
    for (const cols of inserts) expect(cols).toContain("branch_id");
  });

  test("время форматируется в таймзоне салона, а не в UTC", () => {
    // Именно этот литерал давал салону из Бишкека сдвиг ровно на шесть часов.
    expect(body).not.toContain("AT TIME ZONE 'UTC'");

    const stamps = body.split("to_char(").slice(1);
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      const call = stamp.slice(0, stamp.indexOf(")"));
      expect(call).toContain("AT TIME ZONE _tz");
    }
  });

  test("_tz берётся из салона через хелпер с безопасным фолбэком", () => {
    expect(body).toContain("_tz := public.salon_local_tz(NEW.salon_id)");

    const helper = latestFunctionBody("salon_local_tz");
    expect(helper).toContain("Asia/Bishkek");
    // Неизвестное имя зоны роняет AT TIME ZONE — а вместе с триггером и всю
    // запись клиента. Уведомление никогда не должно стоить салону брони.
    expect(helper).toContain("EXCEPTION WHEN OTHERS");
  });
});

describe("branch scope: NULL значит «весь салон»", () => {
  test("строка без филиала видна при любом фильтре", () => {
    expect(matchesBranchScope(null, "branch-1")).toBe(true);
  });

  test("ещё не догруженный филиал не прячет строку", () => {
    expect(matchesBranchScope(undefined, "branch-1")).toBe(true);
  });

  test("чужой филиал прячется", () => {
    expect(matchesBranchScope("branch-2", "branch-1")).toBe(false);
  });

  test("свой филиал виден", () => {
    expect(matchesBranchScope("branch-1", "branch-1")).toBe(true);
  });

  test("без фильтра видно всё", () => {
    expect(matchesBranchScope("branch-2", null)).toBe(true);
  });

  test("SQL-условие включает и NULL, и выбранный филиал", () => {
    expect(branchScopeFilter("branch-1")).toBe("branch_id.is.null,branch_id.eq.branch-1");
  });
});

describe("читатели уведомлений", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dir, ...p), "utf8");

  test('хук не режет выборку через .eq("branch_id")', () => {
    const hook = read("src", "hooks", "use-notifications.tsx");
    expect(hook).not.toContain('eq("branch_id"');
    expect(hook).toContain("branchScopeFilter");
  });

  test("страница уведомлений фильтрует через общий хелпер", () => {
    const page = read("src", "routes", "admin", "notifications.tsx");
    expect(page).toContain("matchesBranchScope");
  });
});
