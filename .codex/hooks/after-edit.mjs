#!/usr/bin/env node
/**
 * PostToolUse (Edit|Write|MultiEdit) — две дешёвые операции за один запуск node.
 *
 *  1. Прогоняет prettier по изменённому файлу, чтобы форматирование не расходилось
 *     с .prettierrc и `bun format` не давал шумных диффов потом.
 *  2. Записывает путь в журнал сессии. Его читает Stop-хук (verify-changes.mjs),
 *     чтобы понять, надо ли гонять тесты. Журнал — единственный надёжный способ
 *     отличить «Claude только что правил движок» от «в рабочей копии и так лежат
 *     чужие незакоммиченные изменения».
 *
 * Хук намеренно молчаливый и никогда не роняет ход: форматирование — удобство,
 * а не повод прерывать работу.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const PROJECT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const FORMATTABLE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".md"]);

// Пути, которые покрыты `bun test`. src/components и прочий UI сюда не входят —
// тестов на них нет, а гонять 19 секунд ради правки кнопки бессмысленно.
const TESTED = [
  /^src\/lib\//,
  /^src\/routes\/api\//,
  /^src\/integrations\//,
  /\.test\.ts$/,
  /^supabase\//,
];

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) process.exit(0);

  // --- 1. форматирование --------------------------------------------------------------
  const prettier = join(PROJECT, "node_modules", "prettier", "bin", "prettier.cjs");
  if (
    FORMATTABLE.has(extname(filePath).toLowerCase()) &&
    existsSync(prettier) &&
    existsSync(filePath)
  ) {
    // --ignore-unknown и .prettierignore сами отсеют routeTree.gen.ts и bun.lock.
    spawnSync(process.execPath, [prettier, "--write", "--ignore-unknown", filePath], {
      cwd: PROJECT,
      timeout: 20_000,
      stdio: "ignore",
    });
  }

  // --- 2. журнал правок ---------------------------------------------------------------
  const rel = resolve(filePath)
    .slice(resolve(PROJECT).length + 1)
    .replaceAll(String.fromCharCode(92), "/");
  if (!TESTED.some((re) => re.test(rel))) process.exit(0);

  const session = String(input.session_id ?? "default").replace(/[^\w-]/g, "");
  try {
    const dir = join(PROJECT, ".claude", ".cache");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `edited-${session}.txt`), rel + "\n");
  } catch {
    // журнал недоступен — молча живём дальше, тесты просто не запустятся автоматически
  }
});
