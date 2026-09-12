// Общий вебхук WhatsApp Cloud API для всех салонов, подключённых через приложение Qabyl.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ СОСЕДА. Маршрут /api/public/wacloud/$salonId обслуживает салоны, у которых
// СВОЁ приложение Meta: салон назван в адресе, подпись проверяется его собственным app secret.
// Здесь всё наоборот — приложение одно, наше, и Meta шлёт в один адрес события всех салонов
// сразу. Кто написал, видно только из самой полезной нагрузки: `metadata.phone_number_id`.
//
// Почему так, а не пер-салонные адреса: при Embedded Signup салон не открывает кабинет Meta и
// не вставляет никаких URL — он нажимает кнопку и подтверждает доступ. Адрес вебхука задан
// один раз в настройках приложения и одинаков для всех.
//
// Оба маршрута сходятся в processWaCloudPayload: всё, что происходит после опознания салона,
// одинаково.
import { createFileRoute } from "@tanstack/react-router";
import { parseWaCloudWebhook, waCloudVerifySignature } from "@/lib/wa-cloud.server";
import { processWaCloudPayload } from "@/routes/api/public/wacloud.$salonId";

/** Сравнение без утечки длины совпавшего префикса по времени. */
function safeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/wacloud")({
  server: {
    handlers: {
      // Рукопожатие подписки. В отличие от пер-салонного маршрута сверять не с чем в базе:
      // приложение одно, значит и verify-токен один, из окружения.
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode !== "subscribe") return new Response("ok", { status: 200 });

        const expected = process.env.WA_PLATFORM_VERIFY_TOKEN ?? "";
        if (!expected || !safeStringEquals(expected, token)) {
          console.error("[wacloud-platform] verify handshake rejected");
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      },

      POST: async ({ request }) => {
        const rid = Math.random().toString(36).slice(2, 8);
        const errLog = (msg: string, ...more: unknown[]) =>
          console.error(`[wacloud-platform ${rid}] ${msg}`, ...more);

        // 200 на всё, за что мы взялись: не-200 заставляет Meta переслать пачку заново в течение
        // 36 часов, а после серии неудач — отписать приложение от поля целиком.
        const ack = () => new Response("ok", { status: 200 });

        // Именно текст, не request.json(): подпись считается по тем байтам, что прислала Meta,
        // а повторная сериализация разобранного объекта даст другой отпечаток.
        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        // Секрет платформы, а не салона: подписывает наше приложение, одно на всех.
        const appSecret = process.env.META_APP_SECRET ?? "";
        if (!appSecret) {
          errLog("META_APP_SECRET не задан — принять вебхук невозможно");
          return new Response("Forbidden", { status: 403 });
        }
        const signature =
          request.headers.get("x-hub-signature-256") ?? request.headers.get("X-Hub-Signature-256");
        if (!(await waCloudVerifySignature(appSecret, rawBody, signature))) {
          errLog("подпись X-Hub-Signature-256 не сошлась");
          return new Response("Forbidden", { status: 403 });
        }

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (payload?.object && payload.object !== "whatsapp_business_account") return ack();

        // События САМОГО аккаунта — модерация шаблонов и бан WABA — приходят без
        // metadata.phone_number_id: адресат в них указан идентификатором WABA в entry[].id.
        // Разбираем их до маршрутизации по номеру, иначе маршрут честно скажет «маршрутизировать
        // не по чему» и выбросит единственное уведомление Meta о том, что салон заблокирован.
        const { handleWabaAccountEvent } = await import("@/lib/wa-connection.server");
        if (await handleWabaAccountEvent(payload)) return ack();

        // Единственный ключ маршрутизации. Парсер уже достаёт его из metadata, потому что тот же
        // идентификатор нужен и для дедупликации эха.
        const { phoneNumberId } = parseWaCloudWebhook(payload);
        if (!phoneNumberId) {
          errLog("в полезной нагрузке нет phone_number_id — маршрутизировать не по чему");
          return ack();
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // limit(2), а не maybeSingle(): на колонке нет уникального индекса, и один номер можно
        // привязать к двум салонам. maybeSingle() в этом случае бросает исключение, вебхук
        // отвечает 500, Meta начинает пересылать пачку по кругу — и всё это без единой строки о
        // настоящей причине. Забираем два и разбираемся сами.
        const { data: matches } = await supabaseAdmin
          .from("salon_secrets")
          .select("*")
          .eq("whatsapp_cloud_phone_number_id", phoneNumberId)
          .limit(2);

        const rows = matches ?? [];

        // Номер, которого мы не знаем. Штатная ситуация: салон отключился, но подписка на
        // стороне Meta ещё жива. Пишем в лог, а не в error_log — салона для привязки записи нет.
        if (rows.length === 0) {
          errLog(`неизвестный phone_number_id=${phoneNumberId}, салон не найден`);
          return ack();
        }

        // Один номер у двух салонов. Гадать, кому адресовано сообщение, нельзя: ответить не тому
        // — значит показать чужую переписку. Отказываемся обрабатывать и пишем в error_log
        // ОБОИМ, чтобы владелец увидел причину у себя, а не только мы в консоли.
        if (rows.length > 1) {
          const ids = rows.map((r: any) => r.salon_id);
          errLog(
            `phone_number_id=${phoneNumberId} привязан к нескольким салонам: ${ids.join(", ")}`,
          );
          const { logError } = await import("@/lib/error-log.server");
          for (const salonId of ids) {
            await logError({
              source: "wacloud-webhook",
              level: "error",
              message:
                "Один и тот же номер WhatsApp привязан к нескольким салонам — сообщения не обрабатываются. Отключите номер у лишнего салона.",
              salonId,
              context: { rid, phoneNumberId, salonIds: ids },
            });
          }
          return ack();
        }

        const secrets = rows[0];

        const salonId = (secrets as any).salon_id as string;
        const [{ data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin
            .from("salons")
            .select(
              "id, name, timezone, ai_assistant_enabled, whatsapp_ai_enabled, wa_provider, working_hours, address, slug, custom_domain",
            )
            .eq("id", salonId)
            .maybeSingle(),
          // select("*") — по той же причине, что и в соседних маршрутах: строка регулярно
          // обрастает колонками, и упоминание ещё не мигрированной роняет ВЕСЬ запрос, а с ним
          // и все ответы этого салона.
          supabaseAdmin
            .from("salon_ai_assistant")
            .select("*")
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        return await processWaCloudPayload({ salonId, rawBody, secrets, salon, assistant, rid });
      },
    },
  },
});
