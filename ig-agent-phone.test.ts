// Instagram booking regression: the assistant must never create an appointment without a real
// phone number, and must never tell an Instagram client "у вас нет записей" when the truth is that
// we do not know who they are yet.
//
// Instagram Direct carries no phone. WhatsApp does, and every appointment lookup in the engine is
// keyed on it — so on Instagram those lookups silently match nothing unless they are gated. This
// file pins the gates. Run: bun test ig-agent-phone.test.ts
import { test, expect, describe } from "bun:test";
import {
  buildSystemPromptV4,
  executeV4Tool,
  normalizeClientPhone,
} from "@/lib/wa-agent-v4.server";
import type { WaAgentInput } from "@/lib/wa-agent.server";

function igInput(overrides: Partial<WaAgentInput> = {}): WaAgentInput {
  return {
    salon: { salonId: "s1", salonName: "Тест", timezone: "Asia/Bishkek" },
    config: { industry: "beauty", languages: ["ru"], manage_cutoff_hours: 0 } as any,
    channel: "instagram",
    client: { phone: "", name: "Айгуль" },
    history: [],
    lastMessages: [],
    branches: [],
    selectedBranchId: null,
    state: "collecting",
    stateData: {},
    salonInfo: { working_hours: null, address: null },
    ...overrides,
  } as WaAgentInput;
}

function freshFlags() {
  return {
    appointmentId: null,
    selectedBranchId: null,
    needsHuman: false,
    escalateReason: null,
    photoNotes: [],
  } as any;
}

describe("normalizeClientPhone", () => {
  test("keeps a well-formed international number", () => {
    expect(normalizeClientPhone("+996 555 123456")).toBe("996555123456");
    expect(normalizeClientPhone("996555123456")).toBe("996555123456");
    expect(normalizeClientPhone("+7 701 234 56 78")).toBe("77012345678");
  });

  test("expands the local forms clients actually type", () => {
    expect(normalizeClientPhone("0555 123456")).toBe("996555123456"); // KG domestic
    expect(normalizeClientPhone("555123456")).toBe("996555123456"); // bare subscriber number
    expect(normalizeClientPhone("8 705 123 45 67")).toBe("77051234567"); // RU/KZ domestic prefix
  });

  test("rejects what the appointments trigger would reject anyway", () => {
    // The DB requires 10–15 digits. Catching it here means the assistant asks again instead of
    // the booking exploding inside create_appointment.
    expect(normalizeClientPhone("")).toBeNull();
    expect(normalizeClientPhone("не скажу")).toBeNull();
    expect(normalizeClientPhone("12345")).toBeNull();
    expect(normalizeClientPhone("9".repeat(16))).toBeNull();
    expect(normalizeClientPhone(null)).toBeNull();
  });
});

describe("phone-scoped tools on Instagram", () => {
  // db is deliberately null: these tools must bail out BEFORE touching the database.
  const tools = [
    "get_my_appointments",
    "get_client_context",
    "cancel_appointment",
    "reschedule_appointment",
  ];

  for (const name of tools) {
    test(`${name} asks for the number instead of reporting an empty result`, async () => {
      const res = await executeV4Tool(name, {}, igInput(), null as any, freshFlags());
      expect(res.success).toBe(false);
      expect(res.reason).toBe("need_client_phone");
      expect(res.note).toContain("НЕ говори, что записей нет");
    });
  }

  test("a WhatsApp conversation is unaffected — the phone is always there", async () => {
    // Guard against the gate accidentally firing on the channel that has always worked. With a
    // phone present the tool proceeds to the DB, so a null client is expected to throw here —
    // that it got that far is the assertion.
    const input = igInput({ channel: "whatsapp", client: { phone: "996555123456", name: null } });
    let reachedDb = false;
    try {
      await executeV4Tool("get_my_appointments", {}, input, null as any, freshFlags());
    } catch {
      reachedDb = true;
    }
    expect(reachedDb).toBe(true);
  });
});

describe("create_appointment phone gate", () => {
  const baseArgs = {
    service_id: "11111111-1111-1111-1111-111111111111",
    master_id: "22222222-2222-2222-2222-222222222222",
    date: "2026-08-06",
    time: "15:00",
    client_name: "Айгуль",
    client_confirmation: "да",
  };

  test("refuses to book with no number at all", async () => {
    const res = await executeV4Tool("create_appointment", baseArgs, igInput(), null as any, freshFlags());
    expect(res.success).toBe(false);
    expect(res.reason).toBe("need_client_phone");
    expect(res.note).toContain("client_phone");
  });

  test("distinguishes a junk number from a missing one", async () => {
    // Different reasons produce different assistant behaviour: "ask for the number" vs
    // "the number you gave me looks wrong, send it again".
    const res = await executeV4Tool(
      "create_appointment",
      { ...baseArgs, client_phone: "12345" },
      igInput(),
      null as any,
      freshFlags(),
    );
    expect(res.success).toBe(false);
    expect(res.reason).toBe("invalid_phone");
  });

  test("a valid number is accepted and remembered for the rest of the turn", async () => {
    // With a usable phone the gate passes and execution continues to the DB (null → throws).
    // The flag must have been set on the way through, so later tools in the same turn — and the
    // next turn, via state_data.client_phone — know who this client is.
    const flags = freshFlags();
    try {
      await executeV4Tool(
        "create_appointment",
        { ...baseArgs, client_phone: "+996 555 123456" },
        igInput(),
        null as any,
        flags,
      );
    } catch {
      /* expected: no db */
    }
    expect(flags.collectedPhone).toBe("996555123456");
  });

  test("still refuses without an explicit confirmation, phone or not", async () => {
    // The pre-existing consent gate must keep priority over the new phone gate.
    const res = await executeV4Tool(
      "create_appointment",
      { ...baseArgs, client_confirmation: "а сколько стоит?", client_phone: "996555123456" },
      igInput(),
      null as any,
      freshFlags(),
    );
    expect(res.success).toBe(false);
    expect(res.reason).toBe("need_explicit_confirmation");
  });
});

describe("Instagram prompt block", () => {
  test("tells the model to ask for a number, and when", () => {
    const prompt = buildSystemPromptV4(igInput());
    expect(prompt).toContain("Instagram Direct");
    expect(prompt).toContain("НОМЕР ТЕЛЕФОНА");
    expect(prompt).toContain("НЕ спрашивай номер в приветствии");
  });

  test("does not re-ask once the number is known", () => {
    const prompt = buildSystemPromptV4(
      igInput({ client: { phone: "996555123456", name: "Айгуль" } }),
    );
    expect(prompt).toContain("уже известен");
    expect(prompt).not.toContain("НЕ спрашивай номер в приветствии");
  });

  test("WhatsApp prompts carry none of this", () => {
    const prompt = buildSystemPromptV4(
      igInput({ channel: "whatsapp", client: { phone: "996555123456", name: null } }),
    );
    expect(prompt).not.toContain("Instagram Direct");
    expect(prompt).not.toContain("НОМЕР ТЕЛЕФОНА");
  });
});
