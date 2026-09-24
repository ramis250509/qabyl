// Возврат с instagram.com после «Подключить Instagram».
//
// Сессии Supabase на этом запросе нет, поэтому доверяем только подписанному `state`
// (см. src/lib/ig-oauth.server.ts) и ещё раз сверяем доступ к салону — роль могли снять за те
// минуты, что владелец был на instagram.com.
//
// Результат уходит обратно в кабинет кодом в ?ig=…: без токенов и без личных данных в адресе.
import { createFileRoute } from "@tanstack/react-router";

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/ig-oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { completeIgLogin, igAppSecret, publicBaseUrl, verifyIgState } =
          await import("@/lib/ig-oauth.server");
        const url = new URL(request.url);
        const base = publicBaseUrl();

        const state = await verifyIgState(url.searchParams.get("state") ?? "", igAppSecret());
        if (!state) return redirect(`${base}/admin?ig=expired`);
        const { salonId, userId } = state;
        // tab=instagram, а не tab=channels: второй открывает «Каналы» на WhatsApp, и владелец,
        // вернувшийся с instagram.com, не видел ни результата, ни подключённого аккаунта, пока
        // сам не нажимал «Instagram». Панель Instagram и показывает итог по коду из ?ig=.
        const back = (result: string) =>
          redirect(`${base}/admin/salons/${salonId}?tab=instagram&ig=${result}`);

        // Владелец нажал «Отмена» на экране Instagram.
        if (url.searchParams.get("error")) return back("cancelled");
        const code = url.searchParams.get("code") ?? "";
        if (!code) return back("failed");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { logError } = await import("@/lib/error-log.server");
        const record = (message: string, context: Record<string, unknown> = {}) =>
          logError({ source: "ig-webhook", level: "warn", message, salonId, context });

        const { data: allowed } = await supabaseAdmin.rpc("has_salon_access", {
          _user_id: userId,
          _salon_id: salonId,
        });
        if (!allowed) return back("forbidden");

        let conn;
        try {
          conn = await completeIgLogin({ code });
        } catch (e: any) {
          await record(`Подключение Instagram кнопкой не удалось: ${e?.message ?? e}`);
          return back("failed");
        }

        const { data: taken } = await supabaseAdmin
          .from("salon_secrets")
          .select("salon_id")
          .eq("instagram_user_id", conn.igUserId)
          .neq("salon_id", salonId)
          .limit(1);
        if (taken?.length) {
          await record(`Instagram-аккаунт ${conn.igUserId} уже подключён к другому салону`);
          return back("taken");
        }

        const { error } = await supabaseAdmin.from("salon_secrets").upsert(
          {
            salon_id: salonId,
            instagram_user_id: conn.igUserId,
            instagram_token: conn.token,
            // Своего секрета у такого салона нет: подпись вебхука проверяется секретом Qabyl.
            instagram_app_secret: null,
            instagram_token_expires_at: conn.expiresAt,
            instagram_connected_via: "platform",
          } as any,
          { onConflict: "salon_id" },
        );
        if (error) {
          await record(`Не удалось сохранить подключение Instagram: ${error.message}`);
          return back("failed");
        }

        if (conn.missingScopes.includes("instagram_business_manage_messages")) {
          return back("scopes");
        }
        if (conn.subscribeError) {
          await record(
            `Instagram подключён, но подписка на сообщения не прошла: ${conn.subscribeError}`,
          );
          return back("nosub");
        }
        return back("ok");
      },
    },
  },
});
