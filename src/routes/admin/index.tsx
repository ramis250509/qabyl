import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Building2, Calendar, Users, TrendingUp } from "lucide-react";
import { useAdminFilters } from "@/hooks/use-branch-filter";
import { BranchFilterBar } from "@/components/admin/BranchFilterBar";
import { useAuth } from "@/lib/auth-client";
import { useSalonTimezone, startOfDayInTz, addDaysInTz } from "@/lib/tz";
import { useRegisterRefresh } from "@/lib/refresh-context";

export const Route = createFileRoute("/admin/")({
  component: Dashboard,
});

function Dashboard() {
  const { isSuperAdmin } = useAuth();
  const filters = useAdminFilters();
  const { salonId, branchId } = filters;
  const tz = useSalonTimezone(salonId !== "all" ? salonId : null);
  const [stats, setStats] = useState({ salons: 0, masters: 0, today: 0, week: 0 });

  const load = useCallback(async () => {
    const now = new Date();
    const startToday = startOfDayInTz(now, tz).toISOString();
    const endToday = addDaysInTz(now, 1, tz).toISOString();
    const weekEnd = addDaysInTz(now, 7, tz).toISOString();
    const nowIso = now.toISOString();

    function applySalon<T extends { eq: (c: string, v: string) => T }>(q: T): T {
      return salonId !== "all" ? q.eq("salon_id", salonId) : q;
    }
    function applyBranch<T extends { eq: (c: string, v: string) => T }>(q: T): T {
      return branchId !== "all" ? q.eq("branch_id", branchId) : q;
    }

    const salonsQ = isSuperAdmin
      ? supabase.from("salons").select("*", { count: "exact", head: true })
      : Promise.resolve({ count: filters.salons.length });
    const mastersQ = applyBranch(applySalon(supabase.from("masters").select("*", { count: "exact", head: true }).eq("is_active", true)));
    const todayQ = applyBranch(applySalon(
      supabase.from("appointments").select("*", { count: "exact", head: true })
        .eq("status", "confirmed").gte("starts_at", startToday).lt("starts_at", endToday)
    ));
    const weekQ = applyBranch(applySalon(
      supabase.from("appointments").select("*", { count: "exact", head: true })
        .eq("status", "confirmed").gte("starts_at", nowIso).lt("starts_at", weekEnd)
    ));

    const [s, m, today, week] = await Promise.all([salonsQ, mastersQ, todayQ, weekQ]);
    setStats({ salons: (s as any).count ?? 0, masters: m.count ?? 0, today: today.count ?? 0, week: week.count ?? 0 });
  }, [salonId, branchId, isSuperAdmin, filters.salons.length, tz]);

  useEffect(() => { load(); }, [load]);
  useRegisterRefresh(load);


  const cards = [
    ...(isSuperAdmin ? [{ label: "Салонов", value: stats.salons, icon: Building2, color: "text-blue-500" }] : []),
    { label: "Мастеров", value: stats.masters, icon: Users, color: "text-purple-500" },
    { label: "Записей сегодня", value: stats.today, icon: Calendar, color: "text-green-500" },
    { label: "За 7 дней", value: stats.week, icon: TrendingUp, color: "text-orange-500" },
  ];

  return (
    <div className="p-4 sm:p-8 space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold">Дашборд</h1>
        <p className="text-muted-foreground">Обзор ваших салонов</p>
      </div>

      <BranchFilterBar filters={filters} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <Card key={c.label} className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{c.label}</p>
                <p className="text-3xl font-bold mt-1">{c.value}</p>
              </div>
              <c.icon className={`h-8 w-8 ${c.color}`} />
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-3">Быстрый старт</h2>
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal pl-4">
          <li><Link to="/admin/salons" className="text-primary hover:underline">Создайте салон</Link> — добавьте название, бренд, GreenAPI ключи</li>
          <li>Добавьте филиалы, укажите их часы работы</li>
          <li>Добавьте мастеров и привяжите их к филиалам</li>
          <li>Добавьте услуги и привяжите к мастерам</li>
          <li>Клиенты заходят на сайт и записываются — вы видите всё в <Link to="/admin/calendar" className="text-primary hover:underline">календаре</Link></li>
        </ol>
      </Card>
    </div>
  );
}
