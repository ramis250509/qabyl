import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-client";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";
import { CheckCircle2, XCircle } from "lucide-react";

export const Route = createFileRoute("/admin/ops")({
  component: OpsPage,
});

type OpsRow = {
  salon_id: string;
  salon_name: string;
  whatsapp_enabled: boolean;
  ai_enabled: boolean;
  engine: string;
  has_credentials: boolean;
  bookings_7d: number;
  ai_bookings_7d: number;
  no_show_30d: number;
  conversations_7d: number;
  last_activity: string | null;
};

function OpsPage() {
  const { isSuperAdmin, rolesLoading } = useAuth();
  const [rows, setRows] = useState<OpsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("ops_salon_overview" as any);
    if (error) {
      setRows([]);
    } else {
      setRows((data as OpsRow[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isSuperAdmin) load();
  }, [isSuperAdmin, load]);
  useRegisterRefresh(load);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.salon_name.toLowerCase().includes(q));
  }, [rows, query]);

  const totals = useMemo(
    () => ({
      salons: rows.length,
      live: rows.filter((r) => r.whatsapp_enabled && r.has_credentials).length,
      aiOn: rows.filter((r) => r.ai_enabled).length,
      bookings7d: rows.reduce((s, r) => s + r.bookings_7d, 0),
      aiBookings7d: rows.reduce((s, r) => s + r.ai_bookings_7d, 0),
    }),
    [rows],
  );

  if (rolesLoading) return <div className="p-8"><LoadingState /></div>;
  if (!isSuperAdmin) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Раздел доступен только суперадмину.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold">Ops Dashboard</h1>
        <p className="text-muted-foreground">Состояние всех подключённых салонов</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat label="Салонов" value={totals.salons} />
        <Stat label="Активны (WA + ключи)" value={totals.live} />
        <Stat label="ИИ включён" value={totals.aiOn} />
        <Stat label="Записей за 7 дней" value={totals.bookings7d} />
        <Stat label="Из них ботом" value={totals.aiBookings7d} />
      </div>

      <Input
        placeholder="Поиск салона…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-xs"
      />

      {loading && rows.length === 0 ? (
        <Card><LoadingState /></Card>
      ) : (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <Th>Салон</Th>
                <Th center>WhatsApp</Th>
                <Th center>ИИ</Th>
                <Th center>Движок</Th>
                <Th center>Ключи</Th>
                <Th center>Записей 7д</Th>
                <Th center>Ботом 7д</Th>
                <Th center>Диалогов 7д</Th>
                <Th center>Неявки 30д</Th>
                <Th>Активность</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.salon_id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="p-3 font-medium">
                    <Link to="/admin/salons/$salonId" params={{ salonId: r.salon_id }} className="hover:underline">
                      {r.salon_name}
                    </Link>
                  </td>
                  <Td center><Bool on={r.whatsapp_enabled} /></Td>
                  <Td center><Bool on={r.ai_enabled} /></Td>
                  <Td center>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${r.engine === "v4" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                      {r.engine}
                    </span>
                  </Td>
                  <Td center><Bool on={r.has_credentials} /></Td>
                  <Td center>{r.bookings_7d}</Td>
                  <Td center>{r.ai_bookings_7d}</Td>
                  <Td center>{r.conversations_7d}</Td>
                  <Td center className={r.no_show_30d > 0 ? "text-red-600 font-medium" : ""}>{r.no_show_30d}</Td>
                  <Td className="text-muted-foreground whitespace-nowrap">{relTime(r.last_activity)}</Td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">Ничего не найдено</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </Card>
  );
}

function Th({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return <th className={`p-3 font-medium ${center ? "text-center" : ""}`}>{children}</th>;
}
function Td({ children, center, className = "" }: { children: React.ReactNode; center?: boolean; className?: string }) {
  return <td className={`p-3 ${center ? "text-center" : ""} ${className}`}>{children}</td>;
}
function Bool({ on }: { on: boolean }) {
  return on ? (
    <CheckCircle2 className="h-4 w-4 text-green-600 inline" />
  ) : (
    <XCircle className="h-4 w-4 text-muted-foreground/40 inline" />
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} дн назад`;
}
