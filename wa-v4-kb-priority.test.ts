// KB-priority regression: after the 2026-08-01 rewrite, salon-specific overrides
// (ai_rules, tone_instructions, pricing_rules, knowledge_base, knowledge_answers)
// live in a single "ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА" block appended to the very
// end of the system prompt. This suite locks that behaviour so a future refactor
// can't silently push those blocks back up into the middle of the prompt.

import { test, expect, describe } from "bun:test";
import { buildSystemPromptV4 } from "@/lib/wa-agent-v4.server";

function inputFor(configOverrides: Record<string, unknown> = {}) {
  return {
    salon: { salonId: "s1", salonName: "Тест-Салон", timezone: "Asia/Bishkek" },
    config: { industry: "beauty", languages: ["ru"], manage_cutoff_hours: 0, ...configOverrides },
    branches: [],
    salonInfo: { working_hours: null, address: null },
    stateData: {},
  } as any;
}

describe("KB priority — salon overrides block at prompt tail", () => {
  test("ai_rules appears with [ПРАВИЛО] marker inside the salon block", () => {
    const p = buildSystemPromptV4(
      inputFor({ ai_rules: "Всегда сразу называй цену. Никогда не спрашивай день до цены." }),
    );
    expect(p).toContain("ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА — АБСОЛЮТНЫЙ ПРИОРИТЕТ");
    expect(p).toContain("[ПРАВИЛО] Всегда сразу называй цену");
    expect(p).toContain("━━━ ПРАВИЛА ДЛЯ АССИСТЕНТА");
  });

  // rich_formatting (migration 20260812120000) is the ONLY way a salon can get lists/emoji:
  // writing "используй буллиты" into ai_rules used to lose to the hard "ФОРМАТ (СТРОГО)" line
  // above it, and humanizeReply() flattened whatever survived. Prompt and post-processor must
  // switch together, so lock both directions of the prompt half here.
  test("rich_formatting=false keeps the strict prose-only FORMAT rule", () => {
    const p = buildSystemPromptV4(inputFor({}));
    expect(p).toContain("ФОРМАТ (СТРОГО): только сплошной связный текст");
    expect(p).toContain("Эмодзи — максимум один на сообщение");
  });

  test("rich_formatting=true swaps in the permissive FORMAT rule, markdown still banned", () => {
    const p = buildSystemPromptV4(inputFor({ rich_formatting: true }));
    expect(p).not.toContain("ФОРМАТ (СТРОГО): только сплошной связный текст");
    expect(p).not.toContain("Эмодзи — максимум один на сообщение");
    expect(p).toContain("можно оформлять сообщения структурно");
    expect(p).toMatch(/markdown ЗАПРЕЩ/i);
  });

  test("knowledge_base appears with [ФАКТ] marker inside the salon block", () => {
    const p = buildSystemPromptV4(
      inputFor({ knowledge_base: "Парковка бесплатная. Работаем без выходных." }),
    );
    expect(p).toContain("[ФАКТ] Парковка бесплатная");
    expect(p).toContain("━━━ ФАКТЫ О БИЗНЕСЕ");
  });

  test("tone_instructions is a RULE, not a fact", () => {
    const p = buildSystemPromptV4(
      inputFor({ tone_instructions: "Обращайся к клиенту по имени и на «Вы»." }),
    );
    expect(p).toContain("[ПРАВИЛО] Обращайся к клиенту по имени");
  });

  test("pricing_rules is a RULE, not a fact", () => {
    const p = buildSystemPromptV4(inputFor({ pricing_rules: "На детей до 12 лет действует -20%." }));
    expect(p).toContain("[ПРАВИЛО] На детей до 12 лет действует -20%");
  });

  // The explicit-precedence line is what tells Gemini that OWNER rules beat the ~150 lines of
  // generic behaviour rules that live earlier in the prompt. Losing this line = losing the fix.
  test("explicit precedence line is present when the salon supplied any override", () => {
    const p = buildSystemPromptV4(inputFor({ ai_rules: "Не спрашивай день до цены." }));
    expect(p).toMatch(/ПЕРЕОПРЕДЕЛЯЕТ любую общую инструкцию/i);
    expect(p).toMatch(/следуй правилу владельца/i);
  });

  // Recency matters most: the OVERRIDES block must be AFTER the generic ЖЕЛЕЗНЫЕ ПРАВИЛА block
  // so autoregressive attention keeps salon rules top-of-mind at generation time.
  test("salon overrides block is positioned AFTER the generic ЖЕЛЕЗНЫЕ ПРАВИЛА", () => {
    const p = buildSystemPromptV4(inputFor({ ai_rules: "Всегда упоминай акцию месяца." }));
    const idxIron = p.indexOf("ЖЕЛЕЗНЫЕ ПРАВИЛА");
    const idxOverrides = p.indexOf("ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА");
    expect(idxIron).toBeGreaterThan(-1);
    expect(idxOverrides).toBeGreaterThan(idxIron);
  });

  // The final-line reminder keeps the precedence rule top-of-mind at generation time —
  // it is literally the last thing Gemini reads before producing tokens.
  test("final-line reminder present when rules exist", () => {
    const p = buildSystemPromptV4(inputFor({ ai_rules: "Всегда сразу называй цену." }));
    const tail = p.slice(-500);
    expect(tail).toMatch(/Напоминание перед ответом/);
    expect(tail).toMatch(/сильнее всех общих правил/);
  });

  // When ONLY facts are supplied (no rules), we still want the reminder to nudge the model
  // to prefer OWNER facts over its own knowledge. Different wording but same block.
  test("final-line reminder falls back to fact-focused variant when no rules present", () => {
    const p = buildSystemPromptV4(inputFor({ knowledge_base: "Работаем без выходных." }));
    const tail = p.slice(-500);
    expect(tail).toMatch(/Напоминание перед ответом/);
    expect(tail).toMatch(/единственный источник фактов/);
  });

  // Regression: an empty config used to leave stray "ПРАВИЛА ЭТОГО САЛОНА" headers with no
  // content in them. Filter must fully hide the block when both sides are empty.
  test("empty config → no salon overrides block at all", () => {
    const p = buildSystemPromptV4(inputFor({}));
    expect(p).not.toContain("ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА");
    expect(p).not.toContain("━━━ ПРАВИЛА ДЛЯ АССИСТЕНТА");
    expect(p).not.toContain("━━━ ФАКТЫ О БИЗНЕСЕ");
  });

  // Old prompt shape used the "ОБЯЗАТЕЛЬНЫЕ правила тона от салона:" prefix in the MIDDLE
  // of the prompt. That location leaks salon rules into the generic block again — regression.
  test("no salon-rule leakage in the OLD middle-of-prompt positions", () => {
    const p = buildSystemPromptV4(
      inputFor({
        tone_instructions: "Обращайся по имени.",
        pricing_rules: "На детей до 12 лет -20%.",
        knowledge_base: "Парковка бесплатная.",
      }),
    );
    expect(p).not.toContain("ОБЯЗАТЕЛЬНЫЕ правила тона от салона:");
    expect(p).not.toContain("ДОПОЛНИТЕЛЬНЫЕ ФАКТЫ О БИЗНЕСЕ");
    expect(p).not.toContain("ЧТО ВЛАДЕЛЕЦ РАССКАЗАЛ ОБ ЭТОМ БИЗНЕСЕ");
    expect(p).not.toContain(
      "Правила бизнеса по цене, фото и консультации (обязательно учитывай их)",
    );
  });

  // knowledge_answers (structured Q&A from the AI-tab wizard) is rendered into the FACTS
  // half of the salon block — same "salon owner told me" bucket as knowledge_base.
  test("knowledge_answers wizard content ends up in the salon-facts block", () => {
    const p = buildSystemPromptV4(
      inputFor({
        knowledge_answers: {
          promos: "Кератин + стрижка = -1000 сом",
        },
      }),
    );
    expect(p).toContain("ФАКТЫ О БИЗНЕСЕ");
    expect(p).toContain("Кератин + стрижка");
  });
});
