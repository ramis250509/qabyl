// Instagram Direct transport unit tests. Run: bun test ig-transport.test.ts
//
// These cover the parts of the Instagram channel that are pure functions and therefore the parts
// where a silent bug is most expensive: webhook parsing (a mis-parsed echo means the assistant talks
// over a human), signature verification (the only auth on the inbound path), and reply chunking
// (Instagram hard-rejects a body over 1000 chars — an off-by-one there means the client gets
// nothing at all).
import { test, expect, describe } from "bun:test";
import { igVerifySignature, parseIgWebhook, splitForInstagram } from "@/lib/ig-api.server";

const IG_ACCOUNT = "17841400000000000";
const CLIENT = "9876543210";

function inboundPayload(message: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT,
        time: 1_700_000_000,
        messaging: [
          {
            sender: { id: CLIENT },
            recipient: { id: IG_ACCOUNT },
            timestamp: 1_700_000_000,
            message,
          },
        ],
      },
    ],
  };
}

describe("parseIgWebhook", () => {
  test("extracts a plain text message", () => {
    const { igUserId, events } = parseIgWebhook(
      inboundPayload({ mid: "mid.1", text: "Здравствуйте, хочу записаться" }),
    );
    expect(igUserId).toBe(IG_ACCOUNT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      clientId: CLIENT,
      mid: "mid.1",
      text: "Здравствуйте, хочу записаться",
      isEcho: false,
      imageUrl: null,
    });
  });

  test("extracts an image attachment with its caption", () => {
    const { events } = parseIgWebhook(
      inboundPayload({
        mid: "mid.2",
        text: "сколько будет стоить?",
        attachments: [{ type: "image", payload: { url: "https://cdn.example/photo.jpg" } }],
      }),
    );
    expect(events[0].imageUrl).toBe("https://cdn.example/photo.jpg");
    expect(events[0].text).toBe("сколько будет стоить?");
  });

  test("an echo is attributed to the CLIENT, not to the salon", () => {
    // The salon answered manually from the Instagram app. Meta reports the salon as the sender,
    // so a naive parser would key the conversation on the salon's own account id and the takeover
    // pause would land on the wrong (or a brand new) conversation.
    const { events } = parseIgWebhook({
      object: "instagram",
      entry: [
        {
          id: IG_ACCOUNT,
          messaging: [
            {
              sender: { id: IG_ACCOUNT },
              recipient: { id: CLIENT },
              message: { mid: "mid.3", text: "Здравствуйте! Записала вас", is_echo: true },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].clientId).toBe(CLIENT);
    expect(events[0].isEcho).toBe(true);
    // No app_id → a human typed this in the Instagram app → a real takeover.
    expect(events[0].echoAppId).toBeNull();
  });

  test("an echo of OUR OWN api reply carries app_id", () => {
    // Meta echoes every outbound message of the business account, including the ones the bot sent
    // itself. Treating those as a manual takeover muted the assistant for five minutes after each
    // of its own replies, so the client wrote into silence. app_id is what tells them apart.
    const { events } = parseIgWebhook({
      object: "instagram",
      entry: [
        {
          id: IG_ACCOUNT,
          messaging: [
            {
              sender: { id: IG_ACCOUNT },
              recipient: { id: CLIENT },
              message: {
                mid: "mid.4",
                text: "Извините, не получилось разобрать голосовое сообщение",
                is_echo: true,
                app_id: 1234567890,
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].isEcho).toBe(true);
    expect(events[0].echoAppId).toBe("1234567890");
  });

  test("drops read receipts, reactions and deletions", () => {
    const { events } = parseIgWebhook({
      object: "instagram",
      entry: [
        {
          id: IG_ACCOUNT,
          messaging: [
            { sender: { id: CLIENT }, recipient: { id: IG_ACCOUNT }, read: { mid: "mid.x" } },
            { sender: { id: CLIENT }, recipient: { id: IG_ACCOUNT }, reaction: { emoji: "❤️" } },
            {
              sender: { id: CLIENT },
              recipient: { id: IG_ACCOUNT },
              message: { mid: "mid.y", is_deleted: true },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(0);
  });

  test("flattens a batch of several entries and several events", () => {
    const { events } = parseIgWebhook({
      object: "instagram",
      entry: [
        {
          id: IG_ACCOUNT,
          messaging: [
            {
              sender: { id: "a" },
              recipient: { id: IG_ACCOUNT },
              message: { mid: "1", text: "раз" },
            },
            {
              sender: { id: "b" },
              recipient: { id: IG_ACCOUNT },
              message: { mid: "2", text: "два" },
            },
          ],
        },
        {
          id: IG_ACCOUNT,
          messaging: [
            {
              sender: { id: "c" },
              recipient: { id: IG_ACCOUNT },
              message: { mid: "3", text: "три" },
            },
          ],
        },
      ],
    });
    expect(events.map((e) => e.clientId)).toEqual(["a", "b", "c"]);
  });

  test("survives a malformed payload instead of throwing", () => {
    // A throw here would return 500 to Meta, which redelivers for hours and eventually
    // unsubscribes the app.
    expect(parseIgWebhook(null).events).toEqual([]);
    expect(parseIgWebhook({}).events).toEqual([]);
    expect(parseIgWebhook({ entry: "nonsense" }).events).toEqual([]);
    expect(parseIgWebhook({ entry: [{ id: "x", messaging: [{}] }] }).events).toEqual([]);
  });
});

describe("splitForInstagram", () => {
  test("leaves a short reply as one message", () => {
    expect(splitForInstagram("Записала вас на завтра в 15:00")).toEqual([
      "Записала вас на завтра в 15:00",
    ]);
  });

  test("never emits a chunk over the limit", () => {
    const long = "Маникюр с покрытием стоит 1200 сом. ".repeat(120);
    const chunks = splitForInstagram(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(950);
  });

  test("breaks on a sentence boundary, not mid-word", () => {
    const text = `${"а".repeat(900)}. ${"б".repeat(200)}`;
    const chunks = splitForInstagram(text);
    expect(chunks[0].endsWith(".")).toBe(true);
    expect(chunks[1].startsWith("б")).toBe(true);
  });

  test("keeps the full text across chunks", () => {
    const words = Array.from({ length: 400 }, (_, i) => `слово${i}`).join(" ");
    const rejoined = splitForInstagram(words).join(" ");
    expect(rejoined).toBe(words);
  });

  test("empty input produces nothing to send", () => {
    expect(splitForInstagram("")).toEqual([]);
    expect(splitForInstagram("   ")).toEqual([]);
  });
});

describe("igVerifySignature", () => {
  const secret = "app-secret-value";
  const body = JSON.stringify({ object: "instagram", entry: [] });

  async function sign(payload: string, key: string): Promise<string> {
    const k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload));
    return `sha256=${Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  test("accepts a correct signature", async () => {
    expect(await igVerifySignature(secret, body, await sign(body, secret))).toBe(true);
  });

  test("rejects a signature made with the wrong secret", async () => {
    expect(await igVerifySignature(secret, body, await sign(body, "other-secret"))).toBe(false);
  });

  test("rejects a tampered body", async () => {
    const header = await sign(body, secret);
    expect(await igVerifySignature(secret, `${body} `, header)).toBe(false);
  });

  test("rejects a missing or malformed header", async () => {
    expect(await igVerifySignature(secret, body, null)).toBe(false);
    expect(await igVerifySignature(secret, body, "")).toBe(false);
    expect(await igVerifySignature(secret, body, "sha256=not-hex")).toBe(false);
  });

  test("rejects everything when no app secret is configured", async () => {
    // Matches the route's own refusal to process a salon without an app secret: with no secret
    // there is nothing authenticating the request at all.
    expect(await igVerifySignature("", body, await sign(body, secret))).toBe(false);
  });
});
