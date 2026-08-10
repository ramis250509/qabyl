// The send_booking_link gate.
//
// The online-booking page is a real conversion path, but it is also the model's most tempting
// escape hatch from a hard turn ("вот ссылка, запишитесь сами"). An assistant that hands out
// the link instead of booking converts WORSE than one that stays in the chat, so the decision
// is not left to the model's judgement alone: it proposes a reason, and the server checks that
// reason against facts it actually knows. These tests are that contract.
//
// Run: bun test wa-v4-booking-link.test.ts
import { test, expect, describe } from "bun:test";
import { executeV4Tool } from "@/lib/wa-agent-v4.server";

const TZ = "Asia/Bishkek";

function inputWith(over: Record<string, any> = {}) {
  return {
    salon: {
      salonId: "s1",
      salonName: "Тест",
      timezone: TZ,
      slug: "test-salon",
      customDomain: null,
    },
    config: { industry: "beauty", languages: ["ru"], booking_link_mode: "auto" },
    selectedBranchId: null,
    salonInfo: { working_hours: null },
    stateData: {},
    ...over,
  } as any;
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

// send_booking_link never touches the database — it reads config + conversation state only.
const NO_DB = {} as any;

async function call(reason: string, input = inputWith(), flags = freshFlags()) {
  const res: any = await executeV4Tool("send_booking_link", { reason }, input, NO_DB, flags);
  return { res, flags };
}

describe("reasons the server accepts", () => {
  test("the client asked for the link — always allowed", async () => {
    const { res, flags } = await call("client_asked");
    expect(res.allowed).toBe(true);
    expect(res.url).toBe("https://qabyl.com/book/test-salon");
    // The URL is appended deterministically by the agent, not retyped by the model.
    expect(flags.bookingLinkSent).toBe("https://qabyl.com/book/test-salon");
    expect(res.note).toContain("НЕ пиши URL сам");
  });

  test("the client said they'll book themselves later — allowed", async () => {
    expect((await call("self_serve")).res.allowed).toBe(true);
  });

  test("a custom domain produces that salon's own URL", async () => {
    const input = inputWith({
      salon: {
        salonId: "s1",
        salonName: "Т",
        timezone: TZ,
        slug: "x",
        customDomain: "zapis.salon.kg",
      },
    });
    expect((await call("client_asked", input)).res.url).toBe("https://zapis.salon.kg/");
  });
});

describe("reasons the server refuses", () => {
  // The failure mode this exists to prevent: the model decides after one round of slots that
  // the client is "tired of choosing" and bails out to the website.
  test("slot fatigue is refused until the client really has been round the loop", async () => {
    const early = await call(
      "slot_fatigue",
      inputWith({ stateData: { sales: { slotRounds: 1 } } }),
    );
    expect(early.res.allowed).toBe(false);
    expect(early.res.reason).toBe("not_justified");
    expect(early.flags.bookingLinkSent).toBeUndefined();
    // The refusal must tell the model what to do INSTEAD, or it just apologises at the client.
    expect(early.res.note).toContain("свободные окошки");

    const late = await call("slot_fatigue", inputWith({ stateData: { sales: { slotRounds: 2 } } }));
    expect(late.res.allowed).toBe(true);
  });

  test("«the calendar is broken» is only accepted when the calendar actually broke", async () => {
    const lying = await call("tool_failure");
    expect(lying.res.allowed).toBe(false);

    const flags = freshFlags();
    flags.calendarToolFailed = true;
    const real = await call("tool_failure", inputWith(), flags);
    expect(real.res.allowed).toBe(true);
  });

  test("a salon that turned the link off never gets one", async () => {
    const input = inputWith({ config: { booking_link_mode: "off" } });
    const { res } = await call("client_asked", input);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("disabled");
    expect(res.note).toContain("записывай клиента здесь");
  });

  test("a salon with no public page cannot send a link it does not have", async () => {
    const input = inputWith({
      salon: { salonId: "s1", salonName: "Т", timezone: TZ, slug: null, customDomain: null },
    });
    const { res } = await call("client_asked", input);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("disabled");
  });
});

describe("one link per conversation", () => {
  const alreadySent = { sales: { bookingLinkSentAt: "2026-08-10T10:00:00.000Z", slotRounds: 5 } };

  test("a second unsolicited link is refused — it reads as giving up", async () => {
    const { res } = await call("slot_fatigue", inputWith({ stateData: alreadySent }));
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("already_sent");
  });

  test("but if the client asks again, they get it again", async () => {
    const { res } = await call("client_asked", inputWith({ stateData: alreadySent }));
    expect(res.allowed).toBe(true);
  });
});

describe("eager mode", () => {
  // The owner explicitly opted into a more forward assistant; the reason check relaxes, but
  // the once-per-conversation rule does not.
  test("relaxes the justification check", async () => {
    const input = inputWith({ config: { booking_link_mode: "eager" } });
    expect((await call("slot_fatigue", input)).res.allowed).toBe(true);
  });

  test("still cannot send twice unprompted", async () => {
    const input = inputWith({
      config: { booking_link_mode: "eager" },
      stateData: { sales: { bookingLinkSentAt: "2026-08-10T10:00:00.000Z" } },
    });
    expect((await call("slot_fatigue", input)).res.allowed).toBe(false);
  });
});
