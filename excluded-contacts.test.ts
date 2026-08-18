// Every test here names a message the assistant must NOT send.
//
// The exclusion list is the owner's only switch for "never talk to this person". It failed twice
// in ways that are invisible from the outside: a swallowed query error read as "not excluded",
// and a byte-exact phone comparison stopped matching the moment a number was stored in another
// shape. Both are regressions you only discover when the AI has already written into someone's
// personal chat, so they are pinned here.
//
// Run: bun test excluded-contacts.test.ts

import { describe, expect, test } from "bun:test";
import {
  isExcludedByLookup,
  isExcludedContact,
  loadExcludedContacts,
  normalizeExcludedKey,
} from "./src/lib/excluded-contacts.server";

const SALON = "88003cb4-eb86-4afa-84a2-5bd40b46e1a8";

/** Minimal stand-in for the Supabase client: .from().select().eq() resolving to one result. */
function fakeDb(
  result: { data?: any[] | null; error?: { message: string } | null } | (() => never),
) {
  return {
    from(table: string) {
      expect(table).toBe("excluded_contacts");
      return {
        select() {
          return {
            eq(col: string, val: string) {
              expect(col).toBe("salon_id");
              expect(val).toBe(SALON);
              if (typeof result === "function") return Promise.resolve().then(result);
              return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
            },
          };
        },
      };
    },
  } as any;
}

const listed = (...phones: string[]) => fakeDb({ data: phones.map((phone) => ({ phone })) });

describe("normalising both sides of the comparison", () => {
  test("a stored number and an incoming chat id meet in the middle", () => {
    expect(normalizeExcludedKey("996227089442")).toBe("996227089442");
    expect(normalizeExcludedKey("+996 227 089 442")).toBe("996227089442");
    expect(normalizeExcludedKey(" +996-227-089-442 ")).toBe("996227089442");
  });

  test("Instagram conversations keep their prefix and are not confused with a phone", () => {
    expect(normalizeExcludedKey("ig:1222654883129413")).toBe("ig:1222654883129413");
    expect(normalizeExcludedKey("IG:1222654883129413")).toBe("ig:1222654883129413");
    expect(normalizeExcludedKey("ig:1222654883129413")).not.toBe(
      normalizeExcludedKey("1222654883129413"),
    );
  });

  test("empty input is not a key — it must never match a stored contact", () => {
    expect(normalizeExcludedKey(null)).toBe("");
    expect(normalizeExcludedKey(undefined)).toBe("");
    expect(normalizeExcludedKey("   ")).toBe("");
  });
});

describe("the contact the owner silenced stays silenced", () => {
  test("exact match", async () => {
    expect(await isExcludedContact(listed("996227089442"), SALON, "996227089442")).toBe(true);
  });

  test("stored with a plus and spaces, arriving as bare digits", async () => {
    // This is the case a .eq('phone', phone) query missed entirely.
    expect(await isExcludedContact(listed("+996 227 089 442"), SALON, "996227089442")).toBe(true);
  });

  test("an Instagram account on the list", async () => {
    expect(
      await isExcludedContact(listed("ig:1222654883129413"), SALON, "ig:1222654883129413"),
    ).toBe(true);
  });

  test("one entry out of several still matches", async () => {
    const db = listed("996507028803", "996703569544", "996227089442");
    expect(await isExcludedContact(db, SALON, "996227089442")).toBe(true);
  });
});

describe("a normal client is still answered", () => {
  test("a number nobody silenced", async () => {
    expect(await isExcludedContact(listed("996227089442"), SALON, "996501204226")).toBe(false);
  });

  test("an empty exclusion list silences nobody", async () => {
    expect(await isExcludedContact(listed(), SALON, "996501204226")).toBe(false);
  });

  test("a near-miss number is not treated as a match", async () => {
    expect(await isExcludedContact(listed("996227089442"), SALON, "99622708944")).toBe(false);
  });
});

describe("when the list cannot be read, say nothing", () => {
  // The old code read a failed query as an empty list and answered. That is how the owner's own
  // phone gets a sales pitch from their own salon.
  test("a query error means excluded, not allowed", async () => {
    const db = fakeDb({ error: { message: "connection reset" } });
    expect(await isExcludedContact(db, SALON, "996227089442")).toBe(true);
  });

  test("a thrown client error means excluded too", async () => {
    const db = fakeDb(() => {
      throw new Error("supabaseAdmin unavailable");
    });
    expect(await isExcludedContact(db, SALON, "996227089442")).toBe(true);
  });

  test("the failure is logged — a silenced client must not look like an idle salon", async () => {
    const lines: string[] = [];
    const db = fakeDb({ error: { message: "connection reset" } });
    await isExcludedContact(db, SALON, "996227089442", (m) => lines.push(m));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("excluded_contacts lookup failed");
  });

  test("a failed lookup handed to the follow-up cron blocks every candidate", () => {
    const failed = { ok: false as const, error: "connection reset" };
    expect(isExcludedByLookup(failed, "996501204226")).toBe(true);
    expect(isExcludedByLookup(failed, null)).toBe(true);
  });
});

describe("loadExcludedContacts reports what happened", () => {
  test("a good read returns normalised keys", async () => {
    const res = await loadExcludedContacts(listed("+996 227 089 442", "ig:123"), SALON);
    expect(res.ok).toBe(true);
    if (res.ok) expect([...res.keys].sort()).toEqual(["996227089442", "ig:123"].sort());
  });

  test("blank rows are dropped rather than becoming a key that matches everything", async () => {
    const res = await loadExcludedContacts(
      fakeDb({ data: [{ phone: "" }, { phone: null }] }),
      SALON,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.keys.size).toBe(0);
    expect(isExcludedByLookup(res, "")).toBe(false);
  });

  test("an error is surfaced, not swallowed", async () => {
    const res = await loadExcludedContacts(fakeDb({ error: { message: "boom" } }), SALON);
    expect(res).toEqual({ ok: false, error: "boom" });
  });
});

describe("every inbound channel goes through the guard", () => {
  // A source-level check, because the failure it prevents is a copy-paste: someone adds a new
  // channel (or edits an old one) with `const { data: excluded } = await db.from(...)` and the
  // fail-open behaviour is back with no test failing anywhere.
  const { readFileSync } = require("node:fs");
  const channels = [
    "src/routes/api/public/wa.$salonId.ts",
    "src/routes/api/public/wacloud.$salonId.ts",
    "src/routes/api/public/ig.$salonId.ts",
  ];

  for (const file of channels) {
    test(`${file} calls isExcludedContact and never queries the table itself`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("isExcludedContact(");
      expect(src).not.toContain('.from("excluded_contacts")');
    });
  }

  test("the follow-up cron treats an unreadable list as excluded", () => {
    const src = readFileSync("src/lib/followups.server.ts", "utf8");
    expect(src).toContain("loadExcludedContacts(");
    expect(src).toContain("excluded_lookup_failed");
    expect(src).not.toContain('.from("excluded_contacts")');
  });
});
