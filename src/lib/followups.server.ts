// Deciding whether a quiet lead may be nudged, and once.
//
// This module is pure on purpose. Every rule below is a reason NOT to send, and a bug in any of
// them is invisible in exactly the way that matters: nobody notices a message that should not
// have gone out until a client complains, or until Instagram limits the account. So the rules
// live in one place, take plain data, and are covered by tests naming the failure each prevents.
//
// THE PLATFORM WINDOW IS THE HARD LIMIT, not a policy we chose:
//   Instagram Direct  — free messaging for 24 h after the client's last message. Past that, only
//                       Meta's HUMAN_AGENT tag, which requires App Review and is meant for a
//                       human who needs more time, not for automated follow-ups.
//   WhatsApp Cloud    — the same 24-hour service window; outside it only approved templates.
//   WhatsApp (Green)  — unofficial, no window enforced, but late messages from a real account are
//                       what gets that account banned, so we impose our own cap.
//
// A follow-up that misses the window is DROPPED, never deferred. Arriving two days after someone
// asked a question is worse than staying quiet.

export type FollowupChannel = "instagram" | "whatsapp_cloud" | "whatsapp";

/**
 * How long after the client's last message we may still write to them.
 *
 * 23 h rather than 24 on the metered channels: the cron runs on an interval, so a candidate
 * computed at 23:59 could be sent minutes later and be refused. The margin is the difference
 * between "we cut it fine" and "the transport errors in production".
 */
export function windowHoursFor(channel: FollowupChannel): number {
  if (channel === "instagram" || channel === "whatsapp_cloud") return 23;
  return 48; // Green-API: our own restraint, not a platform rule.
}

export type FollowupCandidate = {
  conversationId: string;
  channel: FollowupChannel;
  /** When the CLIENT last wrote. The platform window is measured from this. */
  lastClientMessageAt: string | null;
  /** When anything last happened in the thread. */
  lastMessageAt: string | null;
  /** Direction of the most recent message. We only nudge when the last word was ours. */
  lastDirection: "in" | "out" | null;
  /** Whether the newest inbound message is still unprocessed. */
  hasUnprocessedInbound: boolean;
  status: string | null;
  aiPaused: boolean;
  followupSentAt: string | null;
  excluded: boolean;
};

export type FollowupSettings = {
  enabled: boolean;
  delayHours: number;
  text: string | null;
};

export type FollowupDecision =
  | { send: true }
  | { send: false; reason: string };

/** Salon-local hour, so a nudge never lands in the middle of the night. */
export function localHour(nowMs: number, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
  return Number(h);
}

export const QUIET_FROM_HOUR = 21; // no follow-ups at or after 21:00 local
export const QUIET_UNTIL_HOUR = 9; // …and none before 09:00

/**
 * The whole decision. Ordered cheapest-and-most-decisive first, and every branch names its
 * reason so the cron can log exactly why nothing was sent — the alternative is a silent job
 * nobody can debug.
 */
export function decideFollowup(
  c: FollowupCandidate,
  s: FollowupSettings,
  opts: { nowMs: number; timezone: string },
): FollowupDecision {
  if (!s.enabled) return { send: false, reason: "disabled" };
  // An enabled feature with no text must send nothing rather than something generic. The owner
  // writes the message; we never improvise one for them.
  if (!s.text || !s.text.trim()) return { send: false, reason: "no_text" };

  if (c.followupSentAt) return { send: false, reason: "already_sent" };
  if (c.excluded) return { send: false, reason: "excluded_contact" };
  // A live human is handling this thread. Cutting in is the rudest possible interruption.
  if (c.aiPaused) return { send: false, reason: "ai_paused" };
  if (c.status === "booked" || c.status === "done") {
    return { send: false, reason: "already_booked" };
  }

  // The last word must be OURS. If the client wrote last and we have not answered, the fix is to
  // answer them — sending a scripted nudge on top of an unanswered question is insulting.
  if (c.lastDirection !== "out") return { send: false, reason: "client_spoke_last" };
  if (c.hasUnprocessedInbound) return { send: false, reason: "unanswered_message_pending" };

  if (!c.lastClientMessageAt) return { send: false, reason: "client_never_wrote" };
  const clientMs = Date.parse(c.lastClientMessageAt);
  if (!Number.isFinite(clientMs)) return { send: false, reason: "bad_timestamp" };

  const quietForH = (opts.nowMs - clientMs) / 3_600_000;
  if (quietForH < s.delayHours) return { send: false, reason: "too_soon" };

  // Past the platform window there is no legal way to deliver this, so it is dropped.
  if (quietForH > windowHoursFor(c.channel)) {
    return { send: false, reason: "outside_messaging_window" };
  }

  const hour = localHour(opts.nowMs, opts.timezone);
  if (hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR) {
    // Deliberately a skip and not a delay: by morning the 24-hour window has usually closed
    // anyway, and a 09:00 message about last night's question reads as automated.
    return { send: false, reason: "quiet_hours" };
  }

  return { send: true };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export type FollowupRunReport = {
  considered: number;
  sent: number;
  /** Why each skipped conversation was skipped — the job must never be silent about doing nothing. */
  skipped: Record<string, number>;
  failures: Array<{ conversationId: string; error: string }>;
};

/**
 * One pass over every salon that has follow-ups switched on.
 *
 * Scoped tightly on purpose: only conversations touched in the last two days are even looked at,
 * because anything older is outside every window this feature can use.
 */
export async function runFollowups(nowMs = Date.now()): Promise<FollowupRunReport> {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const report: FollowupRunReport = { considered: 0, sent: 0, skipped: {}, failures: [] };
  const skip = (r: string) => {
    report.skipped[r] = (report.skipped[r] ?? 0) + 1;
  };

  const { data: salons, error } = await db
    .from("salon_ai_assistant")
    .select("salon_id, followup_enabled, followup_delay_hours, followup_text, enabled")
    .eq("followup_enabled", true);
  if (error) throw new Error(error.message);
  if (!salons?.length) return report;

  const horizon = new Date(nowMs - 49 * 3_600_000).toISOString();

  for (const row of salons as any[]) {
    const settings: FollowupSettings = {
      enabled: Boolean(row.followup_enabled) && Boolean(row.enabled),
      delayHours: Number(row.followup_delay_hours) || 3,
      text: row.followup_text ?? null,
    };
    // Cheap exits before any per-conversation work.
    if (!settings.enabled || !settings.text?.trim()) {
      skip(settings.enabled ? "no_text" : "disabled");
      continue;
    }

    const [{ data: salon }, { data: convs }, { data: excluded }] = await Promise.all([
      db.from("salons").select("timezone").eq("id", row.salon_id).maybeSingle(),
      db
        .from("wa_conversations")
        .select("id, salon_id, channel, client_phone, external_id, status, ai_paused, followup_sent_at, last_message_at")
        .eq("salon_id", row.salon_id)
        .is("followup_sent_at", null)
        .gte("last_message_at", horizon)
        .limit(200),
      db.from("excluded_contacts").select("phone").eq("salon_id", row.salon_id),
    ]);
    if (!convs?.length) continue;

    const timezone = (salon as any)?.timezone || "Asia/Bishkek";
    const excludedSet = new Set((excluded ?? []).map((e: any) => String(e.phone)));
    const secretsRes = await db
      .from("salon_secrets")
      .select("*")
      .eq("salon_id", row.salon_id)
      .maybeSingle();

    for (const conv of convs as any[]) {
      report.considered++;

      // The two facts the conversation row does not carry: who spoke last, and whether anything
      // inbound is still unanswered. One query per candidate, and the candidate set is already
      // narrowed to "never nudged, active in the last two days".
      const { data: recent } = await db
        .from("wa_messages")
        .select("direction, created_at, processed_at")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false })
        .limit(20);
      const msgs = (recent ?? []) as any[];
      const lastClientMessageAt =
        msgs.find((m) => m.direction === "in")?.created_at ?? null;

      const decision = decideFollowup(
        {
          conversationId: conv.id,
          channel: (conv.channel === "instagram" || conv.channel === "whatsapp_cloud"
            ? conv.channel
            : "whatsapp") as FollowupChannel,
          lastClientMessageAt,
          lastMessageAt: conv.last_message_at,
          lastDirection: (msgs[0]?.direction ?? null) as "in" | "out" | null,
          hasUnprocessedInbound: msgs.some(
            (m) => m.direction === "in" && m.processed_at == null,
          ),
          status: conv.status,
          aiPaused: Boolean(conv.ai_paused),
          followupSentAt: conv.followup_sent_at,
          excluded: excludedSet.has(String(conv.client_phone ?? "")),
        },
        settings,
        { nowMs, timezone },
      );

      if (!decision.send) {
        skip(decision.reason);
        continue;
      }

      const text = settings.text.trim();
      const { sendChatText } = await import("@/lib/chat-send.server");
      const sent = await sendChatText(conv, secretsRes.data as any, text);

      if (!sent.ok) {
        report.failures.push({ conversationId: conv.id, error: sent.error });
        continue;
      }

      // Stamp FIRST, then record the message. If the write below fails we have still marked the
      // conversation, and the worst case is a thread missing one line — far better than the
      // reverse, where a retry sends the client a second copy.
      await db
        .from("wa_conversations")
        .update({ followup_sent_at: new Date(nowMs).toISOString() })
        .eq("id", conv.id);

      await db.from("wa_messages").insert({
        conversation_id: conv.id,
        salon_id: conv.salon_id,
        direction: "out",
        kind: "text",
        text_body: text,
        green_api_message_id: sent.messageId,
        processed_at: new Date(nowMs).toISOString(),
        meta: { followup: true },
      });

      report.sent++;
    }
  }

  return report;
}
