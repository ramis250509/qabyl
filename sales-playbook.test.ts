// Sales layer of the virtual administrator: objection detection, the anti-nag governor, and
// the conditional prompt block. Everything here is pure, so these are real assertions about
// behaviour rather than mocks of a model.
//
// Run: bun test sales-playbook.test.ts
import { test, expect, describe } from "bun:test";
import {
  activePromos,
  classifyReadiness,
  CLOSE_ATTEMPT_LIMIT,
  detectObjections,
  hasSchedulingSignal,
  EMPTY_SALES_STATE,
  nextSalesState,
  parseSalesPlaybook,
  readSalesState,
  renderSalesBlock,
  type SalesPlaybookConfig,
} from "@/lib/sales-playbook.server";
import { buildSystemPromptV4 } from "@/lib/wa-agent-v4.server";
import { bookingUrl } from "@/lib/booking-link";

const SN = { nomSg: "мастер", genSg: "мастера", datSg: "мастеру" };

const EMPTY_PLAYBOOK: SalesPlaybookConfig = {
  usp: [],
  objections: [],
  promos: [],
  bookingLinkMode: "auto",
  salesMode: false,
};

function block(over: Partial<Parameters<typeof renderSalesBlock>[0]> = {}) {
  return renderSalesBlock({
    playbook: EMPTY_PLAYBOOK,
    objections: [],
    readiness: "exploring",
    state: EMPTY_SALES_STATE,
    sn: SN,
    todayIso: "2026-08-10",
    hasBookingLink: true,
    clientText: "",
    ...over,
  });
}

describe("objection detection", () => {
  test("recognises price objections in all three languages", () => {
    expect(detectObjections("ой это дорого для меня")).toContain("price");
    expect(detectObjections("кымбат экен")).toContain("price");
    expect(detectObjections("that's too much honestly")).toContain("price");
    expect(detectObjections("а подешевле вариант есть?")).toContain("price");
  });

  test("recognises the soft brush-offs that actually kill conversions", () => {
    expect(detectObjections("я подумаю, спасибо")).toContain("think");
    expect(detectObjections("ойлонуп көрөйүн")).toContain("think");
    expect(detectObjections("потом напишу")).toContain("later");
    expect(detectObjections("кийин жазам")).toContain("later");
  });

  test("recognises fear and result doubt separately — they get different plays", () => {
    expect(detectObjections("а это не вредно для волос?")).toContain("fear");
    expect(detectObjections("боюсь что испортите")).toContain("fear");
    expect(detectObjections("а сколько держится результат?")).toContain("result_doubt");
    expect(detectObjections("а если не получится?")).toContain("result_doubt");
  });

  test("competitor comparison outranks the plain price read", () => {
    // "в другом салоне дешевле" is both — the competitor play is the useful one, so it
    // must come first and be the one the renderer picks.
    const kinds = detectObjections("в другом салоне дешевле предлагали");
    expect(kinds[0]).toBe("competitor");
    expect(kinds).toContain("price");
  });

  test("a plain question is not an objection", () => {
    expect(detectObjections("здравствуйте, сколько стоит маникюр?")).toEqual([]);
    expect(detectObjections("")).toEqual([]);
  });
});

describe("readiness", () => {
  test("explicit booking intent reads as ready", () => {
    expect(classifyReadiness("хочу записаться на завтра", [])).toBe("ready");
    expect(classifyReadiness("эртеңке жазып койсоңуз", [])).toBe("ready");
  });

  // The real trap: "запишите, но дорого же" is an objection to answer, not a green light.
  test("an objection beats booking wording", () => {
    expect(classifyReadiness("запишите, но дорого же", ["price"])).toBe("objecting");
  });
});

describe("anti-nag governor", () => {
  test("counts only fruitless pushes", () => {
    let s = EMPTY_SALES_STATE;
    s = nextSalesState(s, {
      objections: [],
      progressed: false,
      pushedToClose: true,
      showedSlots: true,
    });
    expect(s.closeAttempts).toBe(1);
    s = nextSalesState(s, {
      objections: [],
      progressed: false,
      pushedToClose: true,
      showedSlots: true,
    });
    expect(s.closeAttempts).toBe(CLOSE_ATTEMPT_LIMIT);
  });

  test("any forward move by the client resets the counter", () => {
    const pushed = nextSalesState(EMPTY_SALES_STATE, {
      objections: [],
      progressed: false,
      pushedToClose: true,
      showedSlots: true,
    });
    const moved = nextSalesState(pushed, {
      objections: [],
      progressed: true,
      pushedToClose: true,
      showedSlots: false,
    });
    expect(moved.closeAttempts).toBe(0);
  });

  test("a turn with no push does not accumulate pressure", () => {
    const s = nextSalesState(EMPTY_SALES_STATE, {
      objections: ["fear"],
      progressed: false,
      pushedToClose: false,
      showedSlots: false,
    });
    expect(s.closeAttempts).toBe(0);
    expect(s.handled).toContain("fear");
  });

  test("at the limit the prompt forbids closing entirely", () => {
    const out = block({ state: { ...EMPTY_SALES_STATE, closeAttempts: CLOSE_ATTEMPT_LIMIT } });
    expect(out).toContain("СТОП-ПРАВИЛО НАВЯЗЧИВОСТИ");
    expect(out).toContain("ЗАПРЕЩЕНО");
    // And it must NOT simultaneously tell the model the client is ready to book.
    expect(out).not.toContain("КЛИЕНТ ГОТОВ");
  });

  // The bug this catches is worse than the one the governor fixes: a client happily
  // browsing days («а в пятницу?» … «а вечером?») never says "запишите", so without a
  // scheduling signal every one of those turns would count as a fruitless push — and the
  // stop rule would forbid offering times to someone who is asking for times.
  test("a client picking through days is progress, not deflection", () => {
    for (const t of [
      "а в пятницу?",
      "можно вечером?",
      "давайте на 17:00",
      "эртең болобу?",
      "на 25 августа",
      "а попозже есть?",
      "tomorrow morning?",
    ]) {
      expect(hasSchedulingSignal(t)).toBe(true);
    }
  });

  test("a deflection carries no scheduling signal", () => {
    for (const t of ["дорого", "я подумаю", "а какие материалы вы используете?", ""]) {
      expect(hasSchedulingSignal(t)).toBe(false);
    }
  });

  test("browsing days keeps the counter at zero across many turns", () => {
    let s = EMPTY_SALES_STATE;
    for (let i = 0; i < 5; i++) {
      s = nextSalesState(s, {
        objections: [],
        progressed: hasSchedulingSignal("а в пятницу вечером?"),
        pushedToClose: true,
        showedSlots: true,
      });
    }
    expect(s.closeAttempts).toBe(0);
    // …while the slot-round count still climbs, which is what unlocks the booking link.
    expect(s.slotRounds).toBe(5);
  });

  // The stop rule must never outrank an explicit request. A client who deflected twice and
  // then writes «хорошо, записывайте» is the most valuable message in the conversation; a
  // governor that gagged the assistant there would lose the sale it was built to protect.
  test("an explicit «записывайте» overrides the stop rule", () => {
    const out = block({
      readiness: "ready",
      state: { ...EMPTY_SALES_STATE, closeAttempts: CLOSE_ATTEMPT_LIMIT + 3 },
    });
    expect(out).toContain("КЛИЕНТ ГОТОВ");
    expect(out).not.toContain("СТОП-ПРАВИЛО НАВЯЗЧИВОСТИ");
  });

  test("readSalesState survives a conversation that predates the feature", () => {
    expect(readSalesState(undefined)).toEqual(EMPTY_SALES_STATE);
    expect(readSalesState({ closeAttempts: "нет", handled: "oops" })).toEqual(EMPTY_SALES_STATE);
    // Unknown objection kinds from a hand-edited row are dropped, not trusted.
    expect(readSalesState({ handled: ["price", "nonsense"] }).handled).toEqual(["price"]);
  });
});

describe("prompt block is conditional", () => {
  // The whole point of computing this instead of prompting for it: a salon with no playbook
  // and a client with no objection must not pay tokens for any objection-handling copy.
  test("no objection and no playbook → no objection copy", () => {
    const out = block();
    expect(out).not.toContain("ВОЗРАЖЕНИЕ «ДОРОГО»");
    expect(out).not.toContain("СТРАХ ПРОЦЕДУРЫ");
  });

  test("only the objection that fired is injected", () => {
    const out = block({ objections: ["price"], readiness: "objecting", clientText: "дорого" });
    expect(out).toContain("ВОЗРАЖЕНИЕ «ДОРОГО»");
    expect(out).not.toContain("СТРАХ ПРОЦЕДУРЫ");
    expect(out).not.toContain("СРАВНЕНИЕ С КОНКУРЕНТОМ");
  });

  test("every play forbids inventing benefits the owner never gave", () => {
    for (const kind of ["price", "why_you", "result_doubt"] as const) {
      const out = block({ objections: [kind], readiness: "objecting" });
      expect(out).toMatch(/ЗАПРЕЩЕНО|НЕ выдумывай|не выдумывай/);
    }
  });

  test("repeating an already-handled objection triggers the do-not-repeat rule", () => {
    const out = block({
      objections: ["think"],
      readiness: "objecting",
      state: { ...EMPTY_SALES_STATE, handled: ["think"] },
    });
    expect(out).toContain("УЖЕ звучало");
  });
});

describe("owner-configured facts", () => {
  const playbook: SalesPlaybookConfig = {
    usp: ["Работаем 8 лет, все мастера с сертификатами"],
    objections: [{ trigger: "дорого", answer: "В цену входит уход и укладка" }],
    promos: [{ title: "Кератин + стрижка", details: "стрижка в подарок", until: "2026-12-31" }],
    bookingLinkMode: "auto",
    salesMode: false,
  };

  test("the owner's own answer is injected and marked as outranking the generic play", () => {
    const out = block({ playbook, objections: ["price"], clientText: "это дорого" });
    expect(out).toContain("В цену входит уход и укладка");
    expect(out).toContain("прав владелец");
  });

  test("owner triggers also match by category, not only by literal substring", () => {
    // The client wrote "кымбат", the owner wrote "дорого" — same objection kind, so the
    // owner's answer must still fire. Matching only on substring would miss every
    // Kyrgyz-speaking client of a Russian-writing owner.
    const out = block({ playbook, objections: ["price"], clientText: "кымбат го" });
    expect(out).toContain("В цену входит уход и укладка");
  });

  test("USP appears for trust questions but not for ordinary chatter", () => {
    const trust = block({ playbook, objections: ["why_you"], clientText: "а почему именно вы?" });
    expect(trust).toContain("Работаем 8 лет");
    const idle = block({ playbook, objections: [], clientText: "во сколько вы работаете?" });
    expect(idle).not.toContain("Работаем 8 лет");
  });

  test("an expired promo is never quoted", () => {
    const dead = [{ title: "Старая акция", until: "2026-01-01" }];
    expect(activePromos(dead, "2026-08-10")).toHaveLength(0);
    expect(activePromos(dead, "2025-12-31")).toHaveLength(1);
    // No end date = open-ended, keep it.
    expect(activePromos([{ title: "Бессрочная" }], "2026-08-10")).toHaveLength(1);
  });

  test("live promos are pushed proactively, invented ones are banned", () => {
    const out = block({ playbook });
    expect(out).toContain("Кератин + стрижка");
    expect(out).toContain("ЗАПРЕЩЕНО");
  });
});

describe("parseSalesPlaybook tolerance", () => {
  // A salon row that predates the migration, or one hand-edited into the wrong shape, must
  // degrade to "no playbook" — never throw inside a live conversation.
  test("garbage in, empty playbook out", () => {
    expect(parseSalesPlaybook({}).usp).toEqual([]);
    expect(parseSalesPlaybook({ sales_usp: { not: "an array" } }).usp).toEqual([]);
    expect(parseSalesPlaybook({ sales_objections: null }).objections).toEqual([]);
  });

  test("a JSON string round-trips (some clients store jsonb as text)", () => {
    expect(parseSalesPlaybook({ sales_usp: '["8 лет на рынке"]' }).usp).toEqual(["8 лет на рынке"]);
  });

  test("half-filled objection rows are dropped rather than rendered as dangling text", () => {
    const p = parseSalesPlaybook({
      sales_objections: [
        { trigger: "дорого" },
        { trigger: "", answer: "x" },
        { trigger: "a", answer: "b" },
      ],
    });
    expect(p.objections).toEqual([{ trigger: "a", answer: "b" }]);
  });

  test("booking_link_mode falls back to auto for anything unexpected", () => {
    expect(parseSalesPlaybook({ booking_link_mode: "eager" }).bookingLinkMode).toBe("eager");
    expect(parseSalesPlaybook({ booking_link_mode: "off" }).bookingLinkMode).toBe("off");
    expect(parseSalesPlaybook({ booking_link_mode: "нет" }).bookingLinkMode).toBe("auto");
  });
});

describe("booking-link policy in the prompt", () => {
  test("a salon with the link switched off gets no link instructions at all", () => {
    const out = block({ playbook: { ...EMPTY_PLAYBOOK, bookingLinkMode: "off" } });
    expect(out).not.toContain("send_booking_link");
  });

  test("a salon with no public page gets no link instructions either", () => {
    expect(block({ hasBookingLink: false })).not.toContain("send_booking_link");
  });

  test("the default policy is explicitly NOT «send it to everyone»", () => {
    const out = block();
    expect(out).toContain("send_booking_link");
    expect(out).toContain("НЕ всем подряд");
  });
});

describe("bookingUrl", () => {
  test("custom domain wins over the platform slug", () => {
    expect(bookingUrl({ slug: "salon", custom_domain: "zapis.salon.kg" })).toBe(
      "https://zapis.salon.kg/",
    );
  });
  test("falls back to the platform URL", () => {
    expect(bookingUrl({ slug: "salon", custom_domain: null })).toBe("https://qabyl.com/book/salon");
  });
  test("no slug and no domain means there is no link to send", () => {
    expect(bookingUrl({ slug: null, custom_domain: null })).toBeNull();
    expect(bookingUrl({ slug: "   ", custom_domain: null })).toBeNull();
  });
});

describe("system prompt integration", () => {
  const input = {
    salon: { salonId: "s1", salonName: "Тест", timezone: "Asia/Bishkek" },
    config: { industry: "beauty", languages: ["ru"], manage_cutoff_hours: 0 },
    branches: [],
    salonInfo: { working_hours: null, address: null },
    stateData: {},
  } as any;

  test("the sales block lands in the prompt, above the owner's override section", () => {
    const sales = block({ objections: ["price"], readiness: "objecting" });
    const prompt = buildSystemPromptV4(
      { ...input, config: { ...input.config, ai_rules: "Всегда предлагай кофе" } },
      [],
      "",
      "ru",
      "",
      sales,
    );
    expect(prompt).toContain("ВОЗРАЖЕНИЕ «ДОРОГО»");
    // Owner rules must still be the last word.
    expect(prompt.indexOf("ВОЗРАЖЕНИЕ «ДОРОГО»")).toBeLessThan(
      prompt.indexOf("Всегда предлагай кофе"),
    );
  });

  test("callers that pass no sales block keep the exact previous prompt", () => {
    // Guards the rollout: every existing caller and test uses the 5-arg form.
    expect(buildSystemPromptV4(input, [], "", "ru", "")).toBe(
      buildSystemPromptV4(input, [], "", "ru", "", ""),
    );
  });

  test("entry context from a comment trigger reaches the prompt", () => {
    const prompt = buildSystemPromptV4(
      { ...input, stateData: { entry_context: "Пришёл с поста про кератин" } },
      [],
      "",
      "ru",
      "",
    );
    expect(prompt).toContain("ОТКУДА ПРИШЁЛ ЭТОТ КЛИЕНТ");
    expect(prompt).toContain("Пришёл с поста про кератин");
  });
});
