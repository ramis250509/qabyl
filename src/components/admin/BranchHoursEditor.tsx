import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const WEEKDAYS = [
  { dow: 1, label: "Понедельник" },
  { dow: 2, label: "Вторник" },
  { dow: 3, label: "Среда" },
  { dow: 4, label: "Четверг" },
  { dow: 5, label: "Пятница" },
  { dow: 6, label: "Суббота" },
  { dow: 0, label: "Воскресенье" },
];

export type BranchHours = Record<string, { start: string; end: string }[]>;

export function defaultBranchHours(): BranchHours {
  const h: BranchHours = {};
  for (const d of WEEKDAYS) {
    h[String(d.dow)] = d.dow === 0 ? [] : [{ start: "09:00", end: "20:00" }];
  }
  return h;
}

export function BranchHoursEditor({ value, onChange }: { value: BranchHours | null | undefined; onChange: (v: BranchHours) => void }) {
  const hours: BranchHours = value && typeof value === "object" ? (value as BranchHours) : defaultBranchHours();

  function setDay(dow: number, intervals: { start: string; end: string }[]) {
    onChange({ ...hours, [String(dow)]: intervals });
  }

  return (
    <div className="space-y-2">
      <Label>График работы филиала</Label>
      <p className="text-xs text-muted-foreground">Если филиал закрыт — снимите галочку. Слоты записи учитывают эти часы.</p>
      <div className="rounded-lg border divide-y">
        {WEEKDAYS.map((d) => {
          const intervals = hours[String(d.dow)] ?? [];
          const open = intervals.length > 0;
          const first = intervals[0] ?? { start: "09:00", end: "20:00" };
          return (
            <div key={d.dow} className="flex items-center gap-3 p-2 sm:p-3 flex-wrap">
              <div className="flex items-center gap-2 w-32 shrink-0">
                <Checkbox
                  checked={open}
                  onCheckedChange={(v) => {
                    if (v) setDay(d.dow, [{ start: "09:00", end: "20:00" }]);
                    else setDay(d.dow, []);
                  }}
                />
                <span className="text-sm font-medium">{d.label}</span>
              </div>
              {open ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={first.start}
                    className="w-28"
                    onChange={(e) => setDay(d.dow, [{ ...first, start: e.target.value }])}
                  />
                  <span className="text-muted-foreground">—</span>
                  <Input
                    type="time"
                    value={first.end}
                    className="w-28"
                    onChange={(e) => setDay(d.dow, [{ ...first, end: e.target.value }])}
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Выходной</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
