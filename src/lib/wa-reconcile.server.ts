// Перезапуск сообщений, которые остались без обработки. ТОЛЬКО СЕРВЕР.
//
// ЗАЧЕМ. Вебхук Meta приходит один раз. Если в этот момент воркер упал, база моргнула или замок
// достался другому запросу, входящее сообщение остаётся лежать с processed_at = null, и клиент
// не получает ответа НИКОГДА — следующего вебхука по этому сообщению не будет.
//
// ЧТО БЫЛО ДО. Эту роль выполняла функция в базе wa_run_reconciliation(): раз в минуту она
// постила в /api/public/wa/<salon>?token=… — вебхук Green-API. Транспорт снесли 28.08.2026, а
// функция осталась стучаться в удалённый маршрут. То есть перезапуск был мёртв, и заметить это
// было нельзя: ни один салон в тот момент не работал на WhatsApp.
//
// КАК СЕЙЧАС. Раз в минуту cron дёргает /api/internal/cron/wa-reconcile, а эта функция находит
// застрявшие разговоры и прогоняет их через ТОТ ЖЕ путь, что и обычный вебхук
// (processWaCloudPayload с forceConversationIds) — с тем же замком, дедупликацией и лимитами.
// Дублировать ответ невозможно: обработанные сообщения помечаются внутри того же пути.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isExcludedByLookup, loadExcludedContacts } from "@/lib/excluded-contacts.server";

/** Сколько ждать, прежде чем считать сообщение потерянным. */
const STUCK_AFTER_MS = 5 * 60_000;
/** Старше двух суток не трогаем: отвечать через два дня хуже, чем не отвечать. */
const FLOOR_MS = 48 * 3_600_000;
const MAX_SALONS_PER_RUN = 5;
const MAX_CONVS_PER_SALON = 20;

export type ReconcileReport = {
  stuckMessages: number;
  salons: number;
  conversations: number;
  resumedPaused: number;
  skippedExcluded: number;
  errors: string[];
};

export async function runWaReconcile(nowMs = Date.now()): Promise<ReconcileReport> {
  const db = supabaseAdmin as any;
  const report: ReconcileReport = {
    stuckMessages: 0,
    salons: 0,
    conversations: 0,
    resumedPaused: 0,
    skippedExcluded: 0,
    errors: [],
  };

  const stuckBefore = new Date(nowMs - STUCK_AFTER_MS).toISOString();
  const floor = new Date(nowMs - FLOOR_MS).toISOString();

  const { data: msgs, error } = await db
    .from("wa_messages")
    .select("conversation_id, salon_id")
    .eq("direction", "in")
    .is("processed_at", null)
    .lt("created_at", stuckBefore)
    .gte("created_at", floor)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    report.errors.push(`выборка застрявших: ${error.message}`);
    return report;
  }
  report.stuckMessages = (msgs ?? []).length;
  if (report.stuckMessages === 0) return report;

  const bySalon = new Map<string, Set<string>>();
  for (const m of msgs as any[]) {
    if (!m.salon_id || !m.conversation_id) continue;
    const set = bySalon.get(m.salon_id) ?? new Set<string>();
    if (set.size < MAX_CONVS_PER_SALON) set.add(m.conversation_id);
    bySalon.set(m.salon_id, set);
  }

  const { processWaCloudPayload } = await import("@/routes/api/public/wacloud.$salonId");

  for (const [salonId, convSet] of [...bySalon.entries()].slice(0, MAX_SALONS_PER_RUN)) {
    try {
      const [{ data: secrets }, { data: salon }, { data: assistant }, { data: convs }, excluded] =
        await Promise.all([
          db.from("salon_secrets").select("*").eq("salon_id", salonId).maybeSingle(),
          db
            .from("salons")
            .select(
              "id, name, timezone, ai_assistant_enabled, whatsapp_ai_enabled, wa_provider, working_hours, address, slug, custom_domain",
            )
            .eq("id", salonId)
            .maybeSingle(),
          db.from("salon_ai_assistant").select("*").eq("salon_id", salonId).maybeSingle(),
          db
            .from("wa_conversations")
            .select("id, client_phone, channel, ai_paused, ai_paused_at")
            .in("id", [...convSet]),
          loadExcludedContacts(db, salonId),
        ]);

      // Без реквизитов Cloud API отвечать всё равно нечем — молча пропускаем, это не поломка.
      if (!secrets?.whatsapp_cloud_phone_number_id || !secrets?.whatsapp_cloud_token) continue;

      // Список «без Админа» не читается — не трогаем салон целиком: перезапуск не должен написать
      // в личный чат владельца, который он сам заглушил.
      if (!excluded.ok) {
        report.errors.push(`${salonId}: список исключений недоступен`);
        continue;
      }

      const ids: string[] = [];
      const toResume: string[] = [];
      for (const c of (convs ?? []) as any[]) {
        // Instagram живёт на своём маршруте — здесь только WhatsApp.
        if (c.channel === "instagram") continue;
        if (isExcludedByLookup(excluded, c.client_phone)) {
          report.skippedExcluded++;
          continue;
        }
        // Пауза после ручного ответа владельца: пока она свежая, ассистент молчит намеренно.
        if (c.ai_paused) {
          const pausedAt = c.ai_paused_at ? new Date(c.ai_paused_at).getTime() : 0;
          if (nowMs - pausedAt < STUCK_AFTER_MS) continue;
          toResume.push(c.id);
        }
        ids.push(c.id);
      }
      if (ids.length === 0) continue;

      if (toResume.length > 0) {
        await db
          .from("wa_conversations")
          .update({ ai_paused: false, ai_paused_at: null })
          .in("id", toResume);
        report.resumedPaused += toResume.length;
      }

      await processWaCloudPayload({
        salonId,
        rawBody: "{}",
        secrets,
        salon,
        assistant,
        rid: `rec-${Math.random().toString(36).slice(2, 8)}`,
        forceConversationIds: ids,
      });
      report.salons++;
      report.conversations += ids.length;
    } catch (e: any) {
      report.errors.push(`${salonId}: ${e?.message ?? e}`);
    }
  }

  return report;
}
