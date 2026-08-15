// Outbound transport selection for business-initiated WhatsApp messages.
// Run: bun test wa-transport-choice.test.ts
//
// This is the decision that says whether a booking confirmation, a 2-hour reminder or a
// cancellation notice actually goes out, and over which provider. Getting it wrong is silent in the
// direction that matters most: a salon migrates to the Cloud API, its reminders quietly stop, and
// nobody notices until clients start no-showing.
//
// The two properties worth protecting above all:
//   1. A salon still on Green-API must behave EXACTLY as before the migration, whatever the new
//      Cloud API fields happen to contain.
//   2. A migrated salon must never end up with no transport at all while Green-API is still
//      connected — that is the whole point of the hybrid.
import { test, expect, describe } from "bun:test";
import {
  chooseTransport,
  explainNoTransport,
  type WaTransportInputs,
} from "./supabase/functions/_shared/wa-transport";

/** A fully migrated, fully configured salon. Individual tests override one field at a time. */
function inputs(over: Partial<WaTransportInputs> = {}): WaTransportInputs {
  return {
    provider: "cloud",
    hasGreen: true,
    hasCloud: true,
    templatesReady: true,
    hasTemplateForKind: true,
    inWindow: true,
    ...over,
  };
}

describe("a salon still on Green-API is unaffected by the migration", () => {
  test("uses Green-API regardless of what the Cloud API fields contain", () => {
    // The migration must be invisible to salons that have not opted in. Every combination of the
    // new fields is exercised here precisely because none of them may change this answer.
    for (const hasCloud of [true, false]) {
      for (const templatesReady of [true, false]) {
        for (const hasTemplateForKind of [true, false]) {
          for (const inWindow of [true, false]) {
            expect(
              chooseTransport(
                inputs({
                  provider: "green_api",
                  hasCloud,
                  templatesReady,
                  hasTemplateForKind,
                  inWindow,
                }),
              ),
            ).toBe("green_api");
          }
        }
      }
    }
  });

  test("without Green-API credentials it has nothing, and says so", () => {
    const i = inputs({ provider: "green_api", hasGreen: false });
    expect(chooseTransport(i)).toBe("none");
    expect(explainNoTransport(i, "reminder")).toContain("Green-API не подключён");
  });
});

describe("a migrated salon inside the 24-hour window", () => {
  test("sends free-form text, not a template", () => {
    // Preferred even though an approved template exists: the free-form message is the rich one with
    // the self-service link, while the template is a rigid placeholder skeleton.
    expect(chooseTransport(inputs({ inWindow: true }))).toBe("cloud_text");
  });

  test("still sends free-form text when no templates exist at all", () => {
    // This is the common state during migration — approved templates are days away, but live
    // conversation already works.
    expect(
      chooseTransport(inputs({ inWindow: true, templatesReady: false, hasTemplateForKind: false })),
    ).toBe("cloud_text");
  });
});

describe("a migrated salon outside the window — the hybrid", () => {
  test("uses an approved template when one exists for this kind", () => {
    expect(chooseTransport(inputs({ inWindow: false }))).toBe("cloud_template");
  });

  test("falls back to Green-API while templates are not approved yet", () => {
    // THE central case of the whole migration: the salon receives on Cloud API but its reminders
    // keep going out over Green-API until Meta approves the templates.
    expect(chooseTransport(inputs({ inWindow: false, templatesReady: false }))).toBe("green_api");
  });

  test("falls back to Green-API when templates are approved but this kind has no name set", () => {
    // A half-filled settings form must not silently drop one category of message.
    expect(chooseTransport(inputs({ inWindow: false, hasTemplateForKind: false }))).toBe(
      "green_api",
    );
  });

  test("reports the blocker when Green-API is gone and templates are not ready", () => {
    const i = inputs({ inWindow: false, templatesReady: false, hasGreen: false });
    expect(chooseTransport(i)).toBe("none");
    // The owner has to be able to act on this: "wait for Meta" is a different fix from "fill in a
    // template name" and from "reconnect Green-API".
    expect(explainNoTransport(i, "reminder")).toContain("24 час");
  });

  test("reports the missing template name specifically", () => {
    const i = inputs({ inWindow: false, hasTemplateForKind: false, hasGreen: false });
    expect(chooseTransport(i)).toBe("none");
    expect(explainNoTransport(i, "reminder")).toContain("reminder");
  });
});

describe("a migrated salon with broken Cloud API credentials", () => {
  test("keeps working over Green-API rather than going dark", () => {
    // wa_provider was flipped before the credentials were filled in — a very likely ordering when
    // an owner works through the settings form top to bottom.
    expect(chooseTransport(inputs({ hasCloud: false }))).toBe("green_api");
    expect(chooseTransport(inputs({ hasCloud: false, inWindow: false }))).toBe("green_api");
  });

  test("with neither provider configured it reports the credentials, not the window", () => {
    const i = inputs({ hasCloud: false, hasGreen: false });
    expect(chooseTransport(i)).toBe("none");
    expect(explainNoTransport(i, "confirmation")).toContain("Cloud API");
  });
});

describe("the safety property: no silent dead end", () => {
  test("a connected Green-API instance always yields SOME transport", () => {
    // Exhaustive over every combination. If any of these ever returns "none" while Green-API is
    // connected, a salon has silently lost a category of message.
    for (const provider of ["green_api", "cloud"] as const) {
      for (const hasCloud of [true, false]) {
        for (const templatesReady of [true, false]) {
          for (const hasTemplateForKind of [true, false]) {
            for (const inWindow of [true, false]) {
              const decision = chooseTransport({
                provider,
                hasGreen: true,
                hasCloud,
                templatesReady,
                hasTemplateForKind,
                inWindow,
              });
              expect(decision).not.toBe("none");
            }
          }
        }
      }
    }
  });

  test("every dead end comes with a non-empty explanation", () => {
    for (const provider of ["green_api", "cloud"] as const) {
      for (const hasCloud of [true, false]) {
        for (const templatesReady of [true, false]) {
          for (const hasTemplateForKind of [true, false]) {
            for (const inWindow of [true, false]) {
              const i: WaTransportInputs = {
                provider,
                hasGreen: false,
                hasCloud,
                templatesReady,
                hasTemplateForKind,
                inWindow,
              };
              if (chooseTransport(i) === "none") {
                expect(explainNoTransport(i, "reminder").length).toBeGreaterThan(10);
              }
            }
          }
        }
      }
    }
  });
});
