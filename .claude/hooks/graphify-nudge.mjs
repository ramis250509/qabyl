#!/usr/bin/env node
/**
 * PreToolUse (Bash | Read | Glob) — напоминание сходить в граф перед раскопками в исходниках.
 *
 * Заменяет прежние python3-однострочники из settings.json. На этой машине python3 нет
 * (есть только заглушка Microsoft Store), поэтому те хуки всегда падали в `|| true` и
 * не срабатывали ни разу — правило из CLAUDE.md жило только на бумаге.
 *
 * Отличие от прежней версии: напоминание выдаётся ОДИН раз за сессию на категорию,
 * а не на каждое чтение файла. Цель — сориентировать в начале работы; повторять то же
 * самое пятьдесят раз за сессию значит просто жечь контекст.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const CODE_EXT =
  /\.(py|js|ts|tsx|jsx|astro|vue|svelte|go|rs|java|rb|c|h|cpp|hpp|cc|cs|kt|swift|php|scala|lua|sh|md|rst|txt|mdx|sql)$/i;
const SEARCH_CMD = /\b(grep|rg|ripgrep|find|fd|ack|ag)\b/;

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Нет графа — нечего и советовать.
  if (!existsSync(join(PROJECT, "graphify-out", "graph.json"))) process.exit(0);

  const t = input.tool_input ?? {};
  const tool = input.tool_name ?? "";
  let category = null;

  if (tool === "Bash") {
    if (SEARCH_CMD.test(String(t.command ?? ""))) category = "search";
  } else {
    const target = [t.file_path, t.pattern, t.path]
      .filter(Boolean)
      .join(" ")
      .replaceAll(String.fromCharCode(92), "/");
    // Чтение самого graphify-out/ подсказки не требует — это и есть граф.
    if (target && !target.includes("graphify-out/") && CODE_EXT.test(target)) category = "read";
  }
  if (!category) process.exit(0);

  // Один раз за сессию на категорию.
  const session = String(input.session_id ?? "default").replace(/[^\w-]/g, "");
  const dir = join(PROJECT, ".claude", ".cache");
  const flag = join(dir, `graphify-${category}-${session}.flag`);
  if (existsSync(flag)) process.exit(0);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(flag, "");
  } catch {
    process.exit(0); // не можем отметиться — лучше промолчать, чем повторяться каждый раз
  }

  const context =
    "У репозитория есть граф знаний в graphify-out/. Прежде чем раскапывать исходники " +
    "вручную, сориентируйся по нему — это дешевле и точнее, чем grep:\n" +
    '  graphify query "<вопрос>"      — подграф под конкретный вопрос\n' +
    '  graphify explain "<понятие>"   — разбор одного concept\n' +
    '  graphify path "<A>" "<B>"      — как связаны две сущности\n' +
    "Читать и грепать файлы напрямую нормально после того, как граф дал ориентиры, " +
    "и всегда — когда правишь или отлаживаешь конкретные строки. " +
    "Это же правило передавай субагентам: на них хуки не распространяются. " +
    "(Напоминание показывается один раз за сессию.)";

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
    }),
  );
});
