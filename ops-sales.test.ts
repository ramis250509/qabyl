// Айдар и самолечение Деби: разбор команд владельца и правила «что можно чинить самому».
//
// Запуск: bun test ops-sales.test.ts

import { describe, expect, test } from "bun:test";
import {
  draftOutreachFallback,
  formatFunnel,
  formatLeadCard,
  formatLeadList,
  isTouchDue,
  nextTouchAt,
  normalizeLeadPhone,
  parseLeadCommand,
  parseStage,
  type Lead,
} from "./src/lib/ops-sales";
import { diagnose, formatHealingReport, type Signals } from "./src/lib/ops-sre-playbooks";

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 7,
    name: "Нурзат",
    phone: "996700112233",
    company: "Lashes Nurzhan",
    industry: null,
    stage: "new",
    needs: null,
    objections: null,
    notes: null,
    created_at: "2026-09-10T10:00:00Z",
    updated_at: "2026-09-10T10:00:00Z",
    ...over,
  };
}

const noSignals: Signals = {
  cronTimeouts: [],
  stuckInbound: 0,
  unhandledEvents: 0,
  pendingInvoicesDue: 0,
  waTokenErrors: 0,
  templateErrors: 0,
  errorSpike: null,
};

describe("номер лида", () => {
  test("кыргызский местный формат приводится к международному", () => {
    expect(normalizeLeadPhone("0700112233")).toBe("996700112233");
    expect(normalizeLeadPhone("700112233")).toBe("996700112233");
    expect(normalizeLeadPhone("+996 700 11-22-33")).toBe("996700112233");
  });
  test("мусор не превращается в лида", () => {
    expect(normalizeLeadPhone("привет")).toBeNull();
    expect(normalizeLeadPhone("123")).toBeNull();
  });
});

describe("команда добавления лида", () => {
  test("номер, имя и салон", () => {
    expect(parseLeadCommand("/lead 0700112233 Нурзат Lashes Nurzhan")).toEqual({
      phone: "996700112233",
      name: "Нурзат",
      company: "Lashes Nurzhan",
    });
  });
  test("только номер — тоже лид", () => {
    expect(parseLeadCommand("/lead +996700112233")).toEqual({
      phone: "996700112233",
      name: null,
      company: null,
    });
  });
  test("без номера — не лид", () => {
    expect(parseLeadCommand("/lead Нурзат")).toBeNull();
    expect(parseLeadCommand("/lead")).toBeNull();
  });
});

describe("стадии", () => {
  test("понимает русские слова и ключи", () => {
    expect(parseStage("встреча")).toBe("meeting_set");
    expect(parseStage("ОТКАЗ")).toBe("lost");
    expect(parseStage("qualifying")).toBe("qualifying");
  });
  test("неизвестное слово — null, а не случайная стадия", () => {
    expect(parseStage("может быть")).toBeNull();
  });
});

describe("следующее касание", () => {
  test("новому лиду — через день", () => {
    const at = nextTouchAt("new", new Date("2026-09-10T10:00:00Z"));
    expect(at.toISOString()).toBe("2026-09-11T10:00:00.000Z");
  });
  test("подключившегося и отказавшего не дёргаем", () => {
    expect(isTouchDue(lead({ stage: "won" }), new Date("2027-01-01Z"))).toBe(false);
    expect(isTouchDue(lead({ stage: "lost" }), new Date("2027-01-01Z"))).toBe(false);
  });
  test("молчание больше срока — пора вернуться", () => {
    expect(isTouchDue(lead(), new Date("2026-09-12T10:00:00Z"))).toBe(true);
    expect(isTouchDue(lead(), new Date("2026-09-10T12:00:00Z"))).toBe(false);
  });
});

describe("тексты для владельца", () => {
  test("черновик обращается по имени и называет цифру", () => {
    const text = draftOutreachFallback(lead(), { aiBookings7d: 9 });
    expect(text).toContain("Нурзат");
    expect(text).toContain("9");
    expect(text).not.toMatch(/Gemini|API|токен|webhook/i);
  });
  test("карточка и список не падают на пустых полях", () => {
    const bare = lead({ name: null, company: null, phone: null });
    expect(formatLeadCard(bare, new Date("2026-09-12Z"))).toContain("#7");
    expect(formatLeadList([bare], new Date("2026-09-12Z"))).toContain("без имени");
    expect(formatLeadList([], new Date("2026-09-12Z"))).toContain("Лидов пока нет");
  });
  test("воронка считает всех и отмечает просроченные касания", () => {
    const text = formatFunnel({ new: 2, qualifying: 1, won: 1 }, 2);
    expect(text).toContain("Всего лидов: 4");
    expect(text).toContain("Ждут касания: 2");
  });
});

describe("Деби: что чинить самому", () => {
  test("нечего чинить — пустой список", () => {
    expect(diagnose(noSignals)).toHaveLength(0);
    expect(formatHealingReport([], [])).toContain("всё чисто");
  });

  test("события шины и просроченные счета — лечит сам", () => {
    const f = diagnose({ ...noSignals, unhandledEvents: 5, pendingInvoicesDue: 1 });
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.remedy === "auto")).toBe(true);
  });

  test("сообщение клиента без ответа — инцидент, а не «сейчас поправлю»", () => {
    const f = diagnose({ ...noSignals, stuckInbound: 4 });
    expect(f).toHaveLength(1);
    expect(f[0].key).toBe("stuck_inbound");
    expect(f[0].remedy).toBe("none");
    expect(f[0].title).toContain("4");
  });

  test("истёкший доступ салона и шаблоны — только руками", () => {
    const f = diagnose({ ...noSignals, waTokenErrors: 4, templateErrors: 2 });
    expect(f.map((x) => x.remedy)).toEqual(["none", "none"]);
    expect(f[0].detail).toContain("Подключить WhatsApp");
  });

  test("редкий таймаут задачи не поднимает панику, частый — инцидент", () => {
    expect(diagnose({ ...noSignals, cronTimeouts: [{ job: "followups", count: 2 }] })).toHaveLength(
      0,
    );
    const f = diagnose({ ...noSignals, cronTimeouts: [{ job: "followups", count: 14 }] });
    expect(f[0].key).toBe("cron_timeout:followups");
    expect(f[0].remedy).toBe("none");
    expect(f[0].detail).toContain("14");
  });

  test("всплеск одной ошибки показывается только когда он заметный", () => {
    const small = { ...noSignals, errorSpike: { fingerprint: "a", count: 5, sample: "boom" } };
    expect(diagnose(small)).toHaveLength(0);
    const big = { ...noSignals, errorSpike: { fingerprint: "a", count: 40, sample: "boom" } };
    expect(diagnose(big)[0].key).toBe("spike:a");
  });

  test("отчёт называет, что сделал сам и что осталось человеку", () => {
    const findings = diagnose({ ...noSignals, unhandledEvents: 2, waTokenErrors: 1 });
    const text = formatHealingReport(findings, [
      { key: "route_events", ok: true, note: "разобрано событий: 2" },
    ]);
    expect(text).toContain("Починил сам: 1");
    expect(text).toContain("нужна твоя рука: 1");
  });
});
