// Почему человека выкинуло из кабинета.
//
// ЗАЧЕМ ЭТО СУЩЕСТВУЕТ. Вылет на экран входа случается на чужом телефоне, без консоли, и к
// моменту жалобы («вчера вечером выкинуло») от него не остаётся никаких следов. Дальше начинается
// гадание: сеть? Meta? Supabase? выход на ноутбуке? Каждая версия правдоподобна, ни одну нельзя
// проверить. Этот журнал превращает догадку в запись: src/lib/auth-client.ts складывает события
// сессии в localStorage, а сюда они приезжают при следующем удачном входе.
//
// ЧЕГО ЗДЕСЬ НЕТ. Токенов, паролей, тела запросов. Только имя события, код ошибки от GoTrue,
// время, модель браузера и признак «запущено как приложение» — то есть ровно то, по чему
// различаются сценарии вылета, и ничего сверх.
//
// ПОЧЕМУ ТРЕБУЕТ АВТОРИЗАЦИИ, хотя пишет про потерю авторизации. Открытый эндпоинт, пишущий в
// error_logs, — это приглашение забить журнал ошибок мусором. Отчёт уезжает не в момент вылета,
// а когда человек вернулся и вошёл: тогда сессия есть, и писать можно от его имени.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const entry = z.object({
  at: z.number(),
  kind: z.string().max(64),
  detail: z.string().max(200).optional(),
});

export const reportAuthDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        entries: z.array(entry).max(24),
        userAgent: z.string().max(300),
        standalone: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (data.entries.length === 0) return { logged: false };

    const { logError } = await import("@/lib/error-log.server");
    const rejected = data.entries.filter((e) => e.kind === "recover-rejected");
    const recovered = data.entries.filter((e) => e.kind === "recover-ok");

    // Уровень выбирается по исходу, а не по факту события. Восстановленная сессия — это успех
    // страховки, и будить по ней ночью некого: она попадает в журнал как info, чтобы было видно,
    // насколько часто страховка срабатывает. Отказ сервера — настоящая потеря доступа.
    await logError({
      level: rejected.length > 0 ? "warn" : "info",
      source: "client",
      userId: context.userId,
      message:
        rejected.length > 0
          ? "Сессия потеряна: сервер отклонил refresh-токен"
          : "Сессия восстановлена после разрыва",
      // Группируем по первому коду отказа: так в /admin/errors одинаковые вылеты складываются в
      // одну строку со счётчиком, а не растекаются двадцатью одинаковыми записями.
      fingerprint: "auth-session|" + (rejected[0]?.detail?.split(":")[0] ?? "recovered"),
      context: {
        entries: data.entries,
        userAgent: data.userAgent,
        standalone: data.standalone,
        rejectedCount: rejected.length,
        recoveredCount: recovered.length,
      },
    });

    return { logged: true };
  });
