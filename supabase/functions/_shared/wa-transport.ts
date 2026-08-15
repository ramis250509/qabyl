// "Which transport may legally carry THIS message?" — for business-initiated WhatsApp notifications.
//
// Every message send-whatsapp produces is business-INITIATED: a booking confirmation, a 2-hour
// reminder, a reschedule or cancellation notice, an owner alert. Nobody asked for them. That is what
// makes the Cloud API hard: free-form text is legal only within 24 hours of the client's last
// message, and outside that window Meta accepts nothing but a pre-approved template (error 131047).
// Template approval depends on Meta business verification and takes days, so a salon can be fully
// live on Cloud API for conversation long before it can send one reminder.
//
// Getting this wrong is silent in the direction that matters: a salon migrates, its reminders stop,
// and nobody finds out until clients start no-showing. So the decision lives here as a pure function
// instead of inline in the request handler — it is the one part of the outbound path worth testing
// exhaustively, and it was untestable while it sat between two network calls.
//
// It lives under supabase/functions/_shared/ because it must be importable from BOTH the Deno edge
// runtime and the bun test runner. It therefore contains no Deno globals, no fetch, and no I/O.

export type WaTransportDecision =
  /** Green-API, exactly as before the migration. */
  | "green_api"
  /** Cloud API free-form text — inside the 24-hour window, so the full formatted message is legal. */
  | "cloud_text"
  /** Cloud API pre-approved template — outside the window. */
  | "cloud_template"
  /** Nothing may legally carry this message. The caller must report why, never fail silently. */
  | "none";

export type WaTransportInputs = {
  /** salons.wa_provider */
  provider: "green_api" | "cloud";
  /** Are Green-API instance + token both present? */
  hasGreen: boolean;
  /** Are Cloud API phone number id + token both present? */
  hasCloud: boolean;
  /** salons.wa_cloud_templates_ready — has the salon got APPROVED templates at all? */
  templatesReady: boolean;
  /** Is a template name configured for this specific message kind? */
  hasTemplateForKind: boolean;
  /** Did the client message this business within the last 24 hours? */
  inWindow: boolean;
};

/**
 * Decide the transport. The order of the rules encodes the migration policy from
 * docs/WA-CLOUD-MIGRATION.md:
 *
 *   1. A salon that has not been switched over keeps using Green-API. This is the overwhelming
 *      majority of traffic and its behaviour must be bit-identical to before the migration — which
 *      is why `provider === "green_api"` is checked first and nothing below can affect it.
 *
 *   2. A migrated salon INSIDE the window sends free-form text. Preferred over a template even when
 *      one exists: the template is a rigid five-placeholder skeleton, while the free-form message is
 *      the rich one clients already get, with the self-service management link.
 *
 *   3. Outside the window, an approved template for this kind.
 *
 *   4. Otherwise Green-API, if the salon still has a working instance. THIS IS THE HYBRID, and the
 *      reason a salon does not lose its reminders the day it migrates. Green-API is not bound by
 *      Meta's window at all.
 *
 *   5. Nothing left. The caller must surface the reason to the owner.
 */
export function chooseTransport(i: WaTransportInputs): WaTransportDecision {
  if (i.provider === "green_api") return i.hasGreen ? "green_api" : "none";

  if (i.hasCloud && i.inWindow) return "cloud_text";
  if (i.hasCloud && i.templatesReady && i.hasTemplateForKind) return "cloud_template";
  if (i.hasGreen) return "green_api";
  return "none";
}

/**
 * Why nothing could carry the message, in words an owner can act on.
 *
 * Called only when chooseTransport returned "none". A bare "delivery failed" sends the owner to
 * support; naming the actual blocker lets them fix it themselves, and the three blockers have
 * completely different fixes (wait for Meta, fill in a template name, reconnect Green-API).
 */
export function explainNoTransport(i: WaTransportInputs, templateKind: string): string {
  if (i.provider === "green_api") {
    return "Green-API не подключён, а салон ещё не переведён на Cloud API";
  }
  if (!i.hasCloud) {
    return "не заданы Phone Number ID или токен Cloud API, и Green-API не подключён";
  }
  if (!i.templatesReady) {
    return "клиент писал больше 24 часов назад, а шаблоны Meta ещё не одобрены (и Green-API не подключён)";
  }
  if (!i.hasTemplateForKind) {
    return `не задан шаблон «${templateKind}» в настройках салона (и Green-API не подключён)`;
  }
  return "нет доступного канала отправки";
}
