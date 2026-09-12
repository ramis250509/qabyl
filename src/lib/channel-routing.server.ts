// Кому адресовано входящее сообщение: какому салону и какой его точке.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Вопрос один, а спрашивают его три вебхука (своё приложение салона, общее
// приложение Qabyl, мост Gupshup) плюс Instagram. Три реализации одного вопроса рано или поздно
// начинают отвечать по-разному — обычно в тот день, когда сеть подключает второй номер.
//
// ПОРЯДОК ПОИСКА. Сначала salon_channels — новая модель, где у канала есть область действия:
// общий на сеть или закреплённый за точкой. Если строки нет, возвращаемся к salon_secrets, как
// было. Это не вежливость к старому коду: пока владельцы не переподключили каналы, salon_secrets
// остаётся единственным местом, где лежат их реквизиты, и отключить его значит выключить им
// связь. Откат происходит сам, когда переподключение произойдёт.
import type { SupabaseClient } from "@supabase/supabase-js";

export type ChannelKind = "whatsapp" | "instagram";

export type ChannelRoute = {
  channelId: string | null;
  salonId: string;
  /**
   * Точка, за которой закреплён канал. NULL — канал общий на сеть, и ассистент спрашивает
   * клиента, куда он хочет записаться (сегодняшнее поведение одноточечных салонов).
   */
  branchId: string | null;
  /** Отвечает ли ассистент именно в этом канале. */
  aiEnabled: boolean;
};

/**
 * Найти салон и точку по тому, чем канал представился во входящем вебхуке.
 *
 * @param externalId phone_number_id у WhatsApp Cloud API, instagram_user_id у Instagram.
 */
export async function routeByExternalId(
  db: SupabaseClient<any, any, any>,
  kind: ChannelKind,
  externalId: string,
): Promise<ChannelRoute | null> {
  if (!externalId) return null;
  const { data, error } = await (db as any).rpc("resolve_channel", {
    _kind: kind,
    _external_id: externalId,
  });
  // Ошибка тут — это «функции ещё нет» или «база недоступна». Молча возвращаем null: вызывающий
  // откатится к salon_secrets и сообщение дойдёт. Уронить доставку из-за нового кода нельзя.
  if (error || !data?.length) return null;
  const row = data[0];
  return {
    channelId: row.channel_id as string,
    salonId: row.salon_id as string,
    branchId: (row.branch_id as string | null) ?? null,
    aiEnabled: row.ai_enabled !== false,
  };
}

/**
 * Область действия канала салона, когда салон уже известен из адреса вебхука.
 *
 * Пер-салонные маршруты (своё приложение, Instagram) не нуждаются в поиске салона — он в URL.
 * Им нужно только одно: закреплён канал за точкой или общий.
 */
export async function branchForSalonChannel(
  db: SupabaseClient<any, any, any>,
  salonId: string,
  kind: ChannelKind,
): Promise<string | null> {
  const { data, error } = await (db as any)
    .from("salon_channels")
    .select("branch_id")
    .eq("salon_id", salonId)
    .eq("kind", kind)
    .eq("is_active", true)
    .limit(1);
  if (error || !data?.length) return null;
  return (data[0].branch_id as string | null) ?? null;
}
