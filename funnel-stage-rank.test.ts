// Ranking of funnel stages for the "where do conversations stop" report.
// Run: bun test funnel-stage-rank.test.ts
//
// This exists because the report built on it is meant to answer a question that currently has no
// answer at all: 310 conversations in a month produced 1 appointment, and nothing in the database
// said where they stopped. A ranking bug here does not crash anything — it quietly produces a
// plausible-looking funnel that points at the wrong problem, which is worse than no report.
import { test, expect, describe } from "bun:test";
import {
  FUNNEL_STAGE_RANK,
  classifyFunnelStage,
  furthestFunnelStage,
  type FunnelStage,
} from "@/lib/sales-playbook.server";

const ALL_STAGES: FunnelStage[] = [
  "new_lead",
  "discovery",
  "consulting",
  "objection",
  "offer_booking",
  "prepayment",
  "booked",
];

describe("FUNNEL_STAGE_RANK", () => {
  test("every stage the classifier can return has a rank", () => {
    // A stage with no rank would be silently treated as "not further" and vanish from the report.
    for (const s of ALL_STAGES) {
      expect(FUNNEL_STAGE_RANK[s]).toBeTypeOf("number");
    }
  });

  test("ranks are strictly increasing along the funnel", () => {
    for (let i = 1; i < ALL_STAGES.length; i++) {
      expect(FUNNEL_STAGE_RANK[ALL_STAGES[i]]).toBeGreaterThan(
        FUNNEL_STAGE_RANK[ALL_STAGES[i - 1]],
      );
    }
  });

  test("booked is the terminal stage", () => {
    const max = Math.max(...ALL_STAGES.map((s) => FUNNEL_STAGE_RANK[s]));
    expect(FUNNEL_STAGE_RANK.booked).toBe(max);
  });

  test("objection outranks consulting", () => {
    // Deliberate: an objection means the client engaged with a concrete proposal. It also splits the
    // two diagnoses that need completely different fixes — a pile-up at objection is a script
    // problem, a pile-up at discovery means clients leave before anything is offered.
    expect(FUNNEL_STAGE_RANK.objection).toBeGreaterThan(FUNNEL_STAGE_RANK.consulting);
  });
});

describe("furthestFunnelStage", () => {
  test("keeps the further of the two", () => {
    expect(furthestFunnelStage("discovery", "offer_booking")).toBe("offer_booking");
    expect(furthestFunnelStage("offer_booking", "discovery")).toBe("offer_booking");
  });

  test("a conversation that slipped back still counts as having got far", () => {
    // THE reason this function exists. A client reaches "ready to book", then asks a price question
    // and lands back in discovery. Recording only the current stage would report that conversation
    // as never having got near a booking, systematically understating the assistant.
    let best: FunnelStage | null = null;
    for (const turn of [
      "new_lead",
      "discovery",
      "consulting",
      "offer_booking",
      "discovery",
    ] as const) {
      best = furthestFunnelStage(best, turn);
    }
    expect(best).toBe("offer_booking");
  });

  test("the first turn seeds the marker", () => {
    expect(furthestFunnelStage(null, "new_lead")).toBe("new_lead");
    expect(furthestFunnelStage(undefined, "discovery")).toBe("discovery");
  });

  test("junk stored in the database does not swallow a real stage", () => {
    // state_data is free-form JSON that has carried several schema generations. A value we no longer
    // recognise must not win the comparison and freeze the marker forever.
    expect(furthestFunnelStage("some_old_stage" as FunnelStage, "consulting")).toBe("consulting");
    expect(furthestFunnelStage("" as FunnelStage, "booked")).toBe("booked");
  });

  test("is idempotent — replaying the same stage changes nothing", () => {
    expect(furthestFunnelStage("booked", "booked")).toBe("booked");
    expect(furthestFunnelStage("booked", "new_lead")).toBe("booked");
  });
});

describe("the classifier and the ranking agree on the real progression", () => {
  const facts = (over: Partial<Parameters<typeof classifyFunnelStage>[0]> = {}) => ({
    hasUpcomingAppointment: false,
    awaitingPrepayment: false,
    serviceChosen: false,
    turnCount: 1,
    ...over,
  });

  test("a conversation that books ends at the highest rank", () => {
    const stage = classifyFunnelStage(
      facts({ hasUpcomingAppointment: true }),
      [],
      "unknown",
      false,
    );
    expect(stage).toBe("booked");
    expect(FUNNEL_STAGE_RANK[stage]).toBe(FUNNEL_STAGE_RANK.booked);
  });

  test("a first-contact conversation ends at the lowest rank", () => {
    const stage = classifyFunnelStage(facts({ turnCount: 0 }), [], "unknown", false);
    expect(stage).toBe("new_lead");
    expect(FUNNEL_STAGE_RANK[stage]).toBe(0);
  });

  test("naming a time ranks above merely discussing a service", () => {
    const consulting = classifyFunnelStage(facts({ serviceChosen: true }), [], "unknown", false);
    const offering = classifyFunnelStage(facts({ serviceChosen: true }), [], "unknown", true);
    expect(FUNNEL_STAGE_RANK[offering]).toBeGreaterThan(FUNNEL_STAGE_RANK[consulting]);
  });
});
