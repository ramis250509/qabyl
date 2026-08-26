// Серверная функция за кнопкой «Подключить WhatsApp» в админке салона.
//
// Тонкая по замыслу: права и запись в базу здесь, весь разговор с Graph API — в
// wa-onboarding.server.ts. Так шаги подключения можно менять и проверять отдельно от того, кому
// и что мы разрешаем.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertSalonAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

/** Шестизначный PIN двухфакторной защиты номера. Салон его не видит и не вводит. */
function genPin(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return String(100000 + (((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 900000));
}

/**
 * Завершает подключение салона после того, как владелец прошёл окно Embedded Signup.
 *
 * Браузер приносит три вещи: одноразовый код, WABA ID и Phone Number ID. Дальше всё делается на
 * сервере, потому что в обмене кода участвует app secret.
 *
 * Порядок шагов не случаен. Токен нужен всем остальным, поэтому он первый и единственный, чья
 * неудача обрывает подключение. Подписка на вебхуки идёт раньше сохранения: салон, попавший в
 * базу без подписки, выглядит подключённым и молчит — худшее из состояний. Регистрация номера и
 * шаблоны, наоборот, не критичны в момент нажатия: номер из coexistence уже зарегистрирован, а
 * шаблоны нужны только для сообщений вне 24-часового окна. Их неудачи возвращаются владельцу
 * списком, но подключение не отменяют.
 */
export const finishWaOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        code: z.string().min(10).max(1024),
        wabaId: z.string().min(1).max(64),
        phoneNumberId: z.string().min(1).max(64),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);

    const {
      exchangeCodeForToken,
      subscribeAppToWaba,
      registerPhoneNumber,
      createNotificationTemplates,
    } = await import("@/lib/wa-onboarding.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const steps: { step: string; ok: boolean; detail?: string }[] = [];

    const exchanged = await exchangeCodeForToken(data.code);
    if (!exchanged.ok) {
      throw new Error(`Не удалось получить токен от Meta: ${exchanged.error}`);
    }
    steps.push({ step: "token", ok: true });

    steps.push(await subscribeAppToWaba(data.wabaId, exchanged.token));
    steps.push(await registerPhoneNumber(data.phoneNumberId, exchanged.token, genPin()));

    const { steps: tplSteps, templates } = await createNotificationTemplates(
      data.wabaId,
      exchanged.token,
    );
    steps.push(...tplSteps);

    // Секрет платформы, а не салона: подписывает наше приложение, одно на всех. Пишем его в
    // строку салона, чтобы работали ОБА вебхука — и общий, и пер-салонный, — а валидация
    // переключателя провайдера видела заполненное поле.
    const appSecret = process.env.META_APP_SECRET ?? null;

    const { error: saveErr } = await supabaseAdmin.from("salon_secrets").upsert(
      {
        salon_id: data.salonId,
        whatsapp_cloud_waba_id: data.wabaId,
        whatsapp_cloud_phone_number_id: data.phoneNumberId,
        whatsapp_cloud_token: exchanged.token,
        whatsapp_cloud_app_secret: appSecret,
        whatsapp_cloud_templates: templates,
      } as any,
      { onConflict: "salon_id" },
    );
    if (saveErr) throw new Error(`Подключение прошло, но не сохранилось: ${saveErr.message}`);

    // Флаг поднимаем, только если созданы ВСЕ пять. Частичный набор хуже отсутствующего: код
    // сочтёт шаблоны готовыми и отправит тот, которого нет, вместо того чтобы уйти в Green-API.
    const allTemplatesOk = tplSteps.every((s) => s.ok);
    if (allTemplatesOk) {
      await supabaseAdmin
        .from("salons")
        .update({ wa_cloud_templates_ready: true } as any)
        .eq("id", data.salonId);
    }

    return {
      ok: true,
      steps,
      templatesReady: allTemplatesOk,
      // Провайдера НЕ переключаем сами: перевод салона на официальный транспорт — осознанное
      // решение владельца, и у него для этого есть отдельный переключатель с предупреждениями.
      wabaId: data.wabaId,
      phoneNumberId: data.phoneNumberId,
    };
  });
