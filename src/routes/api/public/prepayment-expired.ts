// Tell the client that their held slot was released.
//
// prepayment_expire_holds() runs every minute and flips unpaid holds to
// payment_expired, which frees the slot. Until now that happened in total
// silence: the client had been told "держим слот до 14:30", then nothing — they
// either showed up to a booking that no longer existed, or waited for a
// confirmation that was never coming.
//
// This endpoint is called by that SQL job, once per expired appointment. It is
// an app route rather than a Supabase edge function on purpose: it ships with
// the normal deploy, so there is no second artefact to remember to publish.
//
// Auth: the shared cron secret, the same one the reschedule/cancel trigger uses.
// It is read from the CRON_SECRET env var if set, otherwise from the Supabase
// vault entry named `cron_secret` that reminders and cleanup already rely on —
// so there is nothing to configure for this endpoint to work.
//
// Scope: Instagram conversations. WhatsApp holds are not messaged here — that
// channel's outbound path goes through the send-whatsapp edge function and its
// own template rules, and wiring it in blind would risk double-messaging.
import { createFileRoute } from "@tanstack/react-router";
import { igSendMessage, type IgCreds } from "@/lib/ig-api.server";

export const Route = createFileRoute("/api/public/prepayment-expired")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-cron-secret") ?? "";
        if (!provided) return new Response("Forbidden", { status: 403 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const db = supabaseAdmin as any;

        // Same resolution order as send-push: the env var when someone set one,
        // otherwise the vault secret every other cron consumer already uses. The
        // fallback is what makes this endpoint work with no configuration at all
        // — the secret exists the moment reminders do.
        let expected = (process.env.CRON_SECRET ?? "").trim();
        if (!expected) {
          const { data: sec, error: rpcErr } = await db.rpc("internal_get_cron_secret");
          if (rpcErr) console.error("[prepayment-expired] cron secret rpc error", rpcErr.message);
          expected = ((sec as string) ?? "").trim();
        }
        // An unset secret must never authorise anything.
        if (!expected || provided !== expected) {
          return new Response("Forbidden", { status: 403 });
        }

        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const appointmentId = String(body?.appointment_id ?? "");
        if (!appointmentId) return new Response("Bad request", { status: 400 });

        // The conversation that created this hold. state_data still carries the
        // appointment id until the client pays or the state is reset.
        const { data: convs } = await db
          .from("wa_conversations")
          .select("id, salon_id, channel, external_id, state, state_data")
          .eq("channel", "instagram")
          .contains("state_data", { prepayment_appointment_id: appointmentId })
          .limit(1);
        const conv = (convs ?? [])[0];
        if (!conv?.external_id) {
          // Not an Instagram hold (or the conversation moved on) — nothing to say.
          return new Response("ok", { status: 200 });
        }

        // Idempotency: pg_cron retries and net.http_post has no delivery guarantee,
        // so a second call for the same appointment must not send a second message.
        const { data: already } = await db
          .from("prepayment_audit")
          .select("id")
          .eq("appointment_id", appointmentId)
          .eq("action", "expired_notified")
          .limit(1);
        if ((already ?? []).length > 0) {
          return new Response("ok", { status: 200 });
        }

        const { data: secrets } = await db
          .from("salon_secrets")
          .select("instagram_user_id, instagram_token")
          .eq("salon_id", conv.salon_id)
          .maybeSingle();
        if (!secrets?.instagram_token || !secrets?.instagram_user_id) {
          return new Response("ok", { status: 200 });
        }

        const creds: IgCreds = {
          igUserId: secrets.instagram_user_id,
          token: secrets.instagram_token,
        };

        const text =
          "Время удержания истекло, и слот освободился — оплата так и не пришла. " +
          "Если всё ещё хотите записаться, напишите — подберём новое время.";

        const sent = await igSendMessage(creds, conv.external_id, text);

        await db.from("wa_messages").insert({
          conversation_id: conv.id,
          salon_id: conv.salon_id,
          direction: "out",
          kind: "text",
          text_body: text,
          green_api_message_id: sent.ok ? (sent.messageId ?? null) : null,
          meta: { hold_expired: true },
        });

        await db.from("prepayment_audit").insert({
          appointment_id: appointmentId,
          salon_id: conv.salon_id,
          actor_kind: "system",
          action: "expired_notified",
          detail: { channel: "instagram", delivered: sent.ok },
        });

        // The hold is gone, so the conversation is no longer waiting for a receipt.
        const nextData = { ...(conv.state_data ?? {}) };
        delete nextData.prepayment_appointment_id;
        delete nextData.prepayment_amount;
        delete nextData.prepayment_currency;
        delete nextData.prepayment_hold_expires_at;
        await db
          .from("wa_conversations")
          .update({ state: "collecting", state_data: nextData })
          .eq("id", conv.id);

        return new Response("ok", { status: 200 });
      },
    },
  },
});
