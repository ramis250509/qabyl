import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CalendarDays, Clock, MapPin, Phone, Scissors, User, CheckCircle2, XCircle, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/manage/$token")({
  head: () => ({ meta: [{ title: "Моя запись — Qabyl" }] }),
  component: ManagePage,
});

// Snapshot returned by get_appointment_by_token. Kept intentionally free of PII (no phone).
type Snapshot = {
  found: boolean;
  status?: string;
  starts_at?: string;
  ends_at?: string;
  price?: number;
  client_first_name?: string;
  salon_name?: string;
  salon_address?: string | null;
  salon_phone?: string | null;
  timezone?: string;
  master_id?: string;
  master_name?: string;
  service_id?: string;
  service_name?: string;
  cutoff_hours?: number;
  min_manage_at?: string;
  manageable?: boolean;
};

type Slot = { slot_start: string; slot_end: string };

const DAYS_AHEAD = 21;

function ManagePage() {
  const { token } = Route.useParams();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"view" | "reschedule">("view");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("get_appointment_by_token" as any, { _token: token });
    setSnap(error ? { found: false } : (data as unknown as Snapshot));
    setLoading(false);
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const tz = snap?.timezone || "UTC";

  const fmt = useMemo(
    () => ({
      date: (iso: string) =>
        new Date(iso).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: tz }),
      time: (iso: string) =>
        new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz }),
    }),
    [tz],
  );

  if (loading) {
    return (
      <Shell>
        <p className="text-muted-foreground text-center py-12">Загрузка…</p>
      </Shell>
    );
  }

  if (!snap?.found) {
    return (
      <Shell>
        <Card className="p-8 text-center space-y-2">
          <XCircle className="h-10 w-10 mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">Запись не найдена</h1>
          <p className="text-muted-foreground text-sm">
            Ссылка недействительна или запись уже удалена. Свяжитесь с салоном напрямую.
          </p>
        </Card>
      </Shell>
    );
  }

  const cancelled = snap.status === "cancelled";
  const completed = snap.status === "completed" || snap.status === "no_show";

  async function doCancel() {
    if (!confirm("Отменить запись? Это действие нельзя отменить.")) return;
    const { data, error } = await supabase.rpc("cancel_appointment_by_token" as any, { _token: token });
    const res = (data ?? {}) as { ok?: boolean; error?: string };
    if (error || !res.ok) {
      setToast({ kind: "err", text: res.error || "Не удалось отменить запись. Попробуйте позже." });
      return;
    }
    setToast({ kind: "ok", text: "Запись отменена." });
    await load();
  }

  return (
    <Shell>
      {toast && (
        <div
          className={`rounded-lg px-4 py-3 text-sm flex items-center gap-2 ${
            toast.kind === "ok" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
          }`}
        >
          {toast.kind === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {toast.text}
        </div>
      )}

      {mode === "view" ? (
        <>
          <Card className="p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">
                  {snap.client_first_name ? `${snap.client_first_name}, ваша запись` : "Ваша запись"}
                </p>
                <h1 className="text-xl font-bold">{snap.salon_name}</h1>
              </div>
              <StatusBadge status={snap.status} />
            </div>

            <div className="space-y-2.5 text-sm">
              <Row icon={Scissors}>{snap.service_name}</Row>
              <Row icon={User}>Мастер: {snap.master_name}</Row>
              <Row icon={CalendarDays}>
                <span className="capitalize">{fmt.date(snap.starts_at!)}</span>
              </Row>
              <Row icon={Clock}>
                {fmt.time(snap.starts_at!)}
                {snap.ends_at ? ` — ${fmt.time(snap.ends_at)}` : ""}
              </Row>
              {snap.salon_address && <Row icon={MapPin}>{snap.salon_address}</Row>}
              {snap.salon_phone && (
                <Row icon={Phone}>
                  <a href={`tel:${snap.salon_phone}`} className="text-primary hover:underline">
                    {snap.salon_phone}
                  </a>
                </Row>
              )}
            </div>
          </Card>

          {snap.manageable ? (
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={() => setMode("reschedule")}>Перенести</Button>
              <Button variant="outline" onClick={doCancel}>
                Отменить
              </Button>
            </div>
          ) : cancelled ? (
            <p className="text-sm text-muted-foreground text-center">
              Эта запись отменена. Чтобы записаться снова — напишите салону.
            </p>
          ) : completed ? (
            <p className="text-sm text-muted-foreground text-center">Запись завершена.</p>
          ) : (
            <p className="text-sm text-muted-foreground text-center">
              До визита осталось меньше {snap.cutoff_hours} ч — перенос и отмена доступны только через салон
              {snap.salon_phone ? ` (${snap.salon_phone})` : ""}.
            </p>
          )}
        </>
      ) : (
        <Reschedule
          snap={snap}
          token={token}
          tz={tz}
          onBack={() => setMode("view")}
          onDone={async (text) => {
            setToast({ kind: "ok", text });
            setMode("view");
            await load();
          }}
          onError={(text) => setToast({ kind: "err", text })}
        />
      )}
    </Shell>
  );
}

function Reschedule({
  snap,
  token,
  tz,
  onBack,
  onDone,
  onError,
}: {
  snap: Snapshot;
  token: string;
  tz: string;
  onBack: () => void;
  onDone: (text: string) => void | Promise<void>;
  onError: (text: string) => void;
}) {
  // Build a day strip anchored on "today" in the salon's timezone (mirrors PublicBooking).
  const dates = useMemo(() => {
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [y, m, d] = todayKey.split("-").map(Number);
    const arr: { key: string; label: Date }[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const dt = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0));
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
      arr.push({ key, label: dt });
    }
    return arr;
  }, [tz]);

  const [dayKey, setDayKey] = useState(dates[0].key);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    supabase
      .rpc("get_available_slots", {
        _master_id: snap.master_id!,
        _service_id: snap.service_id!,
        _date: dayKey,
      })
      .then(({ data }) => {
        if (!alive) return;
        setSlots((data as Slot[]) ?? []);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dayKey, snap.master_id, snap.service_id]);

  const filtered = slots.filter((s) => {
    const slotDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(s.slot_start));
    if (slotDay !== dayKey) return false;
    return new Date(s.slot_start).getTime() > nowMs + 60_000;
  });

  async function pick(slotISO: string) {
    if (submitting) return;
    setSubmitting(true);
    const { data, error } = await supabase.rpc("reschedule_appointment_by_token" as any, {
      _token: token,
      _new_starts_at: slotISO,
    });
    const res = (data ?? {}) as { ok?: boolean; error?: string };
    setSubmitting(false);
    if (error || !res.ok) {
      onError(res.error || "Не удалось перенести запись. Выберите другое время.");
      return;
    }
    await onDone("Запись перенесена.");
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting}>
        <ArrowLeft className="h-4 w-4 mr-1" /> Назад
      </Button>
      <h2 className="text-lg font-semibold">Выберите новое время</h2>

      <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
        {dates.map((d) => {
          const active = d.key === dayKey;
          return (
            <button
              key={d.key}
              onClick={() => setDayKey(d.key)}
              className={`flex flex-col items-center px-3 py-2 rounded-lg border min-w-[60px] shrink-0 ${
                active ? "bg-primary text-primary-foreground border-primary" : ""
              }`}
            >
              <span className="text-xs">{d.label.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" })}</span>
              <span className="font-bold">{d.label.getUTCDate()}</span>
              <span className="text-xs">{d.label.toLocaleDateString("ru-RU", { month: "short", timeZone: "UTC" })}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <p className="text-muted-foreground">Загрузка свободного времени…</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">На этот день свободного времени нет. Выберите другой день.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {filtered.map((s) => (
            <Button
              key={s.slot_start}
              variant="outline"
              disabled={submitting}
              onClick={() => pick(s.slot_start)}
            >
              {new Date(s.slot_start).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz })}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-muted/30 flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-md space-y-4">{children}</div>
    </div>
  );
}

function Row({ icon: Icon, children }: { icon: any; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const map: Record<string, { text: string; cls: string }> = {
    confirmed: { text: "Подтверждена", cls: "bg-green-500/10 text-green-600" },
    cancelled: { text: "Отменена", cls: "bg-red-500/10 text-red-600" },
    completed: { text: "Завершена", cls: "bg-muted text-muted-foreground" },
    no_show: { text: "Не пришёл", cls: "bg-muted text-muted-foreground" },
  };
  const s = map[status ?? ""] ?? { text: status ?? "", cls: "bg-muted text-muted-foreground" };
  return <span className={`text-xs px-2.5 py-1 rounded-full font-medium shrink-0 ${s.cls}`}>{s.text}</span>;
}
