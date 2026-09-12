// Вебхук Gupshup: один адрес на салон, секрет прямо в пути.
//
// ПОЧЕМУ СЕКРЕТ В ПУТИ, А НЕ ПОДПИСЬ. У облачных маршрутов рядом стоит проверка
// X-Hub-Signature-256 — она работает, потому что запрос шлёт Meta и подписывает его app secret.
// Здесь запрос шлёт Gupshup, подписи у него нет вовсе. Значит либо общий секрет, либо эндпоинт без
// аутентификации: адрес с одним лишь идентификатором салона секретом не является, и по нему кто
// угодно смог бы водить ассистента за нос и жечь бюджет салона на Gemini. Взят тот же приём, что и
// у моста Make, только секрет переехал из заголовка в путь — Gupshup позволяет задать произвольный
// URL подписки, но не произвольные заголовки.
//
// ОПОЗНАНИЕ САЛОНА ДВОЙНОЕ. Токен в пути находит салон, а имя приложения / номер / WABA из самого
// события это подтверждают. Одного совпадения было бы достаточно ровно до первой ошибки в
// настройке: подписка, случайно наведённая с приложения одного салона на адрес другого, тихо
// смешала бы две переписки. Расхождение — отказ обрабатывать и запись в журнал, а не догадка.
//
// ПАЙПЛАЙНА ЗДЕСЬ НЕТ. Блокировка диалога, слив накопившихся сообщений, один ход агента на пачку,
// голосовые, фото, QR предоплаты, эскалация — всё это живёт в processWaCloudPayload и
// переиспользуется как есть. Копия пайплайна разъехалась бы с оригиналом на первой же правке.
import { createFileRoute } from "@tanstack/react-router";
import { processWaCloudPayload, safeStringEquals } from "@/routes/api/public/wacloud.$salonId";
import { gupshupTransport } from "@/lib/wa-transport.server";
import { normalizeGupshupEvent, redactForStorage } from "@/lib/wa-gupshup-events.server";

/** Значение wa_conversations.channel для диалогов, пришедших через BSP. */
const GUPSHUP_CHANNEL = "whatsapp_gupshup";

export const Route = createFileRoute("/api/public/wagupshup/$token")({
  server: {
    handlers: {
      // Проверка живости. Отвечает одинаково на любой токен — верный и неверный, — потому что
      // иначе этот адрес превращается в оракул: перебором можно было бы выяснить, какой токен
      // существует, не отправив ни одного события.
      GET: async () =>
        new Response(JSON.stringify({ ok: true, service: "qabyl-gupshup-webhook" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),

      POST: async ({ request, params }) => {
        const rid = Math.random().toString(36).slice(2, 8);
        const log = (m: string, ...rest: unknown[]) =>
          console.log(`[wagupshup ${rid}] ${m}`, ...rest);
        const errLog = (m: string, ...rest: unknown[]) =>
          console.error(`[wagupshup ${rid}] ${m}`, ...rest);

        // 200 после того, как ответственность за событие принята. Не-200 заставляет Gupshup слать
        // ту же пачку повторно, а после серии неудач — отписать приложение от событий целиком.
        const ack = () => new Response("ok", { status: 200 });

        let body: any;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const token = params.token ?? "";
        // Токен генерируем мы, он всегда 32 шестнадцатеричных символа. Отсечь мусор до похода в
        // базу дешевле, чем сходить в неё на каждый скан.
        if (!/^[0-9a-f]{16,64}$/i.test(token)) {
          errLog("отклонено: токен вебхука не похож на наш");
          return new Response("Forbidden", { status: 403 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // limit(2), а не maybeSingle(): на колонке есть уникальный индекс, но частичный, и
        // полагаться на схему в месте, где исключение означает 500 и вечную пересылку одной
        // пачки, не стоит. Забираем два и разбираемся сами.
        const { data: matches } = await supabaseAdmin
          .from("salon_secrets")
          .select("*")
          .eq("gupshup_webhook_token", token)
          .limit(2);

        const rows = (matches ?? []) as Record<string, any>[];

        if (rows.length === 0) {
          errLog("отклонено: салон с таким токеном вебхука не найден");
          return new Response("Forbidden", { status: 403 });
        }
        if (rows.length > 1) {
          // Гадать нельзя: ответить не тому салону — значит показать чужую переписку.
          errLog(
            `токен вебхука привязан к нескольким салонам: ${rows.map((r) => r.salon_id).join(", ")}`,
          );
          return new Response("Forbidden", { status: 403 });
        }

        const secrets = rows[0];
        const salonId = String(secrets.salon_id);

        // Сравнение в постоянное время: обычное сравнение выдаёт по времени ответа длину
        // совпавшего префикса, что превращает перебор токена из невозможного в долгий.
        if (!safeStringEquals(String(secrets.gupshup_webhook_token ?? ""), token)) {
          errLog("отклонено: токен не сошёлся при точной сверке");
          return new Response("Forbidden", { status: 403 });
        }

        const normalized = normalizeGupshupEvent(body);

        // Событие сохраняется ВСЕГДА и ДО обработки — включая то, которое мы сейчас отвергнем.
        // Ради этого таблица и заведена: вопрос «Gupshup вообще к нам стучался?» иначе упирается
        // в пустоту, а именно он первый при разборе «салон подключён и молчит».
        const quarantine = async (why: string | null) => {
          try {
            await supabaseAdmin.from("wa_webhook_events" as any).insert({
              salon_id: salonId,
              provider: "gupshup",
              event_type: normalized.eventType,
              external_id: normalized.externalId,
              raw: redactForStorage(body) as any,
              processed_at: why ? null : new Date().toISOString(),
              last_error: why,
            });
          } catch (e: any) {
            // Карантин — вспомогательный механизм. Уронить из-за него приём события значит
            // потерять само событие ради записи о нём.
            errLog(`не удалось записать событие в карантин: ${e?.message ?? e}`);
          }
        };

        // ---- Выключатель этапа 1. Стоит ПОСЛЕ карантина: если салон выключили, а Gupshup всё ещё
        // шлёт, это надо видеть, а не гадать.
        if (secrets.gupshup_enabled !== true) {
          await quarantine("Gupshup выключен для этого салона (gupshup_enabled = false)");
          log(`салон ${salonId} выключен — событие сохранено, но не обработано`);
          return ack();
        }

        // ---- Второе опознание. Токен уже сказал, ЧЕЙ это салон; событие должно это подтвердить.
        const expectedApp = String(secrets.gupshup_app_name ?? "");
        const expectedNumber = String(secrets.gupshup_source_number ?? "").replace(/\D/g, "");
        const expectedWaba = String(secrets.gupshup_waba_id ?? "");

        const claimedApp = normalized.appName;
        const claimedNumber = (normalized.phoneNumberId ?? "").replace(/\D/g, "");
        const claimedWaba = normalized.wabaId;

        // Сверяем ТОЛЬКО те признаки, которые в этом событии реально есть: в конверте Meta имени
        // приложения нет по определению, а в плоской форме Gupshup нет WABA. Требовать все три —
        // значит отвергать половину законных событий.
        const mismatch =
          (claimedApp && expectedApp && claimedApp !== expectedApp) ||
          (claimedNumber && expectedNumber && claimedNumber !== expectedNumber) ||
          (claimedWaba && expectedWaba && claimedWaba !== expectedWaba);

        if (mismatch) {
          const why =
            `Событие не принадлежит этому салону: приложение=${claimedApp ?? "—"} ` +
            `номер=${claimedNumber || "—"} waba=${claimedWaba ?? "—"}`;
          errLog(why);
          await quarantine(why);
          const { logError } = await import("@/lib/error-log.server");
          await logError({
            source: "wagupshup-webhook",
            level: "error",
            message:
              "Вебхук Gupshup получил событие чужого приложения. Проверьте, что подписка настроена на правильный адрес.",
            salonId,
            context: { rid, claimedApp, claimedNumber, claimedWaba },
          });
          return ack();
        }

        // ---- Сшивание двух идентификаторов.
        //
        // При отправке Gupshup возвращает СВОЙ messageId, и он ложится в green_api_message_id —
        // колонку, на которой держится вся дедупликация и вся сверка доставки. Метовский wamid мы
        // узнаём позже, из события о доставке, где приезжают оба. В этот момент строку и надо
        // «повысить»: метовский идентификатор занимает историческую колонку, собственный уходит в
        // provider_message_id. Без этого статусы доставки не сойдутся ни с одним нашим сообщением.
        for (const [wamid, gsId] of normalized.gsIds) {
          const { error } = await supabaseAdmin
            .from("wa_messages")
            .update({
              green_api_message_id: wamid,
              provider_message_id: gsId,
              provider: "gupshup",
            } as any)
            .eq("salon_id", salonId)
            .eq("green_api_message_id", gsId);
          if (error) errLog(`не удалось сшить gsId=${gsId} с wamid: ${error.message}`);
        }

        await quarantine(null);

        // Отметка живости канала — то, что потом покажет владельцу «последнее событие 12 минут
        // назад» вместо «кажется, всё работает».
        await supabaseAdmin
          .from("salon_secrets")
          .update({ gupshup_last_event_at: new Date().toISOString() } as any)
          .eq("salon_id", salonId);

        // История и синхронизация состояния приложения до агента не доходят — они уже сохранены
        // выше. Прогнать выгруженную переписку через ассистента значит ответить на всё, что клиент
        // писал до нашего появления.
        if (!normalized.payload) {
          log(`событие ${normalized.kinds.join(",")} сохранено без запуска ассистента`);
          return ack();
        }

        const [{ data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin
            .from("salons")
            .select(
              "id, name, timezone, ai_assistant_enabled, whatsapp_ai_enabled, wa_provider, working_hours, address, slug, custom_domain",
            )
            .eq("id", salonId)
            .maybeSingle(),
          // select("*") — по той же причине, что и в соседних маршрутах: строка регулярно обрастает
          // колонками, и упоминание ещё не мигрированной роняет ВЕСЬ запрос, а с ним и все ответы
          // этого салона.
          supabaseAdmin
            .from("salon_ai_assistant")
            .select("*")
            .eq("salon_id", salonId)
            .maybeSingle(),
        ]);

        if (!salon) {
          errLog(`салон ${salonId} не найден`);
          return ack();
        }

        const tx = gupshupTransport({
          apiKey: String(secrets.gupshup_api_key ?? ""),
          sourceNumber: expectedNumber,
          appName: expectedApp,
          media: normalized.media,
        });

        return await processWaCloudPayload({
          salonId,
          rawBody: JSON.stringify(normalized.payload),
          secrets,
          salon,
          assistant,
          rid,
          transport: tx,
          channel: GUPSHUP_CHANNEL,
        });
      },
    },
  },
});
