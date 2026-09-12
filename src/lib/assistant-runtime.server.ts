// Настройки ассистента, приведённые к тому виду, в котором их ждёт агент.
//
// Жило внутри маршрута Green-API, пока тот был единственным входом. Вынесено сюда, когда входов
// стало несколько: облачный вебхук зависел от файла, который мы собираемся удалить, и удаление
// уронило бы работающий Cloud API вместе с отключаемым транспортом.
//
// Поле hasGreenApiCreds пока остаётся: на него смотрит код, который уходит следующими шагами.

/**
 * @param channel Канал, из которого пришло сообщение. У каждого свой выключатель, и общий
 *   выключатель салона имеет приоритет: выключен он — молчат все.
 *
 *   Для WhatsApp это salons.whatsapp_ai_enabled (миграция 20260912090000), для Instagram —
 *   salons.instagram_enabled: он и раньше значил ровно «ИИ работает в Instagram», маршрут
 *   /api/public/ig проверяет его и для директа, и для комментариев, поэтому второй колонки
 *   рядом с ним не заводили.
 *
 *   `?? true` на обеих колонках — не вежливость: база, к которой миграция ещё не применена,
 *   должна вести себя как раньше, а не замолчать во всех каналах разом.
 */
export function resolveAssistantRuntimeConfig(
  salon: any,
  assistant: any,
  secrets: any,
  channel: "whatsapp" | "instagram" = "whatsapp",
) {
  const channelEnabled =
    channel === "instagram"
      ? (salon?.instagram_enabled ?? true) !== false
      : (salon?.whatsapp_ai_enabled ?? true) !== false;
  const assistantEnabled =
    (salon?.ai_assistant_enabled ?? true) !== false &&
    (assistant?.enabled ?? true) &&
    channelEnabled;
  const hasGreenApiCreds = Boolean(secrets?.greenapi_instance && secrets?.greenapi_token);
  return {
    assistantEnabled,
    hasGreenApiCreds,
    // V4 is the sanctioned default (2026-07-27). V3 stays as an explicit opt-in fallback via
    // the admin UI — flip a salon back to 'v3' only if V4 misbehaves for their specific setup.
    engine: assistant?.engine === "v3" ? ("v3" as const) : ("v4" as const),
    assistantConfig: {
      greeting: assistant?.greeting ?? null,
      tone_instructions: assistant?.tone_instructions ?? null,
      pricing_rules: assistant?.pricing_rules ?? null,
      languages: assistant?.languages?.length ? assistant.languages : ["ru"],
      manage_cutoff_hours: assistant?.manage_cutoff_hours ?? 0,
      knowledge_base: assistant?.knowledge_base ?? null,
      ai_rules: (assistant as any)?.ai_rules ?? null,
      rich_formatting: (assistant as any)?.rich_formatting ?? false,
      client_addressing: assistant?.client_addressing ?? null,
      industry: assistant?.industry ?? null,
      knowledge_answers: assistant?.knowledge_answers ?? null,
      sales_style: (assistant as any)?.sales_style ?? null,
      sales_mode: assistant?.sales_mode ?? false,
      start_language: (assistant as any)?.start_language ?? null,
      entry_service_id: (assistant as any)?.entry_service_id ?? null,
      sales_price_framing: (assistant as any)?.sales_price_framing ?? null,
      // Sales playbook (migration 20260810120000). `?? null` rather than `?? []` so a salon
      // whose row predates the migration is indistinguishable from one with an empty
      // playbook — parseSalesPlaybook treats both as "no playbook" and renders nothing.
      sales_usp: (assistant as any)?.sales_usp ?? null,
      sales_objections: (assistant as any)?.sales_objections ?? null,
      sales_promos: (assistant as any)?.sales_promos ?? null,
      booking_link_mode: (assistant as any)?.booking_link_mode ?? "auto",
    },
  };
}
