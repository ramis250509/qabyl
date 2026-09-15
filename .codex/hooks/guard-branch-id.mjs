#!/usr/bin/env node
/**
 * PreToolUse (Edit|Write) — напоминание про branch_id.
 *
 * В этой схеме branch_id = NULL означает «действует во всех филиалах» (услуга или
 * мастер, не привязанные к конкретной точке). В SQL `.eq("branch_id", x)` НИКОГДА не
 * вернёт строку с NULL, поэтому такой фильтр молча выкидывает все универсальные
 * записи. Однажды это положило виджет бронирования целиком: услуги были в базе, но
 * клиент видел пустой список.
 *
 * Хук предупреждает, а не блокирует: для appointments/master_schedules, где филиал
 * обязателен, .eq() — правильный код. Решение остаётся за тем, кто пишет запрос.
 */
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // не мешаем работе, если формат вдруг изменится
  }

  const t = input.tool_input ?? {};
  // Edit кладёт новый код в new_string, Write — в content.
  const code = `${t.new_string ?? ""}${t.content ?? ""}`;
  if (!/\.eq\(\s*["'`]branch_id["'`]/.test(code)) process.exit(0);

  const context =
    'ВНИМАНИЕ: в этой правке есть .eq("branch_id", ...). В схеме Qabyl branch_id = NULL ' +
    "означает «универсально для всех филиалов». .eq() отбрасывает такие строки молча — " +
    "именно так однажды сломался весь виджет бронирования.\n" +
    "Проверь таблицу, к которой идёт запрос:\n" +
    "  • services, masters, и всё, что может быть общим для сети → нужен " +
    "q.or(`branch_id.is.null,branch_id.eq.${branchId}`)\n" +
    "  • appointments, master_schedules, где филиал обязателен → .eq() корректен, продолжай.\n" +
    "Образец правильного кода: src/components/book/PublicBooking.tsx:209";

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    }),
  );
});
