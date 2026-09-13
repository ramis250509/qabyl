import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2, CalendarOff } from "lucide-react";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";

// Быстрое изменение графика ВСЕГО салона на конкретные даты (вкладка «Информация»):
// выходной или сокращённый день применяется одним действием ко всем активным мастерам —
// вместо ручного прохода по каждому профилю. Технически это fan-out записей в
// master_day_overrides (их уже читает get_available_slots), помеченных note='salon_bulk',
// чтобы список ниже и «отмена» не трогали индивидуальные изменения мастеров.

type Kind = "off" | "workday";

type BulkRow = {
  master_id: string;
  date: string;
  kind: Kind;
  is_off: boolean;
  intervals: { start: string; end: string }[] | null;
  note: string;
};

const BULK_NOTE = "salon_bulk";
const MAX_RANGE_DAYS = 31;

function listDates(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length <= MAX_RANGE_DAYS) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "short",
    timeZone: "UTC",
  });
}

export function SalonDayOverridesCard({
  salonId,
  timezone,
}: {
  salonId: string;
  timezone?: string | null;
}) {
  const tz = timezone || "Asia/Bishkek";
  const todayIso = new Date().toISOString().slice(0, 10);

  const [kind, setKind] = useState<Kind>("off");
  const [dateFrom, setDateFrom] = useState(todayIso);
  const [dateTo, setDateTo] = useState(todayIso);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("15:00");
  const [applying, setApplying] = useState(false);

  // Существующие массовые изменения (сгруппированы по дате) — для списка и отмены.
  const [groups, setGroups] = useState<
    Array<{ date: string; kind: Kind; intervals: string; count: number }>
  >([]);
  const [masterIds, setMasterIds] = useState<string[]>([]);

  // Конфликтующие записи, ждущие подтверждения «Применить всё равно».
  const [conflicts, setConflicts] = useState<any[] | null>(null);
  const [pendingRows, setPendingRows] = useState<BulkRow[] | null>(null);

  async function load() {
    const { data: masters } = await supabase.from("masters").select("id").eq("salon_id", salonId);
    const ids = (masters ?? []).map((m: any) => m.id);
    setMasterIds(ids);
    if (ids.length === 0) {
      setGroups([]);
      return;
    }
    const { data } = await supabase
      .from("master_day_overrides" as any)
      .select("date, kind, intervals")
      .in("master_id", ids)
      .eq("note", BULK_NOTE)
      .gte("date", todayIso)
      .order("date");
    const byDate = new Map<
      string,
      { date: string; kind: Kind; intervals: string; count: number }
    >();
    for (const row of (data ?? []) as any[]) {
      // Сокращённый день у разных мастеров может иметь разные (обрезанные) интервалы —
      // для заголовка группы достаточно вида и первой пары часов.
      const key = row.date;
      const cur = byDate.get(key);
      if (cur) {
        cur.count += 1;
        if (row.kind === "workday") cur.kind = "workday";
      } else {
        byDate.set(key, {
          date: row.date,
          kind: row.kind === "off" ? "off" : "workday",
          intervals: (row.intervals ?? []).map((i: any) => `${i.start}–${i.end}`).join(", "),
          count: 1,
        });
      }
    }
    setGroups([...byDate.values()]);
  }
  useEffect(() => {
    load();
  }, [salonId]);

  async function buildRows(): Promise<BulkRow[] | null> {
    const { data: masters, error } = await supabase
      .from("masters")
      .select("id")
      .eq("salon_id", salonId)
      .eq("is_active", true);
    if (error) {
      toast.error(humanError(error));
      return null;
    }
    const ids = (masters ?? []).map((m: any) => m.id);
    if (ids.length === 0) {
      toast.error("У салона нет активных мастеров");
      return null;
    }

    const dates = listDates(dateFrom, dateTo);
    const rows: BulkRow[] = [];

    if (kind === "off") {
      for (const id of ids)
        for (const d of dates) {
          rows.push({
            master_id: id,
            date: d,
            kind: "off",
            is_off: true,
            intervals: null,
            note: BULK_NOTE,
          });
        }
      return rows;
    }

    // Сокращённый день: override типа workday ЗАМЕНЯЕТ недельный график мастера в
    // get_available_slots, поэтому нельзя писать окно салона как есть — иначе мастер,
    // который в этот день недели не работает (или работает меньше), получил бы слоты.
    // Пишем пересечение окна с недельным графиком мастера; пустое пересечение = выходной.
    const { data: schedules, error: schedErr } = await supabase
      .from("master_schedules")
      .select("master_id, weekday, start_time, end_time")
      .in("master_id", ids);
    if (schedErr) {
      toast.error(humanError(schedErr));
      return null;
    }
    const byMasterDow = new Map<string, Array<{ start: string; end: string }>>();
    for (const s of (schedules ?? []) as any[]) {
      const key = `${s.master_id}:${s.weekday}`;
      const list = byMasterDow.get(key) ?? [];
      list.push({ start: String(s.start_time).slice(0, 5), end: String(s.end_time).slice(0, 5) });
      byMasterDow.set(key, list);
    }

    for (const id of ids) {
      for (const d of dates) {
        const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
        const sched = byMasterDow.get(`${id}:${dow}`);
        if (!sched || sched.length === 0) continue; // мастер и так не работает в этот день недели
        const clamped = sched
          .map((iv) => ({
            start: start > iv.start ? start : iv.start,
            end: end < iv.end ? end : iv.end,
          }))
          .filter((iv) => iv.start < iv.end);
        rows.push(
          clamped.length > 0
            ? {
                master_id: id,
                date: d,
                kind: "workday",
                is_off: false,
                intervals: clamped,
                note: BULK_NOTE,
              }
            : // Окно салона не пересекается с графиком мастера — в этот день он не работает.
              {
                master_id: id,
                date: d,
                kind: "off",
                is_off: true,
                intervals: null,
                note: BULK_NOTE,
              },
        );
      }
    }
    return rows;
  }

  async function findConflicts(dates: string[]): Promise<any[]> {
    const fromTs = new Date(`${dates[0]}T00:00:00Z`);
    fromTs.setUTCDate(fromTs.getUTCDate() - 1); // запас на смещение часового пояса
    const toTs = new Date(`${dates[dates.length - 1]}T23:59:59Z`);
    toTs.setUTCDate(toTs.getUTCDate() + 1);
    const { data } = await supabase
      .from("appointments")
      .select("id, client_name, starts_at")
      .eq("salon_id", salonId)
      .eq("status", "confirmed")
      .gte("starts_at", new Date(Math.max(Date.now(), fromTs.getTime())).toISOString())
      .lte("starts_at", toTs.toISOString())
      .order("starts_at");
    const dateSet = new Set(dates);
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const timeFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return (data ?? []).filter((a: any) => {
      const local = new Date(a.starts_at);
      if (!dateSet.has(dateFmt.format(local))) return false;
      if (kind === "off") return true;
      const t = timeFmt.format(local);
      return t < start || t >= end; // запись вне нового сокращённого окна
    });
  }

  async function applyRows(rows: BulkRow[]) {
    setApplying(true);
    try {
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await supabase
          .from("master_day_overrides" as any)
          .upsert(rows.slice(i, i + CHUNK), { onConflict: "master_id,date" });
        if (error) throw error;
      }
      toast.success(
        kind === "off"
          ? "Выходной установлен для всех мастеров"
          : "Сокращённый день установлен для всех мастеров",
      );
      setConflicts(null);
      setPendingRows(null);
      load();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось применить"));
    } finally {
      setApplying(false);
    }
  }

  async function onApplyClick() {
    if (!dateFrom || !dateTo) return toast.error("Выберите даты");
    if (dateTo < dateFrom) return toast.error("Дата «По» раньше даты «С»");
    if (dateFrom < todayIso) return toast.error("Нельзя менять график задним числом");
    const dates = listDates(dateFrom, dateTo);
    if (dates.length > MAX_RANGE_DAYS)
      return toast.error(`Диапазон не больше ${MAX_RANGE_DAYS} дней`);
    if (kind === "workday" && start >= end) return toast.error("Время «С» должно быть раньше «До»");

    setApplying(true);
    const rows = await buildRows();
    if (!rows) {
      setApplying(false);
      return;
    }
    if (rows.length === 0) {
      setApplying(false);
      return toast.error("Ни один мастер не работает в выбранные дни — менять нечего");
    }
    const found = await findConflicts(dates);
    setApplying(false);
    if (found.length > 0) {
      setConflicts(found);
      setPendingRows(rows);
      return;
    }
    applyRows(rows);
  }

  async function removeGroup(date: string) {
    if (masterIds.length === 0) return;
    const { error } = await supabase
      .from("master_day_overrides" as any)
      .delete()
      .eq("note", BULK_NOTE)
      .eq("date", date)
      .in("master_id", masterIds);
    if (error) return toast.error(humanError(error));
    toast.success("Изменение отменено");
    load();
  }

  return (
    <Card className="p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <CalendarOff className="h-4 w-4" /> Быстрое изменение графика на даты
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Выходной или сокращённый день сразу для всех мастеров салона — без захода в профиль
          каждого. Перезапишет индивидуальные изменения мастеров на эти даты.
        </p>
      </div>

      <div className="rounded-lg border p-3 space-y-3 bg-muted/30">
        <RadioGroup
          value={kind}
          onValueChange={(v) => setKind(v as Kind)}
          className="grid gap-2 sm:grid-cols-2"
        >
          <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:bg-background">
            <RadioGroupItem value="off" id="sk-off" className="mt-0.5" />
            <span className="text-sm">
              <span className="block font-medium">Выходной</span>
              <span className="block text-xs text-muted-foreground">
                Записи в эти дни недоступны
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:bg-background">
            <RadioGroupItem value="workday" id="sk-short" className="mt-0.5" />
            <span className="text-sm">
              <span className="block font-medium">Сокращённый день</span>
              <span className="block text-xs text-muted-foreground">
                Салон работает только в указанные часы
              </span>
            </span>
          </label>
        </RadioGroup>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">С даты</Label>
            <Input
              type="date"
              value={dateFrom}
              min={todayIso}
              onChange={(e) => {
                setDateFrom(e.target.value);
                if (dateTo < e.target.value) setDateTo(e.target.value);
              }}
              className="w-40"
            />
          </div>
          <div>
            <Label className="text-xs">По дату</Label>
            <Input
              type="date"
              value={dateTo}
              min={dateFrom}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-40"
            />
          </div>
          {kind === "workday" && (
            <>
              <div>
                <Label className="text-xs">С</Label>
                <Input
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-28"
                />
              </div>
              <div>
                <Label className="text-xs">До</Label>
                <Input
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="w-28"
                />
              </div>
            </>
          )}
          <Button size="sm" onClick={onApplyClick} disabled={applying}>
            {applying ? "..." : "Применить ко всем мастерам"}
          </Button>
        </div>
      </div>

      {groups.length > 0 && (
        <div className="divide-y rounded-lg border">
          {groups.map((g) => (
            <div key={g.date} className="flex items-center justify-between p-2 text-sm">
              <div>
                <span className="font-medium">{fmtDate(g.date)}</span>
                <span className="ml-2 text-muted-foreground">
                  {g.kind === "off" ? "выходной" : `сокращённый день ${g.intervals}`} · {g.count}{" "}
                  {g.count === 1 ? "мастер" : g.count < 5 ? "мастера" : "мастеров"}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeGroup(g.date)}
                title="Отменить изменение"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={!!pendingRows}
        onOpenChange={(o) => {
          if (!o) {
            setPendingRows(null);
            setConflicts(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>На эти даты уже есть записи</AlertDialogTitle>
            <AlertDialogDescription>
              Найдено {conflicts?.length ?? 0} подтверждённых записей, которые попадают на закрытое
              время. Они не отменятся автоматически — при необходимости перенесите или отмените их
              вручную в Календаре.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-48 overflow-y-auto text-sm space-y-1 border rounded-md p-2">
            {conflicts?.map((a) => (
              <div key={a.id} className="flex justify-between gap-2">
                <span>{a.client_name}</span>
                <span className="text-muted-foreground">
                  {new Date(a.starts_at).toLocaleString("ru-RU", {
                    timeZone: tz,
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingRows && applyRows(pendingRows)}>
              Применить всё равно
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
