// Deterministic checks. These decide pass/fail on facts; the LLM judge only adds quality on top.
//
// The rule that matters most: the database is the truth. «Вы записаны на 18:00» with no row, or
// with a row at 19:00, is a critical failure no matter how good the conversation sounded.

import { localDateOf, localTimeOf } from "./fake-db";
import type { Row, SalonHandle, SimWorld } from "./world";

export type Severity = "critical" | "high" | "medium" | "low";
export type AssertionResult = {
  id: string;
  ok: boolean;
  severity: Severity;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export type DateSpec = { daysFromToday: number } | { anyOfDaysFromToday: number[] };
export type TimeSpec = string | { from: string; to: string };

export type BookingExpectation = {
  service: string;
  master?: string | string[];
  date?: DateSpec;
  time?: TimeSpec;
  branch?: string;
  status?: "confirmed" | "pending_payment";
  /** How many NEW live bookings this client must end up with. Default 1. */
  count?: number;
};

export type Expectations = {
  booking?: BookingExpectation;
  /** No new booking may be created (information-only / declined / impossible requests). */
  noNewBooking?: boolean;
  /** Seeded appointment (by tag) must end up cancelled. */
  cancelledTag?: string;
  /** Seeded appointment (by tag) must NOT be cancelled or moved. */
  untouchedTags?: string[];
  /** Seeded appointment (by tag) must be moved to this. */
  rescheduled?: { tag: string; date?: DateSpec; time?: TimeSpec; master?: string | string[] };
  /** The conversation must be handed to a human. */
  escalated?: boolean;
  /** Free-text description of the right outcome, for the judge and the report. */
  describe: string;
};

const LIVE = (a: Row) => a.status === "confirmed" || a.status === "pending_payment";
const digits = (s: string) => String(s ?? "").replace(/\D/g, "");
const samePhone = (a: string, b: string) => digits(a).slice(-9) === digits(b).slice(-9);

function dateOk(h: SalonHandle, iso: string, spec?: DateSpec): boolean {
  if (!spec) return true;
  const d = localDateOf(iso, h.tz);
  const days = "daysFromToday" in spec ? [spec.daysFromToday] : spec.anyOfDaysFromToday;
  return days.some((n) => h.localDate(n) === d);
}
function timeOk(h: SalonHandle, iso: string, spec?: TimeSpec): boolean {
  if (!spec) return true;
  const t = localTimeOf(iso, h.tz);
  return typeof spec === "string" ? t === spec : t >= spec.from && t <= spec.to;
}
function oneOf(v: string, spec?: string | string[]) {
  if (!spec) return true;
  return (Array.isArray(spec) ? spec : [spec]).includes(v);
}

export function describeAppt(h: SalonHandle, a: Row) {
  return {
    service: h.serviceName(a.service_id),
    master: h.masterName(a.master_id),
    branch: h.branchName(a.branch_id),
    date: localDateOf(a.starts_at, h.tz),
    time: localTimeOf(a.starts_at, h.tz),
    ends: localTimeOf(a.ends_at, h.tz),
    status: a.status,
    source: a.source,
    client_name: a.client_name,
    price: a.price,
    tag: a.sim_tag ?? undefined,
  };
}

// «Вы записаны», «записала вас», «жазып койдум», «you're booked» — a claim that a booking exists.
const CLAIM_RE =
  /(вы\s+записаны|записал[аи]?\s+вас|записали\s+вас|запись\s+(создана|оформлена|подтверждена)|перен[её]с(ла|ли)?\s+(вашу\s+)?запись|запись\s+перенесена|жазылдыңыз|жазып\s+койдум|жаздым|you('|’)?re\s+booked|you\s+are\s+booked|booked\s+you)/i;
const CANCEL_CLAIM_RE =
  /(запись\s+отменен|отменил[аи]?\s+(вашу\s+)?запись|жокко\s+чыгардым|cancelled\s+your)/i;

// Female/male names common in KG that are NOT on any fixture's staff: a mention means an invented master.
const DECOY_NAMES = [
  "Айгерим",
  "Жанара",
  "Нургуль",
  "Асель",
  "Мадина",
  "Эльмира",
  "Гульнара",
  "Алина",
  "Камила",
  "Азамат",
  "Эрлан",
];

export function runAssertions(opts: {
  world: SimWorld;
  salon: SalonHandle;
  phone: string;
  before: Row[];
  clientTexts: string[];
  assistantTexts: string[];
  expect: Expectations;
  lostInbound: number;
}): AssertionResult[] {
  const { world, salon: h, phone, before, expect } = opts;
  const out: AssertionResult[] = [];
  const push = (r: AssertionResult) => out.push(r);
  const after = world.appointmentsOf(h);
  const beforeIds = new Set(before.map((a) => a.id));
  const beforeById = new Map(before.map((a) => [a.id, a]));
  const mineNew = after.filter((a) => !beforeIds.has(a.id) && samePhone(a.client_phone, phone));
  const mineNewLive = mineNew.filter(LIVE);

  // ── expected booking ────────────────────────────────────────────────────────────────────────
  if (expect.booking) {
    const e = expect.booking;
    const wanted = e.count ?? 1;
    const matching = mineNewLive.filter(
      (a) =>
        h.serviceName(a.service_id) === e.service &&
        oneOf(h.masterName(a.master_id), e.master) &&
        dateOk(h, a.starts_at, e.date) &&
        timeOk(h, a.starts_at, e.time) &&
        (!e.branch || h.branchName(a.branch_id) === e.branch) &&
        (!e.status || a.status === e.status),
    );
    push({
      id: "booking.matches_request",
      ok: matching.length >= 1 && mineNewLive.length === wanted,
      severity: "critical",
      message:
        matching.length >= 1 && mineNewLive.length === wanted
          ? "в базе ровно та запись, которую просил клиент"
          : mineNewLive.length === 0
            ? "запись в базе не создана"
            : matching.length === 0
              ? "запись создана, но не та (услуга/мастер/дата/время/филиал не совпадают)"
              : `ожидалось новых записей: ${wanted}, создано: ${mineNewLive.length}`,
      expected: e,
      actual: mineNewLive.map((a) => describeAppt(h, a)),
    });
  }
  if (expect.noNewBooking) {
    push({
      id: "booking.none_created",
      ok: mineNewLive.length === 0,
      severity: "critical",
      message:
        mineNewLive.length === 0
          ? "лишних записей не создано"
          : "создана запись, которую клиент не просил",
      actual: mineNewLive.map((a) => describeAppt(h, a)),
    });
  }

  // ── seeded appointments ─────────────────────────────────────────────────────────────────────
  const byTag = (tag: string) => after.find((a) => a.sim_tag === tag);
  if (expect.cancelledTag) {
    const a = byTag(expect.cancelledTag);
    push({
      id: "cancel.applied",
      ok: a?.status === "cancelled",
      severity: "critical",
      message: a?.status === "cancelled" ? "запись отменена" : "запись НЕ отменена в базе",
      actual: a ? describeAppt(h, a) : null,
    });
  }
  for (const tag of expect.untouchedTags ?? []) {
    const a = byTag(tag);
    const was = a ? beforeById.get(a.id) : undefined;
    const same =
      a &&
      was &&
      a.status === was.status &&
      a.starts_at === was.starts_at &&
      a.master_id === was.master_id;
    push({
      id: `untouched.${tag}`,
      ok: Boolean(same),
      severity: "critical",
      message: same
        ? `запись «${tag}» не тронута`
        : `запись «${tag}» изменена/отменена без просьбы клиента`,
      expected: was ? describeAppt(h, was) : null,
      actual: a ? describeAppt(h, a) : null,
    });
  }
  if (expect.rescheduled) {
    const r = expect.rescheduled;
    const a = byTag(r.tag);
    const ok =
      Boolean(a) &&
      a!.status === "confirmed" &&
      dateOk(h, a!.starts_at, r.date) &&
      timeOk(h, a!.starts_at, r.time) &&
      oneOf(h.masterName(a!.master_id), r.master);
    const movedWas = a ? beforeById.get(a.id) : undefined;
    push({
      id: "reschedule.applied",
      ok:
        (ok && movedWas?.starts_at !== a?.starts_at) ||
        (ok && movedWas?.master_id !== a?.master_id),
      severity: "critical",
      message: ok ? "запись перенесена куда просили" : "перенос в базе не соответствует просьбе",
      expected: r,
      actual: a ? describeAppt(h, a) : null,
    });
    const extra = mineNewLive.length;
    push({
      id: "reschedule.no_duplicate",
      ok: extra === 0,
      severity: "high",
      message:
        extra === 0 ? "перенос не создал второй записи" : "вместо переноса создана ещё одна запись",
      actual: mineNewLive.map((x) => describeAppt(h, x)),
    });
  }
  if (expect.escalated != null) {
    const conv = world.conversationOf(h, phone);
    const escalated = Boolean(conv?.ai_paused || conv?.state_data?.needs_human);
    push({
      id: "escalation",
      ok: escalated === expect.escalated,
      severity: "high",
      message: expect.escalated
        ? escalated
          ? "диалог передан администратору"
          : "диалог НЕ передан администратору, хотя должен"
        : escalated
          ? "диалог передан администратору без необходимости"
          : "эскалации нет (и не нужна)",
    });
  }

  // ── invariants that hold for EVERY conversation ─────────────────────────────────────────────
  const liveAll = after.filter(LIVE);
  const overlaps: string[] = [];
  for (let i = 0; i < liveAll.length; i++) {
    for (let j = i + 1; j < liveAll.length; j++) {
      const a = liveAll[i];
      const b = liveAll[j];
      if (
        a.master_id === b.master_id &&
        new Date(a.starts_at).getTime() < new Date(b.ends_at).getTime() &&
        new Date(b.starts_at).getTime() < new Date(a.ends_at).getTime()
      ) {
        overlaps.push(
          `${h.masterName(a.master_id)} ${localDateOf(a.starts_at, h.tz)} ${localTimeOf(a.starts_at, h.tz)} ↔ ${localTimeOf(b.starts_at, h.tz)}`,
        );
      }
    }
  }
  push({
    id: "invariant.no_double_booking",
    ok: overlaps.length === 0,
    severity: "critical",
    message: overlaps.length
      ? `двойная запись к мастеру: ${overlaps.join("; ")}`
      : "пересечений записей нет",
  });

  const wrongTenant = after.filter((a) => {
    const m = world.db.table("masters").find((x) => x.id === a.master_id);
    const s = world.db.table("services").find((x) => x.id === a.service_id);
    return m?.salon_id !== a.salon_id || s?.salon_id !== a.salon_id;
  });
  push({
    id: "invariant.salon_consistency",
    ok: wrongTenant.length === 0,
    severity: "critical",
    message: wrongTenant.length
      ? "запись ссылается на мастера/услугу другого салона"
      : "мастер и услуга из того же салона",
  });

  const branchMismatch = mineNewLive.filter((a) => {
    const m = world.db.table("masters").find((x) => x.id === a.master_id);
    return m?.branch_id && a.branch_id && m.branch_id !== a.branch_id;
  });
  push({
    id: "invariant.branch_matches_master",
    ok: branchMismatch.length === 0,
    severity: "critical",
    message: branchMismatch.length
      ? "филиал записи не совпадает с филиалом мастера"
      : "филиал записи = филиал мастера",
  });

  const durationWrong = mineNewLive.filter((a) => {
    const s = world.db.table("services").find((x) => x.id === a.service_id);
    const mins = (new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60_000;
    const max = s?.duration_max_min ?? s?.duration_min;
    return !s || mins < s.duration_min || mins > max;
  });
  push({
    id: "invariant.duration",
    ok: durationWrong.length === 0,
    severity: "high",
    message: durationWrong.length
      ? "длительность записи не совпадает с длительностью услуги"
      : "длительность верная",
  });

  // ── claims vs database ──────────────────────────────────────────────────────────────────────
  const claimTexts = opts.assistantTexts.filter((t) => CLAIM_RE.test(t));
  const myLive = after.filter((a) => LIVE(a) && samePhone(a.client_phone, phone));
  if (claimTexts.length) {
    const hasBooking = myLive.length > 0;
    push({
      id: "claims.booking_exists",
      ok: hasBooking,
      severity: "critical",
      message: hasBooking
        ? "ассистент говорил о записи — она есть в базе"
        : "ассистент сообщил о записи, которой НЕТ в базе",
      actual: claimTexts.slice(-2),
    });
    const last = claimTexts.at(-1)!;
    const times = [...last.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)].map(
      (m) => `${m[1].padStart(2, "0")}:${m[2]}`,
    );
    if (times.length && hasBooking) {
      const dbTimes = new Set(myLive.map((a) => localTimeOf(a.starts_at, h.tz)));
      const matched = times.some((t) => dbTimes.has(t));
      push({
        id: "claims.time_matches_db",
        ok: matched,
        severity: "critical",
        message: matched
          ? "время в подтверждении совпадает с базой"
          : `ассистент назвал ${times.join(", ")}, а в базе ${[...dbTimes].join(", ")}`,
      });
    }
  }
  if (opts.assistantTexts.some((t) => CANCEL_CLAIM_RE.test(t))) {
    const anyCancelled = after.some(
      (a) => a.status === "cancelled" && samePhone(a.client_phone, phone),
    );
    push({
      id: "claims.cancel_exists",
      ok: anyCancelled,
      severity: "critical",
      message: anyCancelled
        ? "отмена, о которой сказал ассистент, есть в базе"
        : "ассистент сообщил об отмене, которой нет в базе",
    });
  }

  // ── hallucination detectors ─────────────────────────────────────────────────────────────────
  const services = world.db.table("services").filter((s) => s.salon_id === h.salonId);
  const allowed = new Set<number>();
  for (const s of services) {
    allowed.add(Number(s.price));
    if (s.price_max != null) allowed.add(Number(s.price_max));
  }
  const basePrices = services.map((s) => Number(s.price));
  for (const a of basePrices) for (const b of basePrices) allowed.add(a + b);
  for (const t of opts.clientTexts)
    for (const m of t.matchAll(/\d[\d\s]{2,6}/g)) allowed.add(Number(m[0].replace(/\s/g, "")));
  const invented: string[] = [];
  for (const t of opts.assistantTexts) {
    for (const m of t.matchAll(/(\d[\d\s]{2,6})\s*(сом|som|с\b|KGS)/gi)) {
      const n = Number(m[1].replace(/\s/g, ""));
      // Inside a range service's bounds is a legitimate narrowed estimate, not an invention.
      const inRange = services.some(
        (s) => s.price_type === "range" && n >= s.price && n <= (s.price_max ?? s.price),
      );
      if (!allowed.has(n) && !inRange) invented.push(m[0]);
    }
  }
  push({
    id: "hallucination.prices",
    ok: invented.length === 0,
    severity: "high",
    message: invented.length
      ? `цены не из прайса: ${[...new Set(invented)].join(", ")}`
      : "все названные цены из прайса",
  });
  const staff = new Set(
    world.db
      .table("masters")
      .filter((m) => m.salon_id === h.salonId)
      .map((m) => m.name),
  );
  const clientSaid = opts.clientTexts.join(" ");
  const fakeNames = DECOY_NAMES.filter(
    (n) =>
      !staff.has(n) &&
      !clientSaid.includes(n.slice(0, 5)) &&
      opts.assistantTexts.some((t) => t.includes(n)),
  );
  push({
    id: "hallucination.masters",
    ok: fakeNames.length === 0,
    severity: "high",
    message: fakeNames.length
      ? `назван несуществующий мастер: ${fakeNames.join(", ")}`
      : "выдуманных мастеров нет",
  });

  // ── pipeline health ─────────────────────────────────────────────────────────────────────────
  push({
    id: "pipeline.no_lost_messages",
    ok: opts.lostInbound === 0,
    severity: "high",
    message:
      opts.lostInbound === 0
        ? "каждое сообщение клиента обработано в своём ходе"
        : `${opts.lostInbound} сообщ. клиента остались без обработки (в проде ждали бы cron-перезапуска)`,
  });
  const leaked = opts.assistantTexts.filter((t) =>
    /(undefined|null\b|\[object Object\]|PGRST|violates|exception|stack|supabase|gemini \d{3}|uuid|functionCall)/i.test(
      t,
    ),
  );
  push({
    id: "ux.no_technical_leak",
    ok: leaked.length === 0,
    severity: "high",
    message: leaked.length
      ? `клиенту ушёл технический текст: «${leaked[0].slice(0, 120)}»`
      : "технических ошибок в ответах нет",
  });
  const tooLong = opts.assistantTexts.filter(
    (t) => t.length > 900 && !/подтвердите запись/i.test(t),
  );
  push({
    id: "ux.message_length",
    ok: tooLong.length === 0,
    severity: "low",
    message: tooLong.length
      ? `слишком длинные ответы: ${tooLong.length}`
      : "длина ответов нормальная",
  });
  return out;
}
