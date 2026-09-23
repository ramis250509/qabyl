// AI Assistant Quality Test — runner.
//
//   bun run qa:assistant                          # full library
//   bun run qa:assistant --filter=B0              # by id prefix / category / tag substring
//   bun run qa:assistant --concurrency=4 --repeat=2
//   bun run qa:assistant --no-judge               # deterministic checks only (still needs the model key)
//   bun run qa:assistant --list
//
// Needs GEMINI_API_KEY (the assistant itself runs on real Gemini). Never touches the real database.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimWorld, ClientSession, DEFAULT_SALON, type SalonHandle, type Row } from "./world";
import { SCENARIOS, type Scenario, type ScenarioCtx } from "./scenarios";
import { runAssertions, describeAppt, type AssertionResult, type Expectations } from "./assertions";
import { nextCustomerMove, normalizeCustomerMove, type TranscriptLine } from "./customer";
import { judgeConversation, averageScore, type Verdict } from "./evaluator";
import { localDateOf, localTimeOf } from "./fake-db";

// ─── args ─────────────────────────────────────────────────────────────────────────────────────
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  }),
);
const filter = args.get("filter");
const concurrency = Number(args.get("concurrency") ?? 3);
const repeat = Number(args.get("repeat") ?? 1);
const useJudge = args.get("no-judge") !== "true";

const selected = SCENARIOS.filter(
  (s) =>
    !filter ||
    filter
      .split(",")
      .some(
        (f) =>
          s.id.startsWith(f) || s.category === f || (s.tags ?? []).includes(f) || s.id.includes(f),
      ),
);

if (args.get("list") === "true") {
  for (const s of selected) console.log(`${s.id.padEnd(36)} ${s.category.padEnd(12)} ${s.title}`);
  process.exit(0);
}
if (!process.env.GEMINI_API_KEY) {
  console.error(
    "GEMINI_API_KEY не задан: ассистент работает на настоящем Gemini, без ключа прогон невозможен.",
  );
  process.exit(2);
}

// ─── проверка квоты до старта ─────────────────────────────────────────────────────────────────
//
// ЗАЧЕМ. 17.09.2026 прогон на бесплатном ключе крутился 24 минуты и выдал пустой отчёт: все 78
// сценариев упали с 429, каждый потратив по 36 секунд на повторы. Один запрос перед стартом
// отвечает на тот же вопрос за секунду.
//
// ГЛАВНОЕ ПРО БЕСПЛАТНЫЙ ТИР. Там не «мало запросов в минуту», а лимит
// GenerateRequestsPerDayPerProjectPerModel — порядка 20 запросов В СУТКИ на модель. Один сценарий
// съедает ~15 вызовов, то есть бесплатного ключа хватает примерно на ОДИН сценарий в день.
// Полный прогон на нём невозможен в принципе, и лучше узнать это до, а не после.
{
  const model = process.env.SIM_CUSTOMER_MODEL ?? "gemini-flash-latest";
  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ок" }] }] }),
      signal: AbortSignal.timeout(30_000),
    },
  ).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e) }) as any);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const perDay = /PerDay|RequestsPerDay/i.test(body);
    console.error(
      `\nПрогон не начат: модель ${model} ответила ${res.status}.\n` +
        (perDay
          ? "Это СУТОЧНАЯ квота бесплатного тира (порядка 20 запросов на модель в день), а одному\n" +
            "сценарию нужно ~15. Полный прогон на бесплатном ключе невозможен: нужен платный ключ\n" +
            "либо запуск одного-двух сценариев через --filter.\n"
          : `${body.slice(0, 300)}\n`),
    );
    process.exit(2);
  }
}

// ─── world + fault-injecting fetch ────────────────────────────────────────────────────────────
const world = new SimWorld();
(globalThis as any).__QABYL_SIM_DB__ = world.db;

type ScenarioStore = { geminiFailures: number };
const als = new AsyncLocalStorage<ScenarioStore>();
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const store = als.getStore();
  if (
    store &&
    store.geminiFailures > 0 &&
    url.includes("generativelanguage.googleapis.com") &&
    url.includes(":generateContent")
  ) {
    store.geminiFailures--;
    return new Response(
      JSON.stringify({ error: { code: 503, message: "simulated: model overloaded" } }),
      { status: 503 },
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

const { processWaCloudPayload } = await import("@/routes/api/public/wacloud.$salonId");

// ─── one scenario ─────────────────────────────────────────────────────────────────────────────
type ConversationRecord = {
  phone: string;
  persona: string;
  transcript: Array<
    TranscriptLine & { tools?: string[]; errors?: string[]; toolTrace?: unknown[] }
  >;
  endStatus: string;
  lostInbound: number;
  assertions: AssertionResult[];
};

export type ScenarioResult = {
  scenario: Pick<Scenario, "id" | "title" | "category" | "tags" | "regression">;
  run: number;
  passed: boolean;
  severity: "critical" | "high" | "medium" | "low" | "none";
  expected: string;
  conversations: ConversationRecord[];
  verdict: Verdict | null;
  db: { appointments: unknown[] };
  logs: { toolErrors: string[]; errorLogs: unknown[]; dbErrors: unknown[] };
  probableRootCauses: string[];
  failures: string[];
  durationMs: number;
  error?: string;
};

function randomPhone() {
  return `99670${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
}

function groundTruth(h: SalonHandle, salonRows: { masters: Row[]; services: Row[] }) {
  const db = world.db;
  return {
    today: h.localDate(0),
    timezone: h.tz,
    salon: { name: h.spec.name, address: h.spec.address, hours: h.spec.workingHoursText },
    branches: h.spec.branches,
    services: salonRows.services.map((s) => ({
      name: s.name,
      price: s.price_type === "range" ? `${s.price}–${s.price_max} сом` : `${s.price} сом`,
      duration_min: s.duration_min,
      buffer_after_min: s.buffer_after_min,
    })),
    masters: salonRows.masters.map((m) => ({
      name: m.name,
      branch: h.branchName(m.branch_id),
      services: db
        .table("master_services")
        .filter((ms) => ms.master_id === m.id)
        .map((ms) => h.serviceName(ms.service_id)),
      schedule: db
        .table("master_schedules")
        .filter((s) => s.master_id === m.id)
        .slice(0, 1)
        .map((s) => `${String(s.start_time).slice(0, 5)}–${String(s.end_time).slice(0, 5)}`)[0],
      days_off: db
        .table("master_day_overrides")
        .filter((o) => o.master_id === m.id && (o.is_off || o.kind === "off"))
        .map((o) => o.date),
    })),
  };
}

async function converse(
  sc: { persona: Scenario["persona"]; goal: string; opener?: string[]; script?: string[][] },
  base: Scenario,
  ctx: ScenarioCtx,
  session: ClientSession,
): Promise<{ transcript: ConversationRecord["transcript"]; endStatus: string; lost: number }> {
  const transcript: ConversationRecord["transcript"] = [];
  const maxTurns = base.maxTurns ?? 8;
  const todayHuman = new Intl.DateTimeFormat("ru-RU", {
    timeZone: ctx.salon.tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  let lost = 0;
  let endStatus = "max_turns";
  let messages: string[] =
    sc.script?.[0] ??
    sc.opener ??
    (
      await nextCustomerMove({
        persona: sc.persona,
        goal: sc.goal,
        todayHuman,
        transcript,
        turn: 0,
        maxTurns,
      })
    ).messages;

  for (let turn = 0; turn < maxTurns; turn++) {
    await base.beforeTurn?.(ctx, turn, session);
    for (const m of messages) transcript.push({ from: "client", text: m });
    const outBefore = new Set(world.db.table("wa_messages").map((r) => r.id));
    const res = await session.say(
      messages,
      turn === 0 || base.delivery?.duplicateDelivery
        ? base.delivery
        : { ...base.delivery, outOfOrder: false },
    );
    lost += res.lostInbound;
    const conv = world.conversationOf(ctx.salon, session.phone);
    const outRows = world.db
      .table("wa_messages")
      .filter(
        (r) =>
          !outBefore.has(r.id) &&
          r.conversation_id === conv?.id &&
          r.direction === "out" &&
          r.kind === "text",
      );
    const tools = outRows.flatMap((r) =>
      (r.meta?.actions ?? []).filter((a: string) => a.startsWith("tool:")),
    );
    const errors = outRows.flatMap((r) => r.meta?.errors ?? []);
    const toolTrace = outRows.flatMap((r) => r.meta?.tool_trace ?? []);
    if (res.replies.length === 0) {
      transcript.push({
        from: "system",
        text: conv?.ai_paused
          ? "ассистент на паузе (передано администратору), ответа нет"
          : "ассистент ничего не ответил",
      });
      if (conv?.ai_paused) {
        endStatus = "escalated";
        break;
      }
    }
    res.replies.forEach((text, i) =>
      transcript.push({
        from: "assistant",
        text,
        ...(i === res.replies.length - 1 ? { tools, errors, toolTrace } : {}),
      }),
    );
    if (res.reconciled)
      transcript.push({
        from: "system",
        text: `часть сообщений осталась необработанной (${res.lostInbound}) — подобрана перезапуском`,
      });

    if (sc.script) {
      const next = sc.script[turn + 1];
      if (!next) {
        endStatus = "script_done";
        break;
      }
      messages = next;
      continue;
    }
    const generatedMove = await nextCustomerMove({
      persona: sc.persona,
      goal: sc.goal,
      todayHuman,
      transcript,
      turn: turn + 1,
      maxTurns,
    });
    const move = normalizeCustomerMove(generatedMove, transcript, Boolean(base.expect.booking));
    if (move.status !== "continue") {
      endStatus = move.status;
      if (move.messages.length) {
        for (const m of move.messages) transcript.push({ from: "client", text: m });
        const tail = await session.say(move.messages);
        tail.replies.forEach((text) => transcript.push({ from: "assistant", text }));
        lost += tail.lostInbound;
      }
      break;
    }
    if (!move.messages.length) {
      endStatus = "client_silent";
      break;
    }
    messages = move.messages;
  }
  return { transcript, endStatus, lost };
}

async function runScenario(sc: Scenario, run: number): Promise<ScenarioResult> {
  const t0 = Date.now();
  const salon = world.createSalon(sc.salon ?? DEFAULT_SALON, { assistant: sc.assistant });
  const ctx: ScenarioCtx = { world, salon, phone: randomPhone() };
  const base: ScenarioResult = {
    scenario: {
      id: sc.id,
      title: sc.title,
      category: sc.category,
      tags: sc.tags,
      regression: sc.regression,
    },
    run,
    passed: false,
    severity: "none",
    expected: "",
    conversations: [],
    verdict: null,
    db: { appointments: [] },
    logs: { toolErrors: [], errorLogs: [], dbErrors: [] },
    probableRootCauses: [],
    failures: [],
    durationMs: 0,
  };
  const dbEventsFrom = world.db.events.length;
  try {
    sc.setup?.(ctx);
    const expect: Expectations = typeof sc.expect === "function" ? sc.expect(ctx) : sc.expect;
    base.expected = expect.describe;
    const before = structuredClone(world.appointmentsOf(salon));

    const participants = [
      {
        persona: sc.persona,
        goal: sc.goal,
        opener: sc.opener,
        script: sc.script,
        phone: ctx.phone,
      },
      ...(sc.race
        ? [
            {
              persona: sc.race.persona,
              goal: sc.race.goal,
              opener: sc.race.opener,
              script: undefined,
              phone: randomPhone(),
            },
          ]
        : []),
    ];
    const results = await Promise.all(
      participants.map((part) =>
        als.run({ geminiFailures: sc.geminiFailures ?? 0 }, async () => {
          const session = new ClientSession(
            world,
            salon,
            part.phone,
            part.persona.name,
            processWaCloudPayload,
          );
          const r = await converse(part, sc, { ...ctx, phone: part.phone }, session);
          return { part, ...r };
        }),
      ),
    );

    for (const r of results) {
      const assistantTexts = r.transcript.filter((l) => l.from === "assistant").map((l) => l.text);
      const clientTexts = r.transcript.filter((l) => l.from === "client").map((l) => l.text);
      const assertions = runAssertions({
        world,
        salon,
        phone: r.part.phone,
        before,
        clientTexts,
        assistantTexts,
        expect: sc.race ? { describe: expect.describe } : expect,
        lostInbound: r.lost,
      });
      base.conversations.push({
        phone: r.part.phone,
        persona: r.part.persona.name,
        transcript: r.transcript,
        endStatus: r.endStatus,
        lostInbound: r.lost,
        assertions,
      });
    }

    if (sc.race) {
      const tomorrow = salon.localDate(1);
      const atSlot = world
        .appointmentsOf(salon)
        .filter(
          (a) =>
            (a.status === "confirmed" || a.status === "pending_payment") &&
            participants.some(
              (pp) => pp.phone.slice(-9) === String(a.client_phone).replace(/\D/g, "").slice(-9),
            ),
        )
        .filter(
          (a) =>
            localDateOf(a.starts_at, salon.tz) === tomorrow &&
            localTimeOf(a.starts_at, salon.tz) === "18:00",
        );
      base.conversations[0].assertions.push({
        id: "race.exactly_one_winner",
        ok: atSlot.length === 1,
        severity: "critical",
        message:
          atSlot.length === 1
            ? "последний слот достался ровно одной клиентке"
            : `на последний слот записей: ${atSlot.length}`,
      });
    }

    const allAppts = world.appointmentsOf(salon);
    base.db.appointments = allAppts.map((a) => describeAppt(salon, a));
    base.logs.toolErrors = base.conversations.flatMap((c) =>
      c.transcript.flatMap((l) => l.errors ?? []),
    );
    base.logs.errorLogs = world.db
      .table("error_logs")
      .filter((e) => e.salon_id === salon.salonId)
      .map((e) => ({ level: e.level, source: e.source, message: e.message, context: e.context }));
    base.logs.dbErrors = world.db.events
      .slice(dbEventsFrom)
      .filter((e) => e.error)
      .slice(-30);

    if (useJudge) {
      const salonRows = {
        masters: world.db.table("masters").filter((m) => m.salon_id === salon.salonId),
        services: world.db.table("services").filter((s) => s.salon_id === salon.salonId),
      };
      const c = base.conversations[0];
      base.verdict = await judgeConversation({
        goal: sc.goal,
        expected: expect.describe,
        groundTruth: {
          ...groundTruth(salon, salonRows),
          existing_appointments_before: before.map((a) => describeAppt(salon, a)),
        },
        transcript: sc.race
          ? base.conversations.flatMap((cc) => [
              { from: "system" as const, text: `── разговор ${cc.persona} ──` },
              ...cc.transcript,
            ])
          : c.transcript,
        dbOutcome: { appointments_after: base.db.appointments },
        assertions: base.conversations.flatMap((cc) => cc.assertions),
      });
    }

    const failed = base.conversations.flatMap((c) =>
      c.assertions.filter((a) => !a.ok).map((a) => ({ ...a, persona: c.persona })),
    );
    const hard = failed.filter((a) => a.severity === "critical" || a.severity === "high");
    const v = base.verdict;
    const judgeFail = v
      ? !v.overall_pass || averageScore(v) < 3.5 || v.issues.some((i) => i.severity === "critical")
      : false;
    base.passed = hard.length === 0 && !judgeFail;
    base.failures = [
      ...failed.map((a) => `[${a.severity}] ${a.id}: ${a.message}`),
      ...(v
        ? v.issues
            .filter((i) => i.severity !== "low")
            .map((i) => `[${i.severity}] judge: ${i.title} — ${i.evidence}`)
        : []),
    ];
    base.probableRootCauses = [
      ...new Set([
        ...((v?.issues ?? []).map((i) => i.probable_root_cause).filter(Boolean) as string[]),
      ]),
    ];
    const sevs = [...failed.map((a) => a.severity), ...(v?.issues ?? []).map((i) => i.severity)];
    base.severity =
      (["critical", "high", "medium", "low"] as const).find((s) => sevs.includes(s)) ?? "none";
  } catch (e: any) {
    base.error = e?.stack ?? e?.message ?? String(e);
    base.failures.push(`[high] runner: ${e?.message ?? e}`);
    base.severity = "high";
  }
  base.durationMs = Date.now() - t0;
  return base;
}

// ─── orchestration ────────────────────────────────────────────────────────────────────────────
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const jobs = Array.from({ length: repeat }, (_, r) => selected.map((s) => ({ s, r }))).flat();
const parallel = jobs.filter((j) => !j.s.isolated);
const isolated = jobs.filter((j) => j.s.isolated);
console.log(
  `AI Assistant Quality Test: ${jobs.length} сценариев (${parallel.length} параллельно по ${concurrency}, ${isolated.length} изолированно)`,
);

const results: ScenarioResult[] = [];
const onDone = (r: ScenarioResult) => {
  console.log(
    `${r.passed ? "PASS" : "FAIL"} ${r.scenario.id}${repeat > 1 ? `#${r.run}` : ""} (${Math.round(r.durationMs / 1000)}s)${r.passed ? "" : ` — ${r.failures[0] ?? r.error ?? ""}`}`,
  );
  results.push(r);
};
await pool(parallel, concurrency, async (j) => onDone(await runScenario(j.s, j.r)));
for (const j of isolated) onDone(await runScenario(j.s, j.r));

// ─── report ───────────────────────────────────────────────────────────────────────────────────
const { writeReport } = await import("./report");
const outDir = join(import.meta.dir, "reports", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });
const summary = writeReport(results, outDir, { unknownRpcs: [...world.db.unknownRpcs] });
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log("\n" + summary);
console.log(`\nОтчёт: ${outDir}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
