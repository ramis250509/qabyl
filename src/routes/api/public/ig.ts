// Общий вебхук Instagram для салонов, подключённых кнопкой через приложение Qabyl.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ СОСЕДА. /api/public/ig/$salonId обслуживает салоны со СВОИМ приложением
// Meta: салон назван в адресе, подпись — его app secret. Здесь приложение одно, наше, адрес
// вебхука у него один на всех, и чей это аккаунт, видно только из entry[].id.
//
// После опознания салона всё идёт через processIgDelivery — ту же функцию, что у соседа.
import { createFileRoute } from "@tanstack/react-router";
import { splitIgPayloadByAccount, verifyPlatformIgSignature } from "@/lib/ig-oauth.server";
import { processIgDelivery, safeStringEquals } from "@/routes/api/public/ig.$salonId";

export const Route = createFileRoute("/api/public/ig")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode !== "subscribe") return new Response("ok", { status: 200 });

        const expected = process.env.IG_PLATFORM_VERIFY_TOKEN ?? "";
        if (!expected || !safeStringEquals(expected, token)) {
          console.error("[ig-platform] verify handshake rejected");
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      },

      POST: async ({ request }) => {
        const rid = Math.random().toString(36).slice(2, 8);
        const errLog = (msg: string) => console.error(`[ig-platform ${rid}] ${msg}`);
        // 200 на всё, за что взялись: не-200 заставляет Meta пересылать пачку и в итоге отписывает.
        const ack = () => new Response("ok", { status: 200 });

        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const signature =
          request.headers.get("x-hub-signature-256") ?? request.headers.get("X-Hub-Signature-256");
        if (!(await verifyPlatformIgSignature(rawBody, signature))) {
          errLog(
            "подпись X-Hub-Signature-256 не сошлась (или не заданы IG_APP_SECRET/META_APP_SECRET)",
          );
          return new Response("Forbidden", { status: 403 });
        }

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (payload?.object && payload.object !== "instagram") return ack();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { routeByExternalId } = await import("@/lib/channel-routing.server");

        for (const part of splitIgPayloadByAccount(payload)) {
          let salonId: string | null = null;
          const routed = await routeByExternalId(supabaseAdmin as any, "instagram", part.accountId);
          if (routed) {
            salonId = routed.salonId;
          } else {
            // limit(2), а не maybeSingle(): при двух строках maybeSingle бросает, вебхук отвечает
            // 500, и Meta гоняет пачку по кругу без единой строки о причине.
            const { data: rows } = await supabaseAdmin
              .from("salon_secrets")
              .select("salon_id")
              .eq("instagram_user_id", part.accountId)
              .limit(2);
            if (!rows?.length) {
              errLog(`неизвестный Instagram-аккаунт ${part.accountId}, салон не найден`);
              continue;
            }
            // Один аккаунт у двух салонов: гадать нельзя — ответили бы чужой перепиской.
            if (rows.length > 1) {
              errLog(`Instagram-аккаунт ${part.accountId} привязан к нескольким салонам`);
              continue;
            }
            salonId = (rows[0] as any).salon_id as string;
          }

          try {
            await processIgDelivery({
              salonId,
              rawBody: part.rawBody,
              rid,
              auth: { kind: "platform" },
            });
          } catch (e: any) {
            errLog(`salon=${salonId}: ${e?.message ?? e}`);
          }
        }
        return ack();
      },
    },
  },
});
