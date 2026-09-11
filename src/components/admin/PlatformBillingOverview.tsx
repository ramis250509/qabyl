// Биллинг всех салонов — экран владельца платформы.
//
// Два выключателя: общий (ограничения для всех салонов разом) и у каждого салона (освобождение).
// Расход сообщений считается всегда — выключатели решают только, ограничивать ли салон.
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { FullScreenLoader } from "@/components/ui/loading-state";
import {
  getPlatformBillingOverview,
  setBillingEnforcement,
  setBillingExempt,
} from "@/lib/billing.functions";

type Data = Awaited<ReturnType<typeof getPlatformBillingOverview>>;

const STATUS_LABEL: Record<string, string> = {
  trialing: "Пробный",
  active: "Оплачен",
  past_due: "Нужна оплата",
  suspended: "Заблокирован",
  canceled: "Отменён",
};

function fmtDate(d?: string | null): string {
  return d ? new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "—";
}

export function PlatformBillingOverview() {
  const [data, setData] = useState<Data | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getPlatformBillingOverview());
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось загрузить биллинг");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, okText: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(okText);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Не получилось");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <FullScreenLoader />;

  const q = query.trim().toLowerCase();
  const rows = q ? data.salons.filter((r) => r.name.toLowerCase().includes(q)) : data.salons;
  const paying = data.salons.filter((r) => r.exempt === false).length;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 animate-in fade-in-0 duration-300">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Биллинг салонов</h1>
        <p className="text-sm text-muted-foreground">
          Биллинг включён у {paying} из {data.salons.length} салонов
        </p>
      </header>

      <Card className="p-5">
        <label className="flex items-start gap-4 cursor-pointer">
          <Switch
            className="mt-0.5"
            checked={data.enforcementEnabled}
            disabled={busy !== null}
            onCheckedChange={(v) => {
              const question = v
                ? "Включить биллинг на платформе? Лимиты сообщений и блокировка за неоплату начнут действовать для всех салонов, у которых биллинг включён."
                : "Выключить биллинг для всех салонов? Никто не будет ограничен и заблокирован. Расход сообщений продолжит считаться.";
              if (!window.confirm(question)) return;
              run(
                "global",
                () => setBillingEnforcement({ data: { enabled: v } }),
                v ? "Биллинг включён на платформе" : "Биллинг выключен для всех салонов",
              );
            }}
          />
          <span className="space-y-1">
            <span className="block font-medium">Биллинг для всех салонов</span>
            <span className="block text-sm text-muted-foreground">
              {data.enforcementEnabled
                ? "Включён: салоны с включённым биллингом ограничены лимитами тарифа и блокируются при неоплате."
                : "Выключен: ни один салон не ограничен и не блокируется, даже если у него биллинг включён ниже."}
            </span>
          </span>
        </label>
      </Card>

      <Input
        placeholder="Найти салон"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Найти салон"
        className="max-w-sm"
      />

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-normal">Салон</th>
              <th className="px-4 py-3 font-normal">Тариф</th>
              <th className="px-4 py-3 font-normal">Статус</th>
              <th className="px-4 py-3 font-normal">До</th>
              <th className="px-4 py-3 font-normal">Биллинг</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t hover:bg-muted/40 transition-colors">
                <td className="px-4 py-3">
                  <Link
                    to="/admin/billing"
                    search={{ salon: r.id }}
                    className="font-medium hover:underline underline-offset-2"
                  >
                    {r.name}
                  </Link>
                  {!r.isActive && (
                    <span className="ml-2 text-xs text-muted-foreground">выключен</span>
                  )}
                </td>
                <td className="px-4 py-3">{r.planName ?? "—"}</td>
                <td className="px-4 py-3">
                  {r.exempt ? "Бесплатно" : r.status ? (STATUS_LABEL[r.status] ?? r.status) : "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{r.exempt ? "—" : fmtDate(r.until)}</td>
                <td className="px-4 py-3">
                  {r.exempt === null ? (
                    <span className="text-muted-foreground">нет тарифа</span>
                  ) : (
                    <Switch
                      checked={!r.exempt}
                      disabled={busy !== null}
                      aria-label={`Биллинг для ${r.name}`}
                      onCheckedChange={(on) =>
                        run(
                          `salon:${r.id}`,
                          () => setBillingExempt({ data: { salonId: r.id, exempt: !on } }),
                          on ? `Биллинг включён: ${r.name}` : `${r.name} освобождён от оплаты`,
                        )
                      }
                    />
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
