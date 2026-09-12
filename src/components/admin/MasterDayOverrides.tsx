import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Trash2, Plus, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";

type Kind = "workday" | "break" | "off" | "away";
type Override = {
  id?: string;
  master_id: string;
  date: string;
  kind: Kind;
  is_off: boolean;
  intervals: { start: string; end: string }[] | null;
  note?: string | null;
};

function kindLabel(o: Override): string {
  if (o.kind === "off" || o.is_off) return "выходной";
  const range = o.intervals?.map((i) => `${i.start}–${i.end}`).join(", ") ?? "";
  if (o.kind === "break") return `перерыв ${range}`;
  return `рабочий день ${range}`;
}

export function MasterDayOverrides({ masterId }: { masterId: string }) {
  const [items, setItems] = useState<Override[]>([]);
  const [kind, setKind] = useState<Kind>("workday");
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  // Конец отсутствия. Отпуск, больничный и «уехала на обучение» — самый частый случай правки
  // графика, и раньше его приходилось вводить выходным на каждый день по очереди: на две недели
  // это четырнадцать одинаковых действий, после третьего из которых бросают.
  const [dateTo, setDateTo] = useState<string>(new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState<string>("10:00");
  const [end, setEnd] = useState<string>("15:00");

  async function load() {
    const { data } = await supabase
      .from("master_day_overrides" as any)
      .select("*")
      .eq("master_id", masterId)
      .gte("date", new Date(Date.now() - 86400000).toISOString().slice(0, 10))
      .order("date");
    setItems((data ?? []) as unknown as Override[]);
  }
  useEffect(() => {
    if (masterId) load();
  }, [masterId]);

  async function add() {
    if (!date) return toast.error("Выберите дату");

    // Отсутствие на период — это набор выходных подряд.
    //
    // ПОЧЕМУ НЕ ОТДЕЛЬНАЯ ТАБЛИЦА С ДИАПАЗОНОМ. Расчёт свободного времени (get_available_slots)
    // уже читает master_day_overrides по дате. Новая таблица потребовала бы менять и его — то
    // есть трогать самое чувствительное место продукта ради удобства ввода. Строка на день
    // дороже по месту и дешевле по риску, а отпуск длиной в две недели — это четырнадцать строк,
    // что для базы ничто.
    if (kind === "away") {
      if (!dateTo) return toast.error("Укажите, по какое число");
      if (dateTo < date) return toast.error("Дата «по» должна быть не раньше даты «с»");

      const days: string[] = [];
      const cur = new Date(`${date}T12:00:00`);
      const last = new Date(`${dateTo}T12:00:00`);
      while (cur <= last) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
        // Защита от бесконечного цикла на кривых датах и от отпуска длиной в год.
        if (days.length > 366) break;
      }
      if (days.length === 0) return toast.error("Не удалось разобрать период");

      const rows = days.map((d) => ({
        master_id: masterId,
        date: d,
        kind: "off",
        is_off: true,
        intervals: null,
      }));
      const { error } = await supabase
        .from("master_day_overrides" as any)
        .upsert(rows, { onConflict: "master_id,date" });
      if (error) return toast.error(humanError(error, "Не удалось сохранить отсутствие"));
      toast.success(
        days.length === 1
          ? "Мастер отмечен как отсутствующий в этот день"
          : `Мастер отсутствует ${days.length} ${days.length < 5 ? "дня" : "дней"} — записи на это время закрыты`,
      );
      load();
      return;
    }

    if (kind !== "off" && start >= end) return toast.error("Время «С» должно быть раньше «До»");
    const payload: any = {
      master_id: masterId,
      date,
      kind,
      is_off: kind === "off",
      intervals: kind === "off" ? null : [{ start, end }],
    };
    const { error } = await supabase
      .from("master_day_overrides" as any)
      .upsert(payload, { onConflict: "master_id,date" });
    if (error) return toast.error(humanError(error));
    toast.success("Сохранено");
    load();
  }

  async function remove(id: string) {
    const { error } = await supabase
      .from("master_day_overrides" as any)
      .delete()
      .eq("id", id);
    if (error) return toast.error(humanError(error));
    load();
  }

  if (!masterId) {
    return (
      <p className="text-xs text-muted-foreground">
        Сохраните мастера, чтобы добавить изменения графика на конкретные дни.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CalendarClock className="h-4 w-4" /> Изменения на конкретные дни
      </div>
      <p className="text-xs text-muted-foreground">
        Отпуск и болезнь, сокращённый день, перерыв или один выходной. На это время мастер перестаёт
        показываться клиентам при записи.
      </p>

      <div className="rounded-lg border p-3 space-y-3 bg-muted/30">
        <RadioGroup
          value={kind}
          onValueChange={(v) => setKind(v as Kind)}
          className="grid gap-2 sm:grid-cols-2"
        >
          <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2 hover:bg-background">
            <RadioGroupItem value="away" id="k-away" className="mt-0.5" />
            <span className="text-sm">
              <span className="block font-medium">Отпуск или болезнь</span>
              <span className="block text-xs text-muted-foreground">
                Мастера нет с одной даты по другую
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:bg-background">
            <RadioGroupItem value="workday" id="k-work" className="mt-0.5" />
            <span className="text-sm">
              <span className="block font-medium">Изменить рабочий день</span>
              <span className="block text-xs text-muted-foreground">
                Мастер работает только в указанные часы
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:bg-background">
            <RadioGroupItem value="break" id="k-break" className="mt-0.5" />
            <span className="text-sm">
              <span className="block font-medium">Освободить мастера / Перерыв</span>
              <span className="block text-xs text-muted-foreground">
                Мастер занят в эти часы, остальное время свободно
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:bg-background">
            <RadioGroupItem value="off" id="k-off" className="mt-0.5" />
            <span className="text-sm">
              <span className="block font-medium">Выходной</span>
              <span className="block text-xs text-muted-foreground">
                Записи в этот день недоступны
              </span>
            </span>
          </label>
        </RadioGroup>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">{kind === "away" ? "С какого числа" : "Дата"}</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                // Конец не может быть раньше начала — подтягиваем сами, чтобы человеку не
                // пришлось получать за это ошибку.
                if (dateTo < e.target.value) setDateTo(e.target.value);
              }}
              className="w-40"
            />
          </div>
          {kind === "away" && (
            <div>
              <Label className="text-xs">По какое включительно</Label>
              <Input
                type="date"
                value={dateTo}
                min={date}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-40"
              />
            </div>
          )}
          {kind !== "off" && kind !== "away" && (
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
          <Button size="sm" onClick={add}>
            <Plus className="h-4 w-4 mr-1" />
            Добавить
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="divide-y rounded-lg border">
          {items.map((o) => (
            <div key={o.id} className="flex items-center justify-between p-2 text-sm">
              <div>
                <span className="font-medium">
                  {new Date(o.date).toLocaleDateString("ru-RU", {
                    day: "numeric",
                    month: "long",
                    weekday: "short",
                  })}
                </span>
                <span className="ml-2 text-muted-foreground">{kindLabel(o)}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => o.id && remove(o.id)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
