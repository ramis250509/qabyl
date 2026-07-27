import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-client";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";

export const Route = createFileRoute("/admin/errors")({
  component: ErrorsPage,
});

type ErrorRow = {
  id: number;
  ts: string;
  level: "error" | "warn" | "info";
  source: string;
  salon_id: string | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  fingerprint: string | null;
};

const LEVEL_STYLES: Record<string, string> = {
  error: "bg-red-500/10 text-red-500 border-red-500/20",
  warn: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  info: "bg-muted text-muted-foreground border-transparent",
};

function ErrorsPage() {
  const { isSuperAdmin, rolesLoading } = useAuth();
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | "error" | "warn" | "info">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [salonMap, setSalonMap] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    // Last 500 rows, most recent first — cron prunes anything older than 30 days.
    const { data, error } = await supabase
      .from("error_logs" as any)
      .select("id, ts, level, source, salon_id, message, stack, context, fingerprint")
      .order("ts", { ascending: false })
      .limit(500);
    if (error) {
      setRows([]);
    } else {
      const list = (data as unknown as ErrorRow[]) ?? [];
      setRows(list);
      const salonIds = Array.from(
        new Set(list.map((r) => r.salon_id).filter((s): s is string => !!s)),
      );
      if (salonIds.length) {
        const { data: salons } = await supabase
          .from("salons")
          .select("id, name")
          .in("id", salonIds);
        const map: Record<string, string> = {};
        for (const s of (salons as { id: string; name: string }[]) ?? []) map[s.id] = s.name;
        setSalonMap(map);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isSuperAdmin) load();
  }, [isSuperAdmin, load]);
  useRegisterRefresh(load);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (levelFilter !== "all" && r.level !== levelFilter) return false;
      if (!q) return true;
      const salonName = r.salon_id ? (salonMap[r.salon_id] ?? "") : "";
      return (
        r.message.toLowerCase().includes(q) ||
        r.source.toLowerCase().includes(q) ||
        salonName.toLowerCase().includes(q) ||
        (r.stack ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, levelFilter, salonMap]);

  const totals = useMemo(() => {
    const now = Date.now();
    const in24h = rows.filter((r) => now - new Date(r.ts).getTime() < 86_400_000);
    return {
      total: rows.length,
      errors24h: in24h.filter((r) => r.level === "error").length,
      warns24h: in24h.filter((r) => r.level === "warn").length,
    };
  }, [rows]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function clearOld() {
    if (!confirm("Удалить все записи старше 24 часов?")) return;
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    await supabase.from("error_logs" as any).delete().lt("ts", cutoff);
    await load();
  }

  if (rolesLoading)
    return (
      <div className="p-8">
        <LoadingState />
      </div>
    );
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
        <h1 className="text-2xl sm:text-3xl font-bold">Журнал ошибок</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Последние 500 записей, автоочистка старше 30 дней. Пишется из серверного кода и
          WA-вебхука; чтение — только суперадмин.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Всего в базе</div>
          <div className="text-2xl font-semibold">{totals.total}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Ошибок за 24ч</div>
          <div className="text-2xl font-semibold text-red-500">{totals.errors24h}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Предупреждений за 24ч</div>
          <div className="text-2xl font-semibold text-amber-500">{totals.warns24h}</div>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Input
          placeholder="Поиск: текст, source, салон, stack…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
        />
        <div className="flex gap-1">
          {(["all", "error", "warn", "info"] as const).map((l) => (
            <Button
              key={l}
              size="sm"
              variant={levelFilter === l ? "default" : "outline"}
              onClick={() => setLevelFilter(l)}
            >
              {l === "all" ? "Все" : l}
            </Button>
          ))}
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={load}>
          Обновить
        </Button>
        <Button size="sm" variant="outline" onClick={clearOld}>
          Очистить &lt;24ч
        </Button>
      </div>

      {loading ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">Записей нет.</Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const isOpen = expanded.has(r.id);
            const salonName = r.salon_id ? (salonMap[r.salon_id] ?? r.salon_id.slice(0, 8)) : null;
            return (
              <Card key={r.id} className="p-3 space-y-2">
                <button
                  onClick={() => toggle(r.id)}
                  className="w-full text-left flex flex-wrap gap-2 items-start"
                >
                  <span
                    className={`text-xs px-2 py-0.5 rounded border ${LEVEL_STYLES[r.level] ?? ""}`}
                  >
                    {r.level}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {r.source}
                  </span>
                  {salonName ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                      {salonName}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(r.ts).toLocaleString("ru-RU")}
                  </span>
                  <div className="w-full font-mono text-sm break-words">{r.message}</div>
                </button>
                {isOpen ? (
                  <div className="space-y-2 pt-2 border-t border-border/50">
                    {r.context ? (
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">context</div>
                        <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
                          {JSON.stringify(r.context, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {r.stack ? (
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">stack</div>
                        <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
                          {r.stack}
                        </pre>
                      </div>
                    ) : null}
                    {r.fingerprint ? (
                      <div className="text-xs text-muted-foreground">
                        group: <span className="font-mono">{r.fingerprint}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
