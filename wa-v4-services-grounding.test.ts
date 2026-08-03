// Grounding regression: after the 2026-08-01 pre-inject fix, buildSystemPromptV4
// must render the real, closed-list price roster into the system prompt so the
// model cannot amend it with its own trained-in "typical industry" catalogue.
// Root cause of the prod bug (Lashes Nurzhan salon): model correctly called
// get_services, then still appended "Классика/2D/3D/Мокрый эффект/…" because
// the salon's tier-shaped naming ("К ученицам", "К премиум мастеру") looked
// unusual to it. Fix = grounding, not persuasion.

import { test, expect, describe } from "bun:test";
import { buildSystemPromptV4 } from "@/lib/wa-agent-v4.server";

function input(configOverrides: Record<string, unknown> = {}) {
  return {
    salon: { salonId: "s1", salonName: "Тест-Салон", timezone: "Asia/Bishkek" },
    config: { industry: "beauty", languages: ["ru"], manage_cutoff_hours: 0, ...configOverrides },
    branches: [],
    salonInfo: { working_hours: null, address: null },
    stateData: {},
  } as any;
}

describe("services roster — closed-list grounding", () => {
  const roster =
    "«К ученицам» — 200 сом · 180 мин [Наращивание ресниц]\n" +
    "«К стажерам» — 500 сом · 180 мин [Наращивание ресниц]\n" +
    "«К премиум мастеру» — 2000 сом · 60 мин [Наращивание ресниц]";

  test("roster block is present verbatim when servicesRoster is supplied", () => {
    const p = buildSystemPromptV4(input(), [], "", "ru", roster);
    expect(p).toContain("ПОЛНЫЙ И ЕДИНСТВЕННЫЙ ПРАЙС ЭТОГО САЛОНА (ЗАКРЫТЫЙ СПИСОК)");
    expect(p).toContain("«К ученицам» — 200 сом");
    expect(p).toContain("«К премиум мастеру» — 2000 сом");
  });

  test("explicit closed-list rule appears next to the roster", () => {
    const p = buildSystemPromptV4(input(), [], "", "ru", roster);
    expect(p).toMatch(/У салона НЕТ никаких других услуг/i);
    expect(p).toMatch(/никогда не упоминай названий услуг вне этого списка/i);
  });

  // The specific hallucinated names from prod ("Классика/2D/3D/…") get called out by name in
  // the rule so the model can't rationalise "these are just typical categories".
  test("rule mentions the hallucinated categories explicitly", () => {
    const p = buildSystemPromptV4(input(), [], "", "ru", roster);
    expect(p).toContain("Классика/2D/3D");
  });

  // Tier-shaped service names look like "master levels" to the model — the rule has to say
  // that's fine and the salon meant them as services. Regression on the actual prod bug.
  test("rule acknowledges tier-shaped service names as valid services", () => {
    const p = buildSystemPromptV4(input(), [], "", "ru", roster);
    expect(p).toMatch(/К ученицам.*К премиум мастеру/i);
    expect(p).toMatch(/это и есть услуги/i);
  });

  // Empty roster (new salon / all services hidden from AI) → the block must not render as an
  // orphan header; the model behaves like today (uses get_services as source of truth).
  test("empty servicesRoster → no closed-list block at all", () => {
    const p = buildSystemPromptV4(input(), [], "", "ru", "");
    expect(p).not.toContain("ПОЛНЫЙ И ЕДИНСТВЕННЫЙ ПРАЙС");
    expect(p).not.toContain("ЗАКРЫТЫЙ СПИСОК");
  });

  // The roster block must appear BEFORE the trailing OVERRIDES ("ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА")
  // so tone/pricing/knowledge_base rules can still nudge STYLE while grounding stays on FACTS.
  test("closed-list block sits above the salon-overrides block", () => {
    const p = buildSystemPromptV4(
      input({ ai_rules: "Всегда сразу называй цену." }),
      [],
      "",
      "ru",
      roster,
    );
    const idxPrice = p.indexOf("ПОЛНЫЙ И ЕДИНСТВЕННЫЙ ПРАЙС");
    const idxOverrides = p.indexOf("ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА");
    expect(idxPrice).toBeGreaterThan(-1);
    expect(idxOverrides).toBeGreaterThan(idxPrice);
  });
});
