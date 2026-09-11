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

        const url = new URL(request.url);
        const params: Record<string, string> = {};
        url.searchParams.forEach((v, k) => (params[k] = v));
        const raw = await request.text().catch(() => "");
        new URLSearchParams(raw).forEach((v, k) => (params[k] = v));

        if (!fpVerify(SCRIPT, params, cfg.secretKey)) {
          console.error(
            `[billing] Freedom Pay: подпись не сошлась, order=${params.pg_order_id ?? "?"}`,
          );
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
