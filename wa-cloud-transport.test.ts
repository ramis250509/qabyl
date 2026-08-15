// WhatsApp Cloud API transport unit tests. Run: bun test wa-cloud-transport.test.ts
//
// These cover the parts of the Cloud API channel that are pure functions, which is where a silent
// bug is most expensive:
//   * webhook parsing — a mis-parsed echo means the assistant talks over a live human, or mutes
//     itself forever;
//   * signature verification — the only authentication on the inbound POST path;
//   * reply chunking — WhatsApp hard-rejects a body over 4096 chars, so an off-by-one there means
//     the client receives nothing at all;
//   * delivery-status mapping — this is what the owner reads in the calendar to find out why a
//     client never heard from them.
import { test, expect, describe } from "bun:test";
import { createHmac } from "node:crypto";
import {
  mapWaCloudDeliveryStatus,
  parseWaCloudEchoes,
  parseWaCloudWebhook,
  splitForWhatsApp,
  toWaCloudRecipient,
  waCloudVerifySignature,
} from "@/lib/wa-cloud.server";

const PHONE_NUMBER_ID = "106540352242922";
const BUSINESS_PHONE = "996555000111";
const CLIENT_PHONE = "996700111222";

function messagesPayload(messages: any[], extra: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: BUSINESS_PHONE, phone_number_id: PHONE_NUMBER_ID },
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

function echoPayload(messageEchoes: any[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: BUSINESS_PHONE, phone_number_id: PHONE_NUMBER_ID },
              message_echoes: messageEchoes,
            },
          },
        ],
      },
    ],
  };
}

describe("toWaCloudRecipient", () => {
  test("accepts every phone shape already stored in our database", () => {
    // Green-API chat ids are what a migrating salon's rows actually contain.
    expect(toWaCloudRecipient("996700111222@c.us")).toBe("996700111222");
    expect(toWaCloudRecipient("+996 700 111-222")).toBe("996700111222");
    expect(toWaCloudRecipient("996700111222")).toBe("996700111222");
  });

  test("empty input yields empty string rather than throwing", () => {
    expect(toWaCloudRecipient("")).toBe("");
    expect(toWaCloudRecipient(null as any)).toBe("");
  });
});

describe("splitForWhatsApp", () => {
  test("a short reply stays one bubble", () => {
    expect(splitForWhatsApp("Здравствуйте!")).toEqual(["Здравствуйте!"]);
  });

  test("empty or whitespace-only produces no bubbles at all", () => {
    expect(splitForWhatsApp("   ")).toEqual([]);
    expect(splitForWhatsApp("")).toEqual([]);
  });

  test("every chunk stays under the limit", () => {
    const long = "а".repeat(9000);
    for (const chunk of splitForWhatsApp(long, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  test("splits on a sentence boundary rather than mid-word", () => {
    const text = `${"Первое предложение. ".repeat(6)}${"Второе предложение. ".repeat(6)}`;
    const chunks = splitForWhatsApp(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    // A clean split keeps the full stop with the sentence it belongs to.
    expect(chunks[0].endsWith(".")).toBe(true);
  });

  test("no text is lost across the split", () => {
    const text = Array.from({ length: 200 }, (_, i) => `строка номер ${i}`).join(" ");
    const rejoined = splitForWhatsApp(text, 200).join(" ");
    expect(rejoined.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });
});

describe("parseWaCloudWebhook", () => {
  test("extracts a plain text message with its profile name", () => {
    const { phoneNumberId, events } = parseWaCloudWebhook(
      messagesPayload(
        [
          {
            from: CLIENT_PHONE,
            id: "wamid.AAA",
            timestamp: "1739321024",
            type: "text",
            text: { body: "Здравствуйте, хочу записаться" },
          },
        ],
        { contacts: [{ wa_id: CLIENT_PHONE, profile: { name: "Айгуль" } }] },
      ),
    );
    expect(phoneNumberId).toBe(PHONE_NUMBER_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromPhone: CLIENT_PHONE,
      wamid: "wamid.AAA",
      text: "Здравствуйте, хочу записаться",
      profileName: "Айгуль",
      imageMediaId: null,
    });
    // Meta sends UNIX seconds; everything downstream works in milliseconds.
    expect(events[0].timestampMs).toBe(1739321024 * 1000);
  });

  test("an image yields a media id and its caption as text", () => {
    const { events } = parseWaCloudWebhook(
      messagesPayload([
        {
          from: CLIENT_PHONE,
          id: "wamid.IMG",
          timestamp: "1739321024",
          type: "image",
          image: { id: "media-123", mime_type: "image/jpeg", caption: "сколько будет стоить?" },
        },
      ]),
    );
    // The webhook carries an ID, never a URL — resolving it is a separate two-step Graph call.
    expect(events[0].imageMediaId).toBe("media-123");
    expect(events[0].text).toBe("сколько будет стоить?");
  });

  test("a voice note is recognised under both audio and voice keys", () => {
    const asAudio = parseWaCloudWebhook(
      messagesPayload([{ from: CLIENT_PHONE, id: "w1", type: "audio", audio: { id: "aud-1" } }]),
    );
    const asVoice = parseWaCloudWebhook(
      messagesPayload([{ from: CLIENT_PHONE, id: "w2", type: "voice", voice: { id: "aud-2" } }]),
    );
    expect(asAudio.events[0].audioMediaId).toBe("aud-1");
    expect(asVoice.events[0].audioMediaId).toBe("aud-2");
  });

  test("a button tap carries the id we set plus the label the client saw", () => {
    const { events } = parseWaCloudWebhook(
      messagesPayload([
        {
          from: CLIENT_PHONE,
          id: "wamid.BTN",
          type: "interactive",
          interactive: { button_reply: { id: "confirm_yes", title: "✅ Да, записать" } },
        },
      ]),
    );
    expect(events[0].interactiveReplyId).toBe("confirm_yes");
    expect(events[0].text).toBe("✅ Да, записать");
  });

  test("delivery statuses are separated from messages, with the error code kept numeric", () => {
    const { events, statuses } = parseWaCloudWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [
                  {
                    id: "wamid.SENT",
                    status: "failed",
                    recipient_id: CLIENT_PHONE,
                    errors: [{ code: 131026, title: "Receiver incapable" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(0);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ wamid: "wamid.SENT", status: "failed", errorCode: 131026 });
  });

  test("one POST carrying several entries is fully drained", () => {
    // Meta batches. A parser that reads entry[0] only silently loses client messages.
    const batched = {
      object: "whatsapp_business_account",
      entry: [
        messagesPayload([{ from: "996700000001", id: "w1", type: "text", text: { body: "a" } }])
          .entry[0],
        messagesPayload([{ from: "996700000002", id: "w2", type: "text", text: { body: "b" } }])
          .entry[0],
      ],
    };
    expect(parseWaCloudWebhook(batched).events).toHaveLength(2);
  });

  test("malformed payloads are survived, not thrown on", () => {
    // Anything can arrive on a public endpoint; throwing here would return a non-200 and make Meta
    // redeliver the same junk for 36 hours.
    for (const junk of [null, {}, { entry: "nope" }, { entry: [{ changes: null }] }]) {
      expect(() => parseWaCloudWebhook(junk)).not.toThrow();
      expect(parseWaCloudWebhook(junk).events).toEqual([]);
    }
  });

  test("echo changes are NOT picked up as client messages", () => {
    // The whole reason parseWaCloudEchoes exists separately: if the message parser also swallowed
    // echoes, the assistant would answer the salon owner's own outgoing message as if a client
    // had sent it.
    const { events } = parseWaCloudWebhook(
      echoPayload([
        {
          from: BUSINESS_PHONE,
          to: CLIENT_PHONE,
          id: "wamid.E",
          type: "text",
          text: { body: "hi" },
        },
      ]),
    );
    expect(events).toEqual([]);
  });
});

describe("parseWaCloudEchoes", () => {
  test("keys the echo on the CLIENT, not on the salon's own number", () => {
    // The trap: on an echo the salon is the SENDER. Keying on `from` would attach the takeover to a
    // conversation named after the salon's own number, so the pause would land on the wrong thread
    // while the real conversation kept getting bot replies.
    const { echoes } = parseWaCloudEchoes(
      echoPayload([
        {
          from: BUSINESS_PHONE,
          to: CLIENT_PHONE,
          id: "wamid.ECHO1",
          timestamp: "1739321024",
          type: "text",
          text: { body: "Здравствуйте, это администратор" },
        },
      ]),
    );
    expect(echoes).toHaveLength(1);
    expect(echoes[0].clientPhone).toBe(CLIENT_PHONE);
    expect(echoes[0].businessPhone).toBe(BUSINESS_PHONE);
    expect(echoes[0].text).toBe("Здравствуйте, это администратор");
    expect(echoes[0].wamid).toBe("wamid.ECHO1");
  });

  test("media captions become the echo text, so handoff context is not empty", () => {
    const { echoes } = parseWaCloudEchoes(
      echoPayload([
        {
          from: BUSINESS_PHONE,
          to: CLIENT_PHONE,
          id: "wamid.IMG",
          type: "image",
          image: { caption: "вот наш прайс" },
        },
      ]),
    );
    expect(echoes[0].text).toBe("вот наш прайс");
    expect(echoes[0].type).toBe("image");
  });

  test("revoke and edit are reported with no text rather than dropped", () => {
    // They carry no prose but they are still the owner being present in the chat.
    const { echoes } = parseWaCloudEchoes(
      echoPayload([
        { from: BUSINESS_PHONE, to: CLIENT_PHONE, id: "w1", type: "revoke" },
        { from: BUSINESS_PHONE, to: CLIENT_PHONE, id: "w2", type: "edit" },
      ]),
    );
    expect(echoes).toHaveLength(2);
    expect(echoes.map((e) => e.type)).toEqual(["revoke", "edit"]);
    expect(echoes[0].text).toBeNull();
  });

  test("an echo with no recipient is dropped instead of inventing a conversation key", () => {
    const { echoes } = parseWaCloudEchoes(
      echoPayload([{ from: BUSINESS_PHONE, id: "w1", type: "text", text: { body: "orphan" } }]),
    );
    expect(echoes).toEqual([]);
  });

  test("ordinary client messages are NOT read as echoes", () => {
    const { echoes } = parseWaCloudEchoes(
      messagesPayload([
        { from: CLIENT_PHONE, id: "wamid.A", type: "text", text: { body: "хочу записаться" } },
      ]),
    );
    expect(echoes).toEqual([]);
  });

  test("malformed payloads are survived", () => {
    for (const junk of [null, {}, { entry: [{ changes: [{ field: "smb_message_echoes" }] }] }]) {
      expect(() => parseWaCloudEchoes(junk)).not.toThrow();
      expect(parseWaCloudEchoes(junk).echoes).toEqual([]);
    }
  });
});

describe("waCloudVerifySignature", () => {
  const SECRET = "app-secret-abc123";
  const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const validHeader = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

  test("accepts a correct signature", async () => {
    expect(await waCloudVerifySignature(SECRET, BODY, validHeader)).toBe(true);
  });

  test("accepts the digest without the sha256= prefix", async () => {
    expect(await waCloudVerifySignature(SECRET, BODY, validHeader.slice(7))).toBe(true);
  });

  test("rejects a body that was tampered with by a single byte", async () => {
    expect(await waCloudVerifySignature(SECRET, `${BODY} `, validHeader)).toBe(false);
  });

  test("rejects the wrong app secret", async () => {
    expect(await waCloudVerifySignature("wrong-secret", BODY, validHeader)).toBe(false);
  });

  test("rejects a missing or junk header outright", async () => {
    expect(await waCloudVerifySignature(SECRET, BODY, null)).toBe(false);
    expect(await waCloudVerifySignature(SECRET, BODY, "sha256=not-hex-at-all")).toBe(false);
    expect(await waCloudVerifySignature(SECRET, BODY, "sha256=")).toBe(false);
  });

  test("an empty app secret can never verify", async () => {
    // The route refuses such a salon before reaching here; this is the second line of defence.
    expect(await waCloudVerifySignature("", BODY, validHeader)).toBe(false);
  });
});

describe("mapWaCloudDeliveryStatus", () => {
  test("delivered and read both count as delivered", () => {
    expect(mapWaCloudDeliveryStatus("delivered")).toEqual({ status: "delivered", detail: null });
    expect(mapWaCloudDeliveryStatus("read")).toEqual({ status: "delivered", detail: null });
  });

  test("'sent' is deliberately ignored", () => {
    // The send path already recorded it. Re-writing it here would overwrite a later 'delivered'
    // whenever webhooks arrive out of order — which they do.
    expect(mapWaCloudDeliveryStatus("sent")).toBeNull();
    expect(mapWaCloudDeliveryStatus("unknown-future-status")).toBeNull();
  });

  test("131026 keeps the answer the owner actually asks for", () => {
    // «Почему запись создаётся с номером, которого нет в WhatsApp» — this is the replacement for
    // Green-API's noAccount, and losing it would remove a diagnostic the calendar already shows.
    expect(mapWaCloudDeliveryStatus("failed", 131026)).toEqual({
      status: "failed",
      detail: "У этого номера нет WhatsApp",
    });
  });

  test("the 24-hour-window rejection is explained, not just numbered", () => {
    expect(mapWaCloudDeliveryStatus("failed", 131047).detail).toContain("24 час");
  });

  test("an expired token is named as such", () => {
    expect(mapWaCloudDeliveryStatus("failed", 190).detail).toContain("Токен");
  });

  test("an unknown failure still carries the code so support can act on it", () => {
    expect(mapWaCloudDeliveryStatus("failed", 999999).detail).toContain("999999");
    expect(mapWaCloudDeliveryStatus("failed", null)).toEqual({
      status: "failed",
      detail: "Сообщение не доставлено",
    });
  });
});
