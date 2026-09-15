// Уведомления Freedom Pay о результате платежа (pg_result_url).
//
// Имя «скрипта» для подписи — последний сегмент пути, то есть "freedompay": Freedom Pay
// подписывает уведомление по той же схеме, что и запросы к себе, подставляя имя нашего адреса.
//
// Ответ — всегда подписанный XML. Не ответим или ответим невалидно — Freedom Pay повторит через
// 30 минут и так в течение двух часов; обработчик идемпотентен, повтор ничего не сломает.
import { createFileRoute } from "@tanstack/react-router";
import { fpCallbackResponse, fpVerify, freedomPayConfig } from "@/lib/freedompay.server";

const SCRIPT = "freedompay";

function xml(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

export const Route = createFileRoute("/api/public/billing/freedompay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const cfg = freedomPayConfig();
        if (!cfg) return new Response("Payments not configured", { status: 503 });

        if (
          !request.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/x-www-form-urlencoded")
        ) {
          return new Response("Unsupported content type", { status: 415 });
        }
        const reader = request.body?.getReader();
        if (!reader) return new Response("Empty request", { status: 400 });
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32768) {
            await reader.cancel();
            return new Response("Too large", { status: 413 });
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const params: Record<string, string> = Object.create(null);
        for (const [key, value] of new URLSearchParams(new TextDecoder().decode(bytes))) {
          if (key in params || !/^pg_[a-z0-9_]+$/.test(key))
            return new Response("Invalid fields", { status: 400 });
          params[key] = value;
        }

        if (!fpVerify(SCRIPT, params, cfg.secretKey)) {
          console.error("[billing] Freedom Pay: invalid signature");
          return xml(fpCallbackResponse(SCRIPT, "rejected", "Bad signature", cfg.secretKey), 400);
        }

        try {
          const { handleFreedomPayResult } = await import("@/lib/billing.server");
          const res = await handleFreedomPayResult(params);
          return xml(fpCallbackResponse(SCRIPT, res.status, res.description, cfg.secretKey));
        } catch (e) {
          console.error(`[billing] Freedom Pay handler: ${(e as Error).message}`);
          // 500 — пусть Freedom Pay повторит: ошибка на нашей стороне, платёж терять нельзя.
          return new Response("Internal error", { status: 500 });
        }
      },
    },
  },
});
