// Sales layer of the virtual administrator: objection detection, the anti-nag governor, and
// the conditional prompt block. Everything here is pure, so these are real assertions about
// behaviour rather than mocks of a model.
//
// Run: bun test sales-playbook.test.ts
import { test, expect, describe } from "bun:test";
import {
  activePromos,
  classifyFunnelStage,
  classifyReadiness,
  CLOSE_ATTEMPT_LIMIT,
  detectCloseAttempt,
  detectObjections,
  hasSchedulingSignal,
  EMPTY_SALES_STATE,
  nextSalesState,
  parseSalesPlaybook,
  parseSalesStyle,
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
  style: "light",
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
    stage: "consulting",
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
    style: "light",
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

// ---------------------------------------------------------------------------
// Sales styles
// ---------------------------------------------------------------------------

// Regression suite for the prod conversation of 2026-08-12 16:00 UTC (Тунукай эже, Instagram):
// four assistant messages in a row, each ending in «подберём удобное время?», closeAttempts
// stuck at 0, and «ну не знаю» / «а это окупится?» matching no objection at all.
describe("prod 2026-08-12: the assistant that only wanted to book", () => {
  test("a verbal close is counted, not just a tool-driven one", () => {
    expect(detectCloseAttempt("Что скажете, подберём удобное время? 😊")).toBe(true);
    expect(detectCloseAttempt("Хотите записаться на первичную консультацию?")).toBe(true);
    expect(detectCloseAttempt("На какой день Вам удобно?")).toBe(true);
    expect(detectCloseAttempt("Давайте запишу вас к Тунукай эже")).toBe(true);
    expect(detectCloseAttempt("Качан ынгайлуу?")).toBe(true);
  });

  test("an ordinary informative reply is not a close", () => {
    // A false positive costs a turn of restraint, so the matcher may be generous — but not
    // so generous that answering a question counts as pushing.
    expect(detectCloseAttempt("Консультация длится 30 минут и стоит 7 000 сом.")).toBe(false);
    expect(detectCloseAttempt("Список анализов врач определяет после осмотра.")).toBe(false);
    expect(detectCloseAttempt("")).toBe(false);
  });

  test("four verbal closes now arm the stop rule (previously stayed at 0)", () => {
    let s = EMPTY_SALES_STATE;
    const turn = {
      objections: [] as ObjectionKind[],
      progressed: false,
      pushedToClose: detectCloseAttempt("Что скажете, подберём удобное время?"),
      showedSlots: false,
    };
    s = nextSalesState(s, turn);
    expect(s.closeAttempts).toBe(1);
    s = nextSalesState(s, turn);
    expect(s.closeAttempts).toBeGreaterThanOrEqual(CLOSE_ATTEMPT_LIMIT);
  });

  test("one unanswered close already brakes the next message", () => {
    const out = block({ state: { ...EMPTY_SALES_STATE, closeAttempts: 1 } });
    expect(out).toMatch(/ТЫ УЖЕ ЗВАЛ ЗАПИСАТЬСЯ/);
    expect(out).toMatch(/Не повторяй призыв/);
  });

  test("«ну не знаю» and «а это окупится?» are recognised as a value doubt", () => {
    expect(detectObjections("ну не знаю")).toContain("value_doubt");
    expect(detectObjections("а это окупится?")).toContain("value_doubt");
    expect(detectObjections("стоит ли оно того")).toContain("value_doubt");
    expect(detectObjections("сомневаюсь честно говоря")).toContain("value_doubt");
    expect(detectObjections("is it worth it?")).toContain("value_doubt");
  });

  test("the value-doubt play bans the empty phrases the model actually used", () => {
    const out = block({
      objections: ["value_doubt"],
      clientText: "а это окупится?",
      stage: "objection",
    });
    expect(out).toContain("СОМНЕНИЕ В СМЫСЛЕ");
    expect(out).toMatch(/что он уже пробовал/);
    expect(out).toMatch(/инвестиция в себя/); // named as forbidden, not as advice
  });

  test("invented social proof is banned in both styles", () => {
    for (const style of ["light", "active"] as const) {
      const out = block({ playbook: { ...EMPTY_PLAYBOOK, style } });
      expect(out).toMatch(/многие наши клиенты/i);
      expect(out).toMatch(/ЗАПРЕЩЕНЫ, если этого дословно нет в фактах салона/);
    }
  });
});

describe("sales style resolution", () => {
  test("the column wins when it holds a known style", () => {
    expect(parseSalesStyle("active")).toBe("active");
    expect(parseSalesStyle("light")).toBe("light");
  });

  test("legacy sales_mode is honoured when sales_style is absent", () => {
    // Salons configured before migration 20260812150000 have only the boolean. Reading it as
    // "no style set → light" would quietly turn off a mode the owner deliberately enabled.
    expect(parseSalesStyle(null, true)).toBe("active");
    expect(parseSalesStyle(undefined, false)).toBe("light");
    expect(parseSalesPlaybook({ sales_mode: true }).style).toBe("active");
  });

  test("anything unrecognised degrades to light, never to active", () => {
    // The safe failure direction: a typo must not make a salon's assistant pushy.
    expect(parseSalesStyle("ACTIVE")).toBe("light");
    expect(parseSalesStyle("агрессивный")).toBe("light");
    expect(parseSalesStyle(1)).toBe("light");
    expect(parseSalesPlaybook({}).style).toBe("light");
  });

  test("an explicit light overrides a stale legacy true", () => {
    // The admin panel writes both columns, but a salon switched active → light between
    // deploys could still carry sales_mode=true. The new column is the source of truth.
    expect(parseSalesStyle("light", true)).toBe("light");
  });
});

describe("what actually differs between the two styles", () => {
  const light = (over = {}) => block({ playbook: { ...EMPTY_PLAYBOOK, style: "light" }, ...over });
  const active = (over = {}) => block({ playbook: { ...EMPTY_PLAYBOOK, style: "active" }, ...over });

  test("each style renders its own doctrine and only its own", () => {
    expect(light()).toContain("СТИЛЬ ПРОДАЖ: ЛЁГКИЕ ПРОДАЖИ");
    expect(light()).not.toContain("СТИЛЬ ПРОДАЖ: АКТИВНЫЕ ПРОДАЖИ");
    expect(active()).toContain("СТИЛЬ ПРОДАЖ: АКТИВНЫЕ ПРОДАЖИ");
    expect(active()).not.toContain("СТИЛЬ ПРОДАЖ: ЛЁГКИЕ ПРОДАЖИ");
  });

  test("active diagnoses the client; light does not", () => {
    expect(active()).toMatch(/ДИАГНОСТИКА/);
    expect(active()).toMatch(/чего он НЕ договаривает/);
    expect(light()).not.toMatch(/ДИАГНОСТИКА/);
  });

  test("on the consulting stage only active offers the next step itself", () => {
    expect(active()).toMatch(/сам предложи следующий шаг/i);
    expect(light()).toMatch(/только если человек сам показал/i);
  });

  test("objections: active returns to value and names one step, light hands back the decision", () => {
    const o = { objections: ["price" as const], clientText: "дорого", stage: "objection" as const };
    expect(active(o)).toMatch(/верни разговор к тому, что человек получит/i);
    expect(active(o)).toMatch(/предложи ОДИН логичный следующий шаг/);
    expect(light(o)).toMatch(/оставь решение за клиентом/i);
    expect(light(o)).not.toMatch(/верни разговор к тому, что человек получит/i);
    // The objection play itself is shared — the mode changes the landing, not the analysis.
    expect(active(o)).toContain("ВОЗРАЖЕНИЕ «ДОРОГО»");
    expect(light(o)).toContain("ВОЗРАЖЕНИЕ «ДОРОГО»");
  });

  test("prepayment framing is active-only, and never invents a prepayment", () => {
    expect(active()).toContain("ПРЕДОПЛАТА (если она есть в этом салоне)");
    expect(active()).toMatch(/Не выдумывай предоплату/);
    expect(light()).not.toContain("ПРЕДОПЛАТА (если она есть в этом салоне)");
  });

  test("USP is proactive in active mode, trust-gated in light", () => {
    const usp = ["Работаем 8 лет"];
    const idle = { objections: [], clientText: "во сколько вы работаете?" };
    expect(block({ playbook: { ...EMPTY_PLAYBOOK, usp, style: "active" }, ...idle })).toContain(
      "Работаем 8 лет",
    );
    expect(block({ playbook: { ...EMPTY_PLAYBOOK, usp, style: "light" }, ...idle })).not.toContain(
      "Работаем 8 лет",
    );
  });

  test("neither style may invent facts, and active says so out loud", () => {
    expect(active()).toMatch(/только реальные, из инструментов и фактов салона/i);
    expect(active()).toMatch(/Запугивание и выдуманные последствия ЗАПРЕЩЕНЫ/);
    expect(active()).toMatch(/выдумывать дефицит и срочность/);
  });

  test("the anti-nag stop rule outranks the active style", () => {
    // The governor is not a mode setting. An active-mode assistant that has already pushed
    // twice is still forbidden from pushing again — otherwise the mode becomes the nagging
    // the whole layer exists to prevent.
    const out = active({
      state: { ...EMPTY_SALES_STATE, closeAttempts: CLOSE_ATTEMPT_LIMIT },
      readiness: "exploring" as const,
    });
    expect(out).toContain("СТОП-ПРАВИЛО НАВЯЗЧИВОСТИ");
    expect(out).toMatch(/предлагать запись.*ЗАПРЕЩЕНО/is);
  });

  test("the booked stage still forbids re-selling in active mode", () => {
    const out = active({ stage: "booked" as const });
    expect(out).toMatch(/УЖЕ ЕСТЬ подтверждённая запись/);
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

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

const FACTS = {
  hasUpcomingAppointment: false,
  awaitingPrepayment: false,
  serviceChosen: false,
  turnCount: 3,
};

describe("funnel stage", () => {
  test("first contact is a new lead", () => {
    expect(classifyFunnelStage({ ...FACTS, turnCount: 0 }, [], "exploring", false)).toBe(
      "new_lead",
    );
  });

  test("talking but no service settled is discovery", () => {
    expect(classifyFunnelStage(FACTS, [], "exploring", false)).toBe("discovery");
  });

  test("a chosen service moves us to consulting", () => {
    expect(classifyFunnelStage({ ...FACTS, serviceChosen: true }, [], "exploring", false)).toBe(
      "consulting",
    );
  });

  test("an objection outranks a chosen service", () => {
    expect(
      classifyFunnelStage({ ...FACTS, serviceChosen: true }, ["price"], "objecting", false),
    ).toBe("objection");
  });

  test("engaging with WHEN moves us to offering a booking, even without the word «запись»", () => {
    expect(classifyFunnelStage(FACTS, [], "exploring", true)).toBe("offer_booking");
    expect(classifyFunnelStage(FACTS, [], "ready", false)).toBe("offer_booking");
  });

  test("an open prepayment hold outranks everything, including a live objection", () => {
    // Interrupting a payment in flight to argue about price is the worst possible move.
    expect(
      classifyFunnelStage({ ...FACTS, awaitingPrepayment: true }, ["price"], "objecting", true),
    ).toBe("prepayment");
  });

  test("an existing upcoming appointment outranks a booking signal", () => {
    // The regression this guards: asking «на какой день вам удобно?» of someone already booked.
    expect(
      classifyFunnelStage({ ...FACTS, hasUpcomingAppointment: true }, [], "ready", true),
    ).toBe("booked");
  });
});

describe("stage block in the rendered prompt", () => {
  test("a booked client gets an explicit ban on re-offering a booking", () => {
    const p = block({ stage: "booked" });
    expect(p).toContain("УЖЕ ЕСТЬ подтверждённая запись");
    expect(p).toContain("ЗАПРЕЩЕНО");
  });

  test("a new lead is told not to dump the price list", () => {
    const p = block({ stage: "new_lead" });
    expect(p).toContain("НЕ вываливай прайс");
  });

  test("every stage ends on exactly one next step", () => {
    const stages = [
      "new_lead",
      "discovery",
      "consulting",
      "objection",
      "offer_booking",
      "prepayment",
      "booked",
    ] as const;
    for (const stage of stages) {
      const p = block({ stage });
      expect(p).toContain("СЛЕДУЮЩИЙ ШАГ:");
      expect(p.split("СЛЕДУЮЩИЙ ШАГ:").length - 1).toBe(1);
    }
  });

  test("the stage block leads the sales section", () => {
    const p = block({ stage: "objection", objections: ["price"] });
    expect(p.indexOf("ЭТАП РАЗГОВОРА")).toBeLessThan(p.indexOf("ВОЗРАЖЕНИЕ «ДОРОГО»"));
  });
});

describe("anti-repetition", () => {
  const prev = "Подскажите, на какой день вам удобно записаться?";

  test("is injected once the assistant has already pushed and stalled", () => {
    const p = block({
      stage: "consulting",
      state: { ...EMPTY_SALES_STATE, closeAttempts: 1 },
      lastAssistantReply: prev,
    });
    expect(p).toContain("НЕ ПОВТОРЯЙСЯ");
    expect(p).toContain(prev);
  });

  test("is injected while an objection is on the table", () => {
    const p = block({ stage: "objection", objections: ["think"], lastAssistantReply: prev });
    expect(p).toContain("НЕ ПОВТОРЯЙСЯ");
  });

  test("costs nothing on a healthy conversation", () => {
    // No stalled close, no objection → not worth the tokens.
    const p = block({ stage: "consulting", lastAssistantReply: prev });
    expect(p).not.toContain("НЕ ПОВТОРЯЙСЯ");
  });

  test("truncates a long previous reply rather than doubling the prompt", () => {
    const long = "а".repeat(2000);
    const p = block({ stage: "objection", objections: ["price"], lastAssistantReply: long });
    expect(p).not.toContain("а".repeat(400));
  });
});
