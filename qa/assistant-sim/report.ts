// Human-readable report of one quality run: summary in the agreed format, then every failure with
// conversation, expected vs actual, database state, probable root cause, severity and logs.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { averageScore, SCORE_KEYS } from "./evaluator";
import type { ScenarioResult } from "./run";

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

const DB_ASSERTION = /^(booking|cancel|reschedule|untouched|invariant|claims|race)\./;

export function writeReport(
  results: ScenarioResult[],
  outDir: string,
  extra: { unknownRpcs: string[] },
): string {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;

  const bookingRuns = results.filter((r) =>
    r.conversations.some((c) =>
      c.assertions.some((a) => DB_ASSERTION.test(a.id) && !a.id.startsWith("invariant.")),
    ),
  );
  const bookingOk = bookingRuns.filter((r) =>
    r.conversations.every((c) =>
      c.assertions.filter((a) => DB_ASSERTION.test(a.id)).every((a) => a.ok),
    ),
  );

  const judged = results.filter((r) => r.verdict);
  const quality = judged.length
    ? judged.reduce((s, r) => s + averageScore(r.verdict!), 0) / judged.length / 5
    : NaN;
  const hallucinated = results.filter(
    (r) =>
      (r.verdict?.hallucinations.length ?? 0) > 0 ||
      r.conversations.some((c) =>
        c.assertions.some((a) => a.id.startsWith("hallucination.") && !a.ok),
      ),
  );
  const goal = results.filter((r) =>
    r.verdict
      ? r.verdict.goal_met
      : r.conversations.every((c) =>
          c.assertions.filter((a) => DB_ASSERTION.test(a.id)).every((a) => a.ok),
        ),
  );

  const failed = results.filter((r) => !r.passed);
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, none: 4 } as const;
  failed.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  const byScore = Object.fromEntries(
    SCORE_KEYS.map((k) => [
      k,
      judged.length
        ? (judged.reduce((s, r) => s + r.verdict!.scores[k], 0) / judged.length).toFixed(2)
        : "—",
    ]),
  );

  const summary = [
    `Total conversations: ${total}`,
    `Passed: ${passed}`,
    `Failed: ${total - passed}`,
    `Booking correctness: ${pct(bookingOk.length, bookingRuns.length)}`,
    `Conversation quality: ${Number.isNaN(quality) ? "— (без судьи)" : `${Math.round(quality * 100)}%`}`,
    `Hallucination rate: ${pct(hallucinated.length, total)}`,
    `Successful goal completion: ${pct(goal.length, total)}`,
    ``,
    `Failed scenarios:`,
    ...failed.map(
      (r, i) =>
        `${i + 1}. [${r.severity}] ${r.scenario.id} — ${r.failures[0] ?? r.error ?? "см. отчёт"}`,
    ),
  ].join("\n");

  const md: string[] = [
    `# AI Assistant Quality Test — ${new Date().toISOString()}`,
    "",
    "```",
    summary,
    "```",
    "",
    "## Средние оценки судьи (1–5)",
    "",
    "| Критерий | Оценка |",
    "|---|---|",
    ...Object.entries(byScore).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    extra.unknownRpcs.length
      ? `> ⚠ Симулятор не знает RPC: ${extra.unknownRpcs.join(", ")} — добавьте их в fake-db.ts.\n`
      : "",
    "## Провалы",
    "",
  ];

  for (const r of failed) {
    md.push(`### [${r.severity}] ${r.scenario.id} — ${r.scenario.title}`);
    if (r.scenario.regression) md.push(`Регрессия: ${r.scenario.regression.bug}`);
    md.push(
      "",
      `**Ожидалось:** ${r.expected}`,
      "",
      "**Что пошло не так:**",
      ...r.failures.map((f) => `- ${f}`),
    );
    if (r.probableRootCauses.length)
      md.push("", "**Вероятная причина:**", ...r.probableRootCauses.map((c) => `- ${c}`));
    if (r.verdict) md.push("", `**Судья:** ${r.verdict.summary}`);
    for (const c of r.conversations) {
      md.push("", `**Разговор (${c.persona}, итог: ${c.endStatus})**`, "", "```");
      for (const l of c.transcript) {
        md.push(
          `${l.from === "client" ? "КЛИЕНТ" : l.from === "assistant" ? "АДМИН " : "СИСТЕМА"}: ${l.text.replace(/\n/g, "\n        ")}`,
        );
        if (l.tools?.length) md.push(`        [tools: ${l.tools.join(", ")}]`);
        if (l.errors?.length) md.push(`        [errors: ${l.errors.join(" | ")}]`);
      }
      md.push("```");
    }
    md.push(
      "",
      "**Состояние базы (записи салона после разговора):**",
      "",
      "```json",
      JSON.stringify(r.db.appointments, null, 1),
      "```",
    );
    const logs = [
      ...r.logs.toolErrors,
      ...r.logs.errorLogs.map((e: any) => `${e.level} ${e.source}: ${e.message}`),
      ...r.logs.dbErrors.map((e: any) => `db ${e.rpc ?? e.table}: ${e.error}`),
    ];
    if (logs.length) md.push("", "**Логи:**", "", "```", ...logs.slice(0, 40), "```");
    if (r.error) md.push("", "**Ошибка раннера:**", "", "```", r.error, "```");
    md.push("");
  }

  md.push(
    "## Все сценарии",
    "",
    "| Сценарий | Итог | Серьёзность | Оценка судьи | Время |",
    "|---|---|---|---|---|",
  );
  for (const r of results) {
    md.push(
      `| ${r.scenario.id} | ${r.passed ? "PASS" : "FAIL"} | ${r.severity} | ${r.verdict ? averageScore(r.verdict).toFixed(1) : "—"} | ${Math.round(r.durationMs / 1000)}s |`,
    );
  }

  writeFileSync(join(outDir, "report.md"), md.filter((x) => x !== undefined).join("\n"));
  return summary;
}
