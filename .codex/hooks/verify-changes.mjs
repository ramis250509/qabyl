#!/usr/bin/env node
/**
 * Stop — прогоняет `bun test`, если за этот ход правился покрытый тестами код.
 *
 * Почему Stop, а не PostToolUse: полный сьют идёт 20-60 секунд, и при пяти правках
 * подряд это добавило бы несколько минут ожидания на ровном месте. Здесь проверка
 * запускается один раз, когда Claude уже закончил, и только если журнал правок
 * (его ведёт after-edit.mjs) не пуст.
 *
 * Код возврата 2 не даёт ходу завершиться и отдаёт вывод обратно Claude — то есть
 * упавший тест он увидит и починит сам, без участия человека.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const PROJECT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Защита от зацикливания: если ход уже был продлён этим хуком, второй раз не лезем.
  if (input.stop_hook_active) process.exit(0);

  const session = String(input.session_id ?? "default").replace(/[^\w-]/g, "");
  const journal = join(PROJECT, ".claude", ".cache", `edited-${session}.txt`);
  if (!existsSync(journal)) process.exit(0);

  const files = [...new Set(readFileSync(journal, "utf8").split("\n").filter(Boolean))];
  // Снимаем журнал сразу: если тесты упадут, Claude продолжит править и заполнит его заново,
  // а старый список не должен запускать проверку повторно.
  rmSync(journal, { force: true });
  if (files.length === 0) process.exit(0);

  const run = spawnSync("bun", ["test"], {
    cwd: PROJECT,
    timeout: 300000,
    encoding: "utf8",
    shell: process.platform === "win32", // на Windows bun живёт в .cmd-обёртке
  });

  // bun не установлен или не запустился — это не повод ломать ход.
  if (run.error) process.exit(0);
  if (run.status === 0) process.exit(0);

  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n");

  // Агент печатает в тесты много собственных логов ([wa-agent] ..., [wa-v4] ...).
  // Простой хвост утонул бы в них и не показал бы, что именно упало, поэтому
  // вытаскиваем адресно: имена упавших тестов, строки ошибок и итоговый счёт.
  const noise = /^\s*\[(wa-agent|wa-v4|ig)\]/;
  const failures = out.filter((l) => /\(fail\)/.test(l));
  const errors = out.filter((l) => /^\s*(error:|Expected|Received|at .*\.test\.ts)/.test(l));
  const summary = out.filter((l) => /\d+ (pass|fail)\b/.test(l));
  let report = [...failures, ...errors.slice(0, 20), ...summary].join("\n").trim();
  if (!report)
    report = out
      .filter((l) => !noise.test(l))
      .slice(-30)
      .join("\n");

  process.stderr.write(
    "Тесты упали после правок в этом ходе.\n\n" +
      `Затронутые файлы:\n${files.map((f) => "  " + f).join("\n")}\n\n` +
      `Что упало:\n${report}\n\n` +
      "Почини падения, прежде чем заканчивать. Если тест устарел и падение ожидаемо — " +
      "скажи об этом явно и объясни, почему поведение изменилось намеренно.",
  );
  process.exit(2);
});
