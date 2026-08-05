// Per-conversation advisory lock, shared by every chat channel (WhatsApp, Instagram).
//
// Both Green-API and Meta deliver webhooks in parallel and retry on any non-200, so two workers
// can be handed the same conversation at the same moment. Without serialisation they each run the
// agent, each call Gemini (non-deterministic → different wording), and each write state — the
// client gets two contradictory replies and the conversation state is whichever write landed last.
// This is not hypothetical: it is the prod incident documented at the top of the WhatsApp route.
//
// The lock lives in wa_conversations.processing_lock_id / processing_lock_until and is taken via
// the wa_try_acquire_lock / wa_release_lock RPCs (see the WhatsApp migrations). The same RPCs work
// for Instagram conversations because Instagram reuses wa_conversations.
//
// NOTE: the WhatsApp route (src/routes/api/public/wa.$salonId.ts) still carries its own copies of
// these helpers. They were not swapped out as part of the Instagram work on purpose — that route is
// the highest-traffic path in the product and a same-day refactor of its concurrency control is not
// a risk worth taking. Consolidating it is a follow-up.

/** Worst-case ceiling on how long one worker may hold a conversation before another may take over. */
export const LOCK_TTL_SECONDS = 180;
/** Renew interval while a long agent turn is running (must be well under the TTL). */
export const LOCK_HEARTBEAT_MS = 45_000;
const LOCK_WAIT_TIMEOUT_MS = 8000;
const LOCK_POLL_INTERVAL_MS = 400;

/**
 * Take the lock, waiting briefly for a conflicting worker to finish.
 * Returns false if the conversation is still busy after LOCK_WAIT_TIMEOUT_MS — the caller should
 * then simply ack, because its message is queued (processed_at IS NULL) and the worker that holds
 * the lock will drain it.
 */
export async function acquireConversationLock(
  db: any,
  conversationId: string,
  lockId: string,
): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const { data, error } = await db.rpc("wa_try_acquire_lock", {
      _conversation_id: conversationId,
      _lock_id: lockId,
      _ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (error) {
      console.error("[chat-lock] acquire rpc error", error);
      return false;
    }
    if (data === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
}

/**
 * Extend our own lock's TTL. wa_try_acquire_lock succeeds when the stored lock is absent, expired,
 * OR already ours — so the same worker can safely renew mid-turn.
 */
export async function refreshConversationLock(
  db: any,
  conversationId: string,
  lockId: string,
): Promise<boolean> {
  const { data } = await db.rpc("wa_try_acquire_lock", {
    _conversation_id: conversationId,
    _lock_id: lockId,
    _ttl_seconds: LOCK_TTL_SECONDS,
  });
  return data === true;
}

/**
 * Do we still exclusively own this conversation?
 *
 * Checked immediately before every user-visible side effect (sending a reply, marking messages
 * processed, persisting state). If the TTL lapsed mid-turn and another worker took over, ITS turn
 * is authoritative and ours must be dropped — otherwise the client receives the same answer twice
 * in two different wordings.
 */
export async function stillHoldingConversationLock(
  db: any,
  conversationId: string,
  lockId: string,
): Promise<boolean> {
  const { data } = await db
    .from("wa_conversations")
    .select("processing_lock_id, processing_lock_until")
    .eq("id", conversationId)
    .maybeSingle();
  if (!data) return false;
  const untilMs = data.processing_lock_until ? new Date(data.processing_lock_until).getTime() : 0;
  return data.processing_lock_id === lockId && untilMs > Date.now();
}

/** Release the lock. Always call from a `finally` so a dying worker frees it fast. */
export async function releaseConversationLock(
  db: any,
  conversationId: string,
  lockId: string,
): Promise<void> {
  try {
    await db.rpc("wa_release_lock", { _conversation_id: conversationId, _lock_id: lockId });
  } catch (e) {
    console.error("[chat-lock] release failed", e);
  }
}
