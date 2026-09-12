import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-client";
import { useAdminFilters } from "@/hooks/use-branch-filter";
import { BranchFilterBar } from "@/components/admin/BranchFilterBar";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";
import { Button } from "@/components/ui/button";
import { usePlanFeatures } from "@/hooks/use-plan-features";

export const Route = createFileRoute("/admin/stats")({
  component: StatsPage,
});

function StatsPage() {
  const { isSuperAdmin, salonId: ownSalonId } = useAuth();
  // Воронка ассистента, неявки и загрузка мастеров — «расширенная аналитика» тарифа.
  // Владелец платформы видит всё.
  const plan = usePlanFeatures(isSuperAdmin ? null : ownSalonId);
  const advanced = isSuperAdmin || plan.has("analytics_advanced");
  const filters = useAdminFilters();
  const { salonId, branchId } = filters;
  const [period, setPeriod] = useState<"today" | "7" | "30" | "month" | "90">("month");
  const [rows, setRows] = useState<any[]>([]);
  const [visits, setVisits] = useState<any[]>([]);
  const [convCount, setConvCount] = useState(0);
  const [stageRows, setStageRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Value/volume metrics are keyed on created_at (when the booking was MADE), NOT starts_at
    // (the visit date). This matches the owner's "сколько записей за этот месяц" mental model and
    // is the number that justifies the subscription — a booking made today for a visit next month
    // still counts toward this month's value. All statuses are loaded (including cancelled) and
    // split in JS, so a cancelled test booking is shown transparently rather than silently dropped
    // (which is what made the page read "4" when there were far more).
    let sinceISO: string;
    let untilISO: string | null = null;
    const now = new Date();
    if (period === "today") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      sinceISO = start.toISOString();
      untilISO = end.toISOString();
    } else if (period === "month") {
      sinceISO = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
    } else {
      sinceISO = new Date(Date.now() - Number(period) * 86400000).toISOString();
    }
    let q = supabase
      .from("appointments")
      // client_phone is what makes "возвращаемость" possible: it is the only stable identity a
      // client has across visits — there is no client account, and the same person books under
      // "Айгуль", "Айгуль К." and "айгуль" on different days.
      .select(
        "price, master_id, service_id, branch_id, status, source, client_phone, masters(name), services(name), branches(name)",
      )
      .gte("created_at", sinceISO);
    if (untilISO) q = q.lte("created_at", untilISO);
    if (salonId !== "all") q = q.eq("salon_id", salonId);
    if (branchId !== "all") q = q.eq("branch_id", branchId);

    // Chair-hours are the one metric on this page that CANNOT be keyed on created_at: a booking
    // made today for next month says nothing about how busy anyone was today. So it gets its own
    // query, keyed on the visit date, and capped at "now" — counting hours that haven't happened
    // yet would quietly inflate every master's workload.
    const visitsUntil = untilISO && new Date(untilISO) < now ? untilISO : now.toISOString();
    let vq = supabase
      .from("appointments")
      .select("master_id, starts_at, ends_at, status, masters(name)")
      .gte("starts_at", sinceISO)
      .lte("starts_at", visitsUntil)
      .in("status", ["confirmed", "completed"]);
    if (salonId !== "all") vq = vq.eq("salon_id", salonId);
    if (branchId !== "all") vq = vq.eq("branch_id", branchId);

    // Assistant funnel is a super-admin-only view, so only fetch its top-of-funnel number
    // (assistant conversations started in the period — WhatsApp and Instagram alike, they share
    // this table) for super admins. wa_conversations has no
    // branch dimension, so the branch filter doesn't apply here.
    let convPromise: Promise<{ count: number | null }> = Promise.resolve({ count: 0 });
    if (advanced) {
      // GET + count (limit 1), not HEAD: authenticated HEAD count requests intermittently 503 on the free tier.
      let cq = supabase
        .from("wa_conversations")
        .select("id", { count: "exact" })
        .gte("created_at", sinceISO)
        .limit(1);
      if (untilISO) cq = cq.lte("created_at", untilISO);
      if (salonId !== "all") cq = cq.eq("salon_id", salonId);
      convPromise = cq as any;
    }

    // Where conversations actually STOP. The card above already showed that conversion is low; it
    // could never say why, because the funnel stage was computed on every turn and then thrown
    // away. It is now persisted in state_data (see wa-agent-v4.server.ts), so this reads it back.
    //
    // Fetched as rows and tallied in JS rather than grouped in SQL: PostgREST has no GROUP BY, and
    // at a few hundred conversations a month the difference is not measurable.
    let stagePromise: Promise<{ data: any[] | null }> = Promise.resolve({ data: [] });
    if (advanced) {
      let sq = supabase
        .from("wa_conversations")
        .select("state_data, status")
        .gte("created_at", sinceISO)
        .limit(2000);
      if (untilISO) sq = sq.lte("created_at", untilISO);
      if (salonId !== "all") sq = sq.eq("salon_id", salonId);
      stagePromise = sq as any;
    }

    const [{ data }, conv, { data: visitData }, stageRows] = await Promise.all([
      q,
      convPromise,
      vq,
      stagePromise,
    ]);
    setRows(data ?? []);
    setVisits(visitData ?? []);
    setConvCount((conv as any).count ?? 0);
    setStageRows((stageRows as any).data ?? []);
    setLoading(false);
  }, [salonId, branchId, period, advanced]);

  useEffect(() => {
    load();
  }, [load]);
  useRegisterRefresh(load);

  const stats = useMemo(() => {
    // "Active" = a booking that will (or did) happen: confirmed or completed. Revenue counts only
    // these — a no-show earned nothing and a cancel never happened, so both are excluded from money
    // and shown separately, hiding nothing.
    const isActive = (a: any) => a.status === "confirmed" || a.status === "completed";
    const active = (rows as any[]).filter(isActive);
    const cancelledCount = (rows as any[]).filter((a) => a.status === "cancelled").length;
    const noShowRows = (rows as any[]).filter((a) => a.status === "no_show");
    const noShowCount = noShowRows.length;
    const aiCount = (rows as any[]).filter(
      (a) => a.source === "ai_assistant" && isActive(a),
    ).length;
    const revenue = active.reduce((s, a) => s + Number(a.price || 0), 0);
    const byMaster: Record<string, { name: string; count: number; revenue: number }> = {};
    const byService: Record<string, { name: string; count: number; revenue: number }> = {};
    const byBranch: Record<string, { name: string; count: number; revenue: number }> = {};
    const noShowByMaster: Record<string, { name: string; count: number }> = {};
    for (const a of active) {
      const mk = a.master_id;
      byMaster[mk] ??= { name: a.masters?.name ?? "—", count: 0, revenue: 0 };
      byMaster[mk].count++;
      byMaster[mk].revenue += Number(a.price || 0);
      const sk = a.service_id;
      byService[sk] ??= { name: a.services?.name ?? "—", count: 0, revenue: 0 };
      byService[sk].count++;
      byService[sk].revenue += Number(a.price || 0);
      const bk = a.branch_id ?? "__none__";
      byBranch[bk] ??= { name: a.branches?.name ?? "Без филиала", count: 0, revenue: 0 };
      byBranch[bk].count++;
      byBranch[bk].revenue += Number(a.price || 0);
    }
    for (const a of noShowRows) {
      const mk = a.master_id;
      noShowByMaster[mk] ??= { name: a.masters?.name ?? "—", count: 0 };
      noShowByMaster[mk].count++;
    }
    // No-show rate = no-shows / non-cancelled bookings. Cancellations are excluded — a booking
    // called off in advance is not a no-show. (Future confirmed visits sit in the base too; they
    // can only lower the rate, never inflate it, so the number is never alarmist.)
    const nonCancelled = active.length + noShowCount;
    const noShowRate = nonCancelled > 0 ? Math.round((noShowCount / nonCancelled) * 100) : 0;
    // Assistant funnel: conversations → bookings the assistant closed.
    const aiConversion = convCount > 0 ? Math.round((aiCount / convCount) * 100) : 0;

    // Средний чек. Считается по тем же активным записям, что и выручка, — иначе отменённая
    // запись с нулевой выручкой утянула бы среднее вниз и цифра перестала бы значить «сколько
    // в среднем оставляет клиент за визит».
    const avgTicket = active.length > 0 ? Math.round(revenue / active.length) : 0;

    // Возвращаемость. Личность клиента — это номер телефона: аккаунтов у клиентов нет, а один и
    // тот же человек записывается как «Айгуль», «Айгуль К.» и «айгуль» в разные дни. Номер
    // нормализуем до цифр, иначе +996 700 12-34-56 и 996700123456 сойдут за двух разных людей.
    const visitsByClient = new Map<string, number>();
    for (const a of active) {
      const digits = String(a.client_phone ?? "").replace(/\D/g, "");
      if (!digits) continue;
      visitsByClient.set(digits, (visitsByClient.get(digits) ?? 0) + 1);
    }
    const uniqueClients = visitsByClient.size;
    const repeatClients = [...visitsByClient.values()].filter((n) => n > 1).length;
    // ВАЖНО: это доля повторных ВНУТРИ периода, а не «сколько клиентов вернулось вообще».
    // Клиент, приходящий раз в квартал, в 30-дневном окне выглядит разовым. Поэтому на коротких
    // периодах цифра занижена — честнее смотреть на 90 днях.
    const repeatRate = uniqueClients > 0 ? Math.round((repeatClients / uniqueClients) * 100) : 0;

    // Часы в кресле по мастерам — из отдельной выборки по дате визита (см. загрузку).
    const hoursByMaster: Record<string, { name: string; minutes: number }> = {};
    for (const v of visits as any[]) {
      const from = new Date(v.starts_at).getTime();
      const to = new Date(v.ends_at).getTime();
      if (!(to > from)) continue;
      const mk = v.master_id;
      hoursByMaster[mk] ??= { name: v.masters?.name ?? "—", minutes: 0 };
      hoursByMaster[mk].minutes += Math.round((to - from) / 60000);
    }

    // ---- Funnel: how far conversations got.
    //
    // Counted on the FURTHEST stage reached, not the current one — a client who reached "picking a
    // time" and then drifted back to questions still proves the assistant got them that far.
    //
    // Conversations with no recorded stage are counted separately and shown as their own line
    // rather than folded into "new_lead". They predate the stage being persisted, and quietly
    // burying hundreds of them at the top of the funnel would invent a drop-off that never happened.
    const STAGE_LABELS: Array<[string, string]> = [
      ["new_lead", "Написал и замолчал"],
      ["discovery", "Разговор без услуги"],
      ["consulting", "Обсуждали услугу"],
      ["objection", "Возражение"],
      ["offer_booking", "Дошли до времени"],
      ["prepayment", "Ждём предоплату"],
      ["booked", "Записались"],
    ];
    const stageCounts: Record<string, number> = {};
    let unknownStage = 0;
    for (const c of stageRows as any[]) {
      const st = c?.state_data?.funnel_stage_best ?? c?.state_data?.funnel_stage ?? null;
      if (!st || !STAGE_LABELS.some(([k]) => k === st)) {
        unknownStage++;
        continue;
      }
      stageCounts[st] = (stageCounts[st] ?? 0) + 1;
    }
    const stageTotal = Object.values(stageCounts).reduce((a, b) => a + b, 0);
    const funnel = {
      total: stageTotal,
      unknown: unknownStage,
      rows: STAGE_LABELS.map(([key, label]) => {
        const count = stageCounts[key] ?? 0;
        return {
          key,
          label,
          count,
          pct: stageTotal > 0 ? Math.round((count / stageTotal) * 100) : 0,
        };
      }),
    };

    return {
      revenue,
      count: active.length,
      cancelledCount,
      aiCount,
      noShowCount,
      noShowRate,
      convCount,
      aiConversion,
      avgTicket,
      uniqueClients,
      repeatClients,
      repeatRate,
      funnel,
      hoursByMaster: Object.values(hoursByMaster).sort((a, b) => b.minutes - a.minutes),
      byMaster: Object.values(byMaster).sort((a, b) => b.revenue - a.revenue),
      byService: Object.values(byService).sort((a, b) => b.revenue - a.revenue),
      byBranch: Object.values(byBranch).sort((a, b) => b.revenue - a.revenue),
      noShowByMaster: Object.values(noShowByMaster).sort((a, b) => b.count - a.count),
    };
  }, [rows, visits, convCount, stageRows]);

  const showBranchTable = branchId === "all" && stats.byBranch.length > 1;

  return (
    <div className="p-4 sm:p-8 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Статистика</h1>
          <p className="text-muted-foreground">Выручка и загруженность</p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as any)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Сегодня</SelectItem>
            <SelectItem value="7">7 дней</SelectItem>
            <SelectItem value="30">30 дней</SelectItem>
            <SelectItem value="month">Этот месяц</SelectItem>
            <SelectItem value="90">90 дней</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <BranchFilterBar filters={filters} showSalon={isSuperAdmin || filters.salons.length > 1} />

      {loading && rows.length === 0 ? (
        <Card>
          <LoadingState />
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground -mt-2">
        Считается по дате создания записи (когда её оформили), а не по дате визита.
      </p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">Выручка</p>
          <p className="text-3xl sm:text-4xl font-bold mt-1">
            {stats.revenue.toLocaleString("ru-RU")} сом
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            средний чек {stats.avgTicket.toLocaleString("ru-RU")} сом
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">Записей</p>
          <p className="text-3xl sm:text-4xl font-bold mt-1">{stats.count}</p>
          <p className="text-xs text-muted-foreground mt-1 space-x-2">
            {stats.cancelledCount > 0 && <span>+ {stats.cancelledCount} отменённых</span>}
            {stats.noShowCount > 0 && <span>+ {stats.noShowCount} не пришли</span>}
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">Клиентов</p>
          <p className="text-3xl sm:text-4xl font-bold mt-1">{stats.uniqueClients}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {stats.repeatClients > 0
              ? `${stats.repeatClients} приходили не один раз (${stats.repeatRate}%)`
              : "повторных визитов пока нет"}
          </p>
        </Card>
        <Card className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">Через Ассистента</p>
          <p className="text-3xl sm:text-4xl font-bold mt-1">{stats.aiCount}</p>
          <p className="text-xs text-muted-foreground mt-1">записей оформил ассистент</p>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        Уникальные клиенты считаются по номеру телефона. Доля повторных — это повторные визиты
        <em> внутри выбранного периода</em>: клиент, который ходит раз в квартал, в окне на 30 дней
        выглядит разовым. Для честной картины смотрите 90 дней.
      </p>

      {/* Assistant funnel: how many assistant conversations turned into bookings. Super-admin only.
          Counts every channel — wa_conversations holds both WhatsApp and Instagram Direct. */}
      {advanced && (
        <Card className="p-4 sm:p-6">
          <h3 className="font-semibold mb-4">Воронка ассистента</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl sm:text-3xl font-bold">{stats.convCount}</p>
              <p className="text-xs text-muted-foreground mt-1">Диалогов с ассистентом</p>
            </div>
            <div>
              <p className="text-2xl sm:text-3xl font-bold">{stats.aiCount}</p>
              <p className="text-xs text-muted-foreground mt-1">Записались через бота</p>
            </div>
            <div>
              <p className="text-2xl sm:text-3xl font-bold">{stats.aiConversion}%</p>
              <p className="text-xs text-muted-foreground mt-1">Конверсия в запись</p>
            </div>
          </div>
          {stats.convCount > 0 && (
            <div className="mt-4 h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, stats.aiConversion)}%` }}
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-3">
            Диалог — это клиент, написавший ассистенту в WhatsApp или Instagram Direct. Конверсия
            показывает, какую долю из них ассистент довёл до записи.
          </p>
        </Card>
      )}

      {/* Where conversations stop. The card above says HOW MANY convert; this one says WHERE the
          rest are lost, which is the only version of the number anyone can act on. */}
      {advanced && (
        <Card className="p-4 sm:p-6">
          <h3 className="font-semibold mb-1">Где обрываются диалоги</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Самый дальний этап, которого диалог достиг. Если клиент дошёл до выбора времени, а потом
            вернулся к вопросам — он всё равно засчитан по дальнему этапу.
          </p>
          {stats.funnel.total === 0 ? (
            <p className="text-sm text-muted-foreground">
              За выбранный период нет диалогов с записанным этапом.
            </p>
          ) : (
            <div className="space-y-2">
              {stats.funnel.rows.map((r) => (
                <div key={r.key} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 text-sm">{r.label}</div>
                  <div className="flex-1 h-6 rounded bg-muted overflow-hidden">
                    <div
                      className={`h-full ${r.key === "booked" ? "bg-green-600" : "bg-primary"}`}
                      style={{ width: `${r.pct}%` }}
                    />
                  </div>
                  <div className="w-20 shrink-0 text-right text-sm tabular-nums">
                    {r.count} · {r.pct}%
                  </div>
                </div>
              ))}
            </div>
          )}
          {stats.funnel.unknown > 0 && (
            <p className="text-xs text-amber-700 mt-3">
              Ещё {stats.funnel.unknown} диалог(ов) без этапа — они прошли до того, как мы начали
              его записывать. Эта строка будет уменьшаться сама.
            </p>
          )}
        </Card>
      )}

      {/* No-show analytics — only meaningful once visits are being marked in the calendar. */}
      {!advanced && <LockedAnalyticsCard />}

      {advanced && (
        <Card className="p-4 sm:p-6">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h3 className="font-semibold">Неявки (No-Show)</h3>
            <span className="text-sm text-muted-foreground">
              {stats.noShowCount} неявок · {stats.noShowRate}% записей
            </span>
          </div>
          {stats.noShowByMaster.length > 0 ? (
            <div className="space-y-2 mt-3">
              {stats.noShowByMaster.slice(0, 10).map((m, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-sm border-b last:border-0 pb-1.5"
                >
                  <span>{m.name}</span>
                  <span className="font-medium text-red-600">{m.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-2">
              Неявок нет. Отмечайте «Не пришёл» в календаре после визита — здесь появится
              статистика.
            </p>
          )}
        </Card>
      )}

      {showBranchTable && (
        <Card className="p-4 sm:p-6">
          <h3 className="font-semibold mb-3">По филиалам</h3>
          <div className="space-y-2">
            {stats.byBranch.map((b, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm border-b last:border-0 pb-1.5"
              >
                <span className="font-medium">
                  {b.name}{" "}
                  <span className="text-muted-foreground font-normal">({b.count} записей)</span>
                </span>
                <span className="font-semibold">{b.revenue.toLocaleString("ru-RU")} сом</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4 sm:p-6">
          <h3 className="font-semibold mb-3">Топ мастеров</h3>
          <div className="space-y-2">
            {stats.byMaster.slice(0, 10).map((m, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span>
                  {m.name} <span className="text-muted-foreground">({m.count})</span>
                </span>
                <span className="font-medium">{m.revenue.toLocaleString("ru-RU")} сом</span>
              </div>
            ))}
            {stats.byMaster.length === 0 && (
              <p className="text-sm text-muted-foreground">Нет данных</p>
            )}
          </div>
        </Card>
        {advanced && (
          <Card className="p-4 sm:p-6">
            <h3 className="font-semibold mb-3">Часы в кресле</h3>
            <div className="space-y-2">
              {stats.hoursByMaster.slice(0, 10).map((m, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span>{m.name}</span>
                  <span className="font-medium">
                    {Math.floor(m.minutes / 60)} ч{" "}
                    {m.minutes % 60 > 0 ? `${m.minutes % 60} мин` : ""}
                  </span>
                </div>
              ))}
              {stats.hoursByMaster.length === 0 && (
                <p className="text-sm text-muted-foreground">Визитов за период не было</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Считается по дате визита и только по уже прошедшим — в отличие от остальных цифр на
              этой странице, которые считаются по дате оформления записи.
            </p>
          </Card>
        )}
        <Card className="p-4 sm:p-6">
          <h3 className="font-semibold mb-3">Топ услуг</h3>
          <div className="space-y-2">
            {stats.byService.slice(0, 10).map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span>
                  {s.name} <span className="text-muted-foreground">({s.count})</span>
                </span>
                <span className="font-medium">{s.revenue.toLocaleString("ru-RU")} сом</span>
              </div>
            ))}
            {stats.byService.length === 0 && (
              <p className="text-sm text-muted-foreground">Нет данных</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Что даёт расширенная аналитика — показывается вместо неё на тарифе без неё. */
function LockedAnalyticsCard() {
  return (
    <Card className="p-4 sm:p-6 border-dashed">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex-1 space-y-1">
          <h3 className="font-semibold">Расширенная аналитика</h3>
          <p className="text-sm text-muted-foreground">
            Воронка ассистента — на каком шаге клиенты уходят, не записавшись. Неявки по мастерам.
            Часы в кресле — кто из мастеров загружен, а кто простаивает.
          </p>
        </div>
        <Button asChild variant="outline" className="shrink-0">
          <Link to="/admin/billing">Доступно на тарифе выше</Link>
        </Button>
      </div>
    </Card>
  );
}
