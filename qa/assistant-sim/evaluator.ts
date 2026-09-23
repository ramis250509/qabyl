// Independent judge. It grades a finished conversation against the salon's ground truth and the
// ACTUAL database outcome — never against what the assistant claims. Deterministic assertions run
// before it and are handed to it as facts, so the judge cannot talk a failed booking into a pass.

import { llmJson, judgeLlm } from "./llm";
import type { AssertionResult } from "./assertions";
import type { TranscriptLine } from "./customer";

export const SCORE_KEYS = [
  "understanding",
  "booking_correctness",
  "naturalness",
  "conciseness",
  "context_retention",
  "no_hallucinations",
  "efficiency",
  "initiative",
  "tone",
  "goal_completion",
] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

export type JudgeIssue = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  evidence: string;
  probable_root_cause?: string;
};

export type Verdict = {
  scores: Record<ScoreKey, number>;
  hallucinations: Array<{ text: string; why: string }>;
  asked_already_known: string[];
  issues: JudgeIssue[];
  goal_met: boolean;
  overall_pass: boolean;
  summary: string;
};

const SYSTEM = `Ты — строгий и независимый QA-аудитор качества администратора салона красоты, который отвечает клиентам в WhatsApp.
Администратор — ИИ-ассистент продукта Qabyl, но оценивай его как лучшего живого администратора: понял ли человека, записал ли правильно, говорил ли по-человечески.

Тебе дают: цель клиента и ожидаемый результат, ИСТИННЫЕ данные салона (услуги, цены, мастера, филиалы, график), переписку (с отметками, какие инструменты ассистент вызывал), фактическое состояние базы после разговора и результаты автоматических проверок.
ГЛАВНОЕ: истина — это данные салона и база, а не слова ассистента. Если ассистент написал «вы записаны на 18:00», а в базе 19:00 или записи нет — это критическая ошибка.
Если ОЖИДАЕМЫЙ РЕЗУЛЬТАТ — передача диалога живому администратору, ИИ после неё обязан молчать. Отсутствие записи, которую должен оформить человек, НЕ является провалом ИИ и не снижает goal_completion/booking_correctness. Но любые ответы ИИ ДО передачи всё равно проверяй по фактам и инструментам.

Оценки 1–5 (5 — безупречно, 3 — терпимо, 1 — провал):
- understanding: правильно ли понял, чего хочет клиент (включая сленг, опечатки, кыргызский).
- booking_correctness: создалась/изменилась/отменилась ли ИМЕННО та запись, что нужна (по базе). Если по сценарию запись не нужна — 5, если ассистент ничего лишнего не создал.
- naturalness: звучит как живой администратор, а не робот/шаблон.
- conciseness: без простыней и лишнего.
- context_retention: помнит сказанное ранее (мастер, время, имя, услуга).
- no_hallucinations: не выдумал услугу, цену, мастера, филиал, время, свободные окна, правила салона. Любая выдумка = не выше 2.
- efficiency: не переспрашивает то, что клиент уже сказал; не затягивает.
- initiative: предлагает альтернативы, когда нужного нет.
- tone: вежливо, тепло, спокойно даже с грубым клиентом.
- goal_completion: получил ли клиент то, зачем пришёл (или честный ответ, если это невозможно).

issues — конкретные проблемы с цитатой-доказательством и вероятной причиной (например: «модель не вызвала check_time для выбранного мастера», «инструмент вернул slot_not_free, но ассистент подтвердил запись»).
overall_pass = false, если есть critical/high проблема, провал автоматической проверки уровня critical/high, или goal_completion < 3.

Верни СТРОГО JSON:
{"scores": {"understanding":n,"booking_correctness":n,"naturalness":n,"conciseness":n,"context_retention":n,"no_hallucinations":n,"efficiency":n,"initiative":n,"tone":n,"goal_completion":n},
 "hallucinations": [{"text":"...","why":"..."}],
 "asked_already_known": ["..."],
 "issues": [{"severity":"critical|high|medium|low","title":"...","evidence":"...","probable_root_cause":"..."}],
 "goal_met": true|false, "overall_pass": true|false, "summary": "2–3 предложения"}`;

export async function judgeConversation(input: {
  goal: string;
  expected: string;
  groundTruth: unknown;
  transcript: Array<TranscriptLine & { tools?: string[] }>;
  dbOutcome: unknown;
  assertions: AssertionResult[];
}): Promise<Verdict> {
  const user = [
    `ЦЕЛЬ КЛИЕНТА: ${input.goal}`,
    `ОЖИДАЕМЫЙ РЕЗУЛЬТАТ: ${input.expected}`,
    ``,
    `ИСТИННЫЕ ДАННЫЕ САЛОНА (JSON):`,
    JSON.stringify(input.groundTruth, null, 1),
    ``,
    `ПЕРЕПИСКА:`,
    input.transcript
      .map((l) =>
        l.from === "client"
          ? `КЛИЕНТ: ${l.text}`
          : l.from === "assistant"
            ? `АДМИН: ${l.text}${l.tools?.length ? `\n   [инструменты в этом ходе: ${l.tools.join(", ")}]` : ""}`
            : `[система: ${l.text}]`,
      )
      .join("\n"),
    ``,
    `ФАКТИЧЕСКОЕ СОСТОЯНИЕ БАЗЫ ПОСЛЕ РАЗГОВОРА (JSON):`,
    JSON.stringify(input.dbOutcome, null, 1),
    ``,
    `АВТОМАТИЧЕСКИЕ ПРОВЕРКИ:`,
    input.assertions
      .map((a) => `${a.ok ? "OK  " : "FAIL"} [${a.severity}] ${a.id}: ${a.message}`)
      .join("\n") || "(нет)",
  ].join("\n");
  const v = await llmJson<Verdict>(judgeLlm(), SYSTEM, user, { temperature: 0, maxTokens: 4096 });
  const scores = {} as Record<ScoreKey, number>;
  for (const k of SCORE_KEYS) {
    const n = Number((v?.scores as any)?.[k]);
    scores[k] = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
  }
  return {
    scores,
    hallucinations: Array.isArray(v?.hallucinations) ? v.hallucinations : [],
    asked_already_known: Array.isArray(v?.asked_already_known) ? v.asked_already_known : [],
    issues: Array.isArray(v?.issues) ? v.issues : [],
    goal_met: Boolean(v?.goal_met),
    overall_pass: Boolean(v?.overall_pass),
    summary: String(v?.summary ?? ""),
  };
}

export function averageScore(v: Verdict): number {
  return SCORE_KEYS.reduce((s, k) => s + v.scores[k], 0) / SCORE_KEYS.length;
}
