// Мост через Make: приём входящих WhatsApp, пока App Review не одобрен.
//
// ПОЧЕМУ ОН СУЩЕСТВУЕТ. Standard Access покрывает только WABA нашего бизнес-портфолио; обращение
// к чужой возвращает ошибку 200. До выдачи Advanced Access подключить салон к Cloud API напрямую
// нельзя. Make — официальный обходной путь: у него своё одобренное приложение Meta, он держит
// токен салона и вызывает Graph API за нас.
//
// ЧЕМ ЭТОТ МАРШРУТ ОТЛИЧАЕТСЯ ОТ ОБЛАЧНЫХ. Ровно двумя вещами:
//   1. Аутентификация. Подписи X-Hub-Signature-256 здесь нет — запрос шлёт Make, а не Meta.
//      Вместо неё общий секрет в заголовке, свой на каждый салон.
//   2. Транспорт. Отвечаем не в Graph API, а POST'ом в сценарий Make.
// Всё остальное — блокировка диалога, слив накопившихся сообщений, один ход агента на пачку,
// распознавание голосовых, оценка по фото, QR предоплаты, эскалация — переиспользуется как есть
// через processWaCloudPayload. Копии пайплайна здесь нет намеренно: она разъехалась бы с
// облачной на первой же правке, и разъехалась бы молча.
//
// ЭТО ВРЕМЕННО. Когда придёт Advanced Access, салон переподключается через своё окно, две
// колонки wa_make_* очищаются, и файл удаляется целиком. Ничего в облачном пути трогать не надо.
import { createFileRoute } from "@tanstack/react-router";
import { processWaCloudPayload, safeStringEquals } from "@/routes/api/public/wacloud.$salonId";
import { makeTransport, type WaMedia } from "@/lib/wa-transport.server";

/** Больше — и мы держим в памяти воркера чужую картинку без пользы. */
const MAX_INLINE_MEDIA_BYTES = 16 * 1024 * 1024;

function decodeBase64(data: string): Uint8Array | null {
  try {
    // Из Make может прийти data-URL целиком — отрезаем префикс, если он есть.
    const clean =
      data.includes(",") && data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
    const bin = atob(clean.replace(/\s/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

type NormalizeResult = {
  payload: any;
  media: Map<string, WaMedia>;
};

/**
 * Привести то, что прислал Make, к конверту Meta.
 *
 * Принимаем две формы. Если Make отдал вебхук Meta как есть (`object`/`entry`) — пропускаем без
 * изменений, парсеры разберут его сами. Если пришла плоская форма, собранная мышкой в сценарии,
 * — строим конверт здесь.
 *
 * Плоская форма — основная: собрать её в интерфейсе Make может человек, а пробросить исходное
 * тело вебхука там заметно сложнее, и ошибка в этом месте выглядела бы как «салон подключён и
 * молчит».
 */
function normalizeInbound(body: any): NormalizeResult {
  const media = new Map<string, WaMedia>();

  if (body?.object === "whatsapp_business_account" && Array.isArray(body?.entry)) {
    return { payload: body, media };
  }

  // Эхо: владелец ответил клиенту сам, со своего телефона. Отдельная ветка, потому что у Meta
  // это другое поле и другая форма — и именно она глушит ассистента на пять минут.
  if (body?.echo === true || body?.type === "echo") {
    return {
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "smb_message_echoes",
                value: {
                  metadata: { phone_number_id: String(body?.phoneNumberId ?? "make") },
                  message_echoes: [
                    {
                      to: String(body?.to ?? ""),
                      from: body?.from ? String(body.from) : undefined,
                      id: body?.messageId ? String(body.messageId) : undefined,
                      type: String(body?.mediaType ?? "text"),
                      timestamp: body?.timestamp ? String(body.timestamp) : undefined,
                      text: body?.text ? { body: String(body.text) } : undefined,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      media,
    };
  }

  const from = String(body?.from ?? "").replace(/\D/g, "");
  const messageId = body?.messageId ? String(body.messageId) : `make-${Date.now()}`;

  const msg: Record<string, unknown> = {
    from,
    id: messageId,
    timestamp: body?.timestamp ? String(body.timestamp) : undefined,
    type: "text",
  };

  if (body?.text) {
    msg.type = "text";
    msg.text = { body: String(body.text) };
  }

  // Медиа приезжает телом запроса, а не идентификатором: токен доступа к Graph API остаётся
  // внутри Make, и забрать файл сами мы не можем. Это цена всей схемы, и она же причина, по
  // которой сценарий Make обязан содержать модуль скачивания.
  for (const kind of ["image", "audio"] as const) {
    const m = body?.[kind];
    if (!m) continue;
    const id = String(m.id ?? `${kind}-${messageId}`);
    (msg as any)[kind] = { id, ...(m.caption ? { caption: String(m.caption) } : {}) };
    if (kind === "image" && m.caption) msg.type = "image";
    if (kind === "audio") msg.type = "audio";
    if (typeof m.data === "string" && m.data.length > 0) {
      const bytes = decodeBase64(m.data);
      if (bytes && bytes.byteLength <= MAX_INLINE_MEDIA_BYTES) {
        media.set(id, {
          bytes,
          mime: String(m.mime ?? (kind === "image" ? "image/jpeg" : "audio/ogg")),
        });
      }
    }
  }

  return {
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: String(body?.phoneNumberId ?? "make") },
                contacts: body?.name
                  ? [{ wa_id: from, profile: { name: String(body.name) } }]
                  : undefined,
                messages: [msg],
              },
            },
          ],
        },
      ],
    },
    media,
  };
}

export const Route = createFileRoute("/api/public/wamake/$salonId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const salonId = params.salonId;
        const rid = Math.random().toString(36).slice(2, 8);
        const errLog = (msg: string, ...rest: unknown[]) =>
          console.error(`[wamake ${rid}] ${msg}`, ...rest);

        // 200 после того, как ответственность за полезную нагрузку принята. Make на не-200
        // повторяет запрос и жжёт кредиты салона на бесконечной пересылке одного сообщения.
        const ack = () => new Response("ok", { status: 200 });

        let body: any;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: secrets } = await supabaseAdmin
          .from("salon_secrets")
          .select("*")
          .eq("salon_id", salonId)
          .maybeSingle();

        const s = (secrets ?? {}) as Record<string, any>;
        const expected = s.wa_make_token ?? "";
        const provided =
          request.headers.get("x-qabyl-token") ?? request.headers.get("X-Qabyl-Token") ?? "";

        // Адрес маршрута содержит только id салона, который не секрет. Без токена этот эндпоинт
        // не аутентифицирован вообще: кто угодно смог бы водить ассистента за нос и жечь бюджет
        // салона на Gemini. Отказ, а не приём «на всякий случай».
        if (!expected || !safeStringEquals(expected, provided)) {
          errLog(`отклонено: неверный токен моста, салон=${salonId}`);
          return new Response("Forbidden", { status: 403 });
        }

        const { payload, media } = normalizeInbound(body);

        const [{ data: salon }, { data: assistant }] = await Promise.all([
          supabaseAdmin
            .from("salons")
            .select(
              "id, name, timezone, ai_assistant_enabled, wa_provider, working_hours, address, slug, custom_domain",
            )
            .eq("id", salonId)
            .maybeSingle(),
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

        return await processWaCloudPayload({
          salonId,
          rawBody: JSON.stringify(payload),
          secrets,
          salon,
          assistant,
          rid,
          transport: makeTransport({
            outboundUrl: s.wa_make_outbound_url ?? "",
            token: s.wa_make_token ?? "",
            media,
          }),
        });
      },
    },
  },
});
