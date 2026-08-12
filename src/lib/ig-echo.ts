// "Did WE send this, or did a human take over?" — for Instagram message echoes.
//
// Meta echoes every outbound message of the business account back to the webhook, including the
// ones this bot just sent through the API. The webhook has to tell those apart from a message the
// salon owner typed by hand in the Instagram app, because the second one means a human has taken
// over and the assistant must go quiet.
//
// Getting it wrong is expensive in both directions and silent in both directions:
//   - too eager  -> the assistant mutes itself after its own reply and the client writes into
//                   silence, with no error anywhere;
//   - too lax    -> the assistant talks over a live human answering the same client.
//
// It lives in its own module, taking its lookups as injected functions, because this decision is
// the one part of the Instagram webhook worth testing exhaustively — and it was untestable while
// it sat inline in the route handler between two database calls.

export type EchoOwnershipDeps = {
  /** Meta sets this on messages sent through an app. A human typing in the app produces none. */
  echoAppId: string | null;
  /** Instagram message id of the echo, if present. */
  mid: string | null;
  /** Echo text, if any. */
  text: string | null;
  /** Did we record an outbound message with this mid on this conversation? */
  findOutboundByMid: (mid: string) => Promise<boolean>;
  /** Did we send this exact text on this conversation very recently? */
  findRecentOutboundByText: (text: string) => Promise<boolean>;
  /** Did we DM this exact person off a comment in the last few minutes? */
  recentlyDmedFromComment: () => Promise<boolean>;
};

/**
 * True when the echo is our own message coming back.
 *
 * Four signals, tried cheapest first and short-circuiting, because each one after the first costs
 * a database round-trip on the hot path of every outbound message.
 *
 *   1. app_id — the primary signal, and free.
 *   2. the mid we stored when sending — belt and braces for when app_id is absent.
 *   3. identical text sent moments ago — closes the race where the echo overtakes our own write.
 *   4. a comment-triggered DM to this person moments ago.
 *
 * Signal 4 exists because of a real incident. A private reply to a comment goes out through a
 * different endpoint and its echo carries NO app_id, so signal 1 cannot see it. It also races the
 * trigger's own bookkeeping: the echo arrived four seconds after the send and before the outbound
 * row existed, so signals 2 and 3 had nothing to match. All three failed, the assistant read its
 * own DM as the owner typing, muted itself for five minutes, and the client's answer sat
 * unprocessed. The comment ledger is claimed BEFORE the send, so it is the one record guaranteed
 * to be there by the time the echo arrives.
 *
 * The reason this only ever bit on a SECOND comment from the same person: the first time, no
 * conversation exists yet, and the caller bails out before ever asking this question.
 */
export async function echoIsOurs(d: EchoOwnershipDeps): Promise<boolean> {
  if (d.echoAppId != null) return true;
  if (d.mid && (await d.findOutboundByMid(d.mid))) return true;
  if (d.text && (await d.findRecentOutboundByText(d.text))) return true;
  return await d.recentlyDmedFromComment();
}
