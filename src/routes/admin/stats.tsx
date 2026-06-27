import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth-client";
import { useAdminFilters } from "@/hooks/use-branch-filter";
import { BranchFilterBar } from "@/components/admin/BranchFilterBar";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";

export const Route = createFileRoute("/admin/stats")({
  component: StatsPage,
});

function StatsPage() {
  const { isSuperAdmin } = useAuth();
  const filters = useAdminFilters();
  const { salonId, branchId } = filters;
  const [period, setPeriod] = useState<"today" | "7" | "30" | "90">("30");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let sinceISO: string;
    let untilISO: string | null = null;
    if (period === "today") {
      const now = new Date();
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      sinceISO = start.toISOString();
      untilISO = end.toISOString();
    } else {
      sinceISO = new Date(Date.now() - Number(period) * 86400000).toISOString();
    }
    let q = supabase.from("appointments")
      .select("price, master_id, service_id, branch_id, status, masters(name), services(name), branches(name)")
      .gte("starts_at", sinceISO)
      .in("status", ["confirmed", "completed"]);
    if (untilISO) q = q.lte("starts_at", untilISO);
    if (salonId !== "all") q = q.eq("salon_id", salonId);
    if (branchId !== "all") q = q.eq("branch_id", branchId);
    const { data } = await q;
    setRows(data ?? []);
    setLoading(false);
  }, [salonId, branchId, period]);


  useEffect(() => { load(); }, [load]);
  useRegisterRefresh(load);

  const stats = useMemo(() => {
    const revenue = rows.reduce((s, a) => s + Number(a.price), 0);
    const byMaster: Record<string, { name: string; count: number; revenue: number }> = {};
    const byService: Record<string, { name: string; count: number; revenue: number }> = {};
    const byBranch: Record<string, { name: string; count: number; revenue: number }> = {};
    for (const a of rows as any[]) {
      const mk = a.master_id;
      byMaster[mk] ??= { name: a.masters?.name ?? "—", count: 0, revenue: 0 };
      byMaster[mk].count++; byMaster[mk].revenue += Number(a.price);
      const sk = a.service_id;
      byService[sk] ??= { name: a.services?.name ?? "—", count: 0, revenue: 0 };
      byService[sk].count++; byService[sk].revenue += Number(a.price);
      const bk = a.branch_id ?? "__none__";
      byBranch[bk] ??= { name: a.branches?.name ?? "Без филиала", count: 0, revenue: 0 };
      byBranch[bk].count++; byBranch[bk].revenue += Number(a.price);
    }
    return {
      revenue, count: rows.length,
      byMaster: Object.values(byMaster).sort((a, b) => b.revenue - a.revenue),
      byService: Object.values(byService).sort((a, b) => b.revenue - a.revenue),
      byBranch: Object.values(byBranch).sort((a, b) => b.revenue - a.revenue),
    };
  }, [rows]);

  const showBranchTable = branchId === "all" && stats.byBranch.length > 1;

  return (
    <div className="p-4 sm:p-8 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div><h1 className="text-2xl sm:text-3xl font-bold">Статистика</h1><p className="text-muted-foreground">Выручка и загруженность</p></div>
        <Select value={period} onValueChange={(v) => setPeriod(v as any)}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Сегодня</SelectItem>
            <SelectItem value="7">7 дней</SelectItem>
            <SelectItem value="30">30 дней</SelectItem>
            <SelectItem value="90">90 дней</SelectItem>
          </SelectContent>
        </Select>

      </div>

      <BranchFilterBar filters={filters} showSalon={isSuperAdmin || filters.salons.length > 1} />

      {loading && rows.length === 0 ? <Card><LoadingState /></Card> : null}

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Выручка</p>
          <p className="text-3xl sm:text-4xl font-bold mt-1">{stats.revenue.toLocaleString("ru-RU")} сом</p>
        </Card>
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Записей</p>
          <p className="text-3xl sm:text-4xl font-bold mt-1">{stats.count}</p>
        </Card>
      </div>

      {showBranchTable && (
        <Card className="p-6">
          <h3 className="font-semibold mb-3">По филиалам</h3>
          <div className="space-y-2">
            {stats.byBranch.map((b, i) => (
              <div key={i} className="flex items-center justify-between text-sm border-b last:border-0 pb-1.5">
                <span className="font-medium">{b.name} <span className="text-muted-foreground font-normal">({b.count} записей)</span></span>
                <span className="font-semibold">{b.revenue.toLocaleString("ru-RU")} сом</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-6">
          <h3 className="font-semibold mb-3">Топ мастеров</h3>
          <div className="space-y-2">
            {stats.byMaster.slice(0, 10).map((m, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span>{m.name} <span className="text-muted-foreground">({m.count})</span></span>
                <span className="font-medium">{m.revenue.toLocaleString("ru-RU")} сом</span>
              </div>
            ))}
            {stats.byMaster.length === 0 && <p className="text-sm text-muted-foreground">Нет данных</p>}
          </div>
        </Card>
        <Card className="p-6">
          <h3 className="font-semibold mb-3">Топ услуг</h3>
          <div className="space-y-2">
            {stats.byService.slice(0, 10).map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span>{s.name} <span className="text-muted-foreground">({s.count})</span></span>
                <span className="font-medium">{s.revenue.toLocaleString("ru-RU")} сом</span>
              </div>
            ))}
            {stats.byService.length === 0 && <p className="text-sm text-muted-foreground">Нет данных</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
