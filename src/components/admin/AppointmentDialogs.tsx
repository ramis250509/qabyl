import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { CalendarIcon } from "lucide-react";
import { dayKeyInTz, zonedTimeToUtc, formatInTz, startOfDayKeyInTz } from "@/lib/tz";
import { humanError } from "@/lib/human-error";

type Master = { id: string; name: string };
type Service = { id: string; name: string; duration_min: number; price: number };

function buildTimeOptions(): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return out;
}
const TIME_OPTIONS = buildTimeOptions();

function DateQuickPicker({
  dayKey,
  setDayKey,
  tz,
}: {
  dayKey: string;
  setDayKey: (k: string) => void;
  tz: string;
}) {
  const today = dayKeyInTz(new Date(), tz);
  const [open, setOpen] = useState(false);
  const tomorrow = (() => {
    const d = startOfDayKeyInTz(today, tz);
    return dayKeyInTz(new Date(d.getTime() + 26 * 3600 * 1000), tz);
  })();
  const selectedDate = (() => {
    const [y, mo, da] = dayKey.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, da, 12, 0));
  })();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={dayKey === today ? "default" : "outline"}
        onClick={() => setDayKey(today)}
      >
        Сегодня
      </Button>
      <Button
        type="button"
        size="sm"
        variant={dayKey === tomorrow ? "default" : "outline"}
        onClick={() => setDayKey(tomorrow)}
      >
        Завтра
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="gap-1">
            <CalendarIcon className="h-4 w-4" />
            {formatInTz(selectedDate, tz, { day: "numeric", month: "long" })}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(d) => {
              if (!d) return;
              const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              setDayKey(k);
              setOpen(false);
            }}
            initialFocus
            className="pointer-events-auto"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TimeScroller({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-32 text-base font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {TIME_OPTIONS.map((t) => (
          <SelectItem key={t} value={t} className="font-mono">
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Показывает ТОЛЬКО свободные окна начала для выбранного мастера/услуги/даты.
 * Использует ту же серверную RPC `get_available_slots`, что и публичный виджет
 * записи (учитывает расписание мастера, длительность услуги+буфер, занятость,
 * рабочие часы и закрытие салона). Занятое/нерабочее время не показывается.
 */
function FreeSlotPicker({
  masterId,
  serviceId,
  dayKey,
  tz,
  value,
  onChange,
}: {
  masterId: string;
  serviceId: string;
  dayKey: string;
  tz: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!masterId || !serviceId || !dayKey) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc("get_available_slots", {
        _master_id: masterId,
        _service_id: serviceId,
        _date: dayKey,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setSlots([]);
          setLoading(false);
          return;
        }
        const times = (data ?? [])
          .map((r: any) =>
            formatInTz(new Date(r.slot_start), tz, {
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            }),
          )
          .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
        setSlots(times);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [masterId, serviceId, dayKey, tz]);

  if (!masterId || !serviceId) {
    return <p className="text-sm text-muted-foreground">Сначала выберите мастера и услугу.</p>;
  }
  if (loading) {
    return <p className="text-sm text-muted-foreground">Загрузка свободного времени…</p>;
  }
  if (slots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        На эту дату нет свободных окон. Выберите другую дату или введите время вручную.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
      {slots.map((t) => (
        <Button
          key={t}
          type="button"
          size="sm"
          variant={value === t ? "default" : "outline"}
          className="font-mono"
          onClick={() => onChange(t)}
        >
          {t}
        </Button>
      ))}
    </div>
  );
}

/* ============================= Create Appointment ============================= */

export function CreateAppointmentDialog({
  open,
  onOpenChange,
  salonId,
  branchId,
  tz,
  defaultDayKey,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  salonId: string;
  branchId: string | null;
  tz: string;
  defaultDayKey: string;
  onCreated: () => void;
}) {
  const [masters, setMasters] = useState<Master[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [allowedServiceIds, setAllowedServiceIds] = useState<Set<string>>(new Set());
  const [masterId, setMasterId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [dayKey, setDayKey] = useState(defaultDayKey);
  const [time, setTime] = useState("");
  // false → выбор из свободных окон (по умолчанию); true → ручной ввод любого
  // времени для walk-in / записи вне графика.
  const [manualTime, setManualTime] = useState(false);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // Phone (digits only) the admin was already warned about — second submit proceeds.

  // Reset form fields ONLY when the dialog transitions from closed → open.
  // Depending on defaultDayKey here caused the inputs (Имя клиента / Телефон)
  // to be wiped on every parent re-render (realtime updates, push events, etc.),
  // which made typing appear broken on mobile.
  useEffect(() => {
    if (!open) return;
    setDayKey(defaultDayKey);
    setClientName("");
    setClientPhone("");
    setNotes("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // В режиме свободных окон сбрасываем выбранное время при смене мастера/услуги/даты,
  // чтобы устаревший выбор из другого набора слотов не «залипал».
  useEffect(() => {
    if (!manualTime) setTime("");
  }, [masterId, serviceId, dayKey, manualTime]);

  useEffect(() => {
    if (!open || !salonId) return;
    let q = supabase
      .from("masters")
      .select("id, name")
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .order("sort_order");
    if (branchId) q = q.eq("branch_id", branchId);
    q.then(({ data }) => {
      const list = (data ?? []) as Master[];
      setMasters(list);
      if (list.length > 0 && !masterId) setMasterId(list[0].id);
    });
    supabase
      .from("services")
      .select("id, name, duration_min, price")
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setServices((data ?? []) as Service[]));
  }, [open, salonId, branchId]);

  useEffect(() => {
    if (!masterId) {
      setAllowedServiceIds(new Set());
      return;
    }
    supabase
      .from("master_services")
      .select("service_id")
      .eq("master_id", masterId)
      .then(({ data }) => {
        const ids = new Set<string>((data ?? []).map((r: any) => r.service_id));
        setAllowedServiceIds(ids);
        if (serviceId && !ids.has(serviceId)) setServiceId("");
      });
  }, [masterId]);

  const visibleServices = useMemo(
    () => services.filter((s) => allowedServiceIds.has(s.id)),
    [services, allowedServiceIds],
  );

  async function submit() {
    if (!masterId || !serviceId) return toast.error("Выберите мастера и услугу");
    if (!time) return toast.error("Выберите время");
    if (clientName.trim().length === 0) return toast.error("Укажите имя клиента");
    if (clientPhone.trim().length < 5) return toast.error("Укажите телефон");
    const [hh, mm] = time.split(":").map(Number);
    const [y, mo, da] = dayKey.split("-").map(Number);
    const startsAt = zonedTimeToUtc(y, mo, da, hh, mm, tz);
    if (startsAt.getTime() <= Date.now())
      return toast.error("Нельзя создать запись на уже прошедшее время");

    setSaving(true);
    // Предварительной проверки «есть ли номер в WhatsApp» больше нет: её умел только Green-API,
    // у Cloud API аналога не существует. Исход теперь сообщает сам провайдер после отправки —
    // статус доставки приезжает вебхуком и виден владельцу в календаре.
    try {
      const { error } = await supabase.rpc("create_appointment", {
        _salon_id: salonId,
        _master_id: masterId,
        _service_id: serviceId,
        _starts_at: startsAt.toISOString(),
        _client_name: clientName.trim(),
        _client_phone: clientPhone.trim(),
        _client_notes: notes.trim() || undefined,
        _branch_id: branchId ?? undefined,
        _addon_ids: [],
      });
      if (error) throw error;
      toast.success("Запись создана");
      onCreated();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось создать запись"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Новая запись</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Мастер</Label>
            <Select value={masterId} onValueChange={setMasterId}>
              <SelectTrigger>
                <SelectValue placeholder="Выберите" />
              </SelectTrigger>
              <SelectContent>
                {masters.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Услуга</Label>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={visibleServices.length ? "Выберите" : "Мастер не оказывает услуг"}
                />
              </SelectTrigger>
              <SelectContent>
                {visibleServices.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {s.duration_min} мин · {Number(s.price).toLocaleString("ru-RU")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Дата</Label>
            <DateQuickPicker dayKey={dayKey} setDayKey={setDayKey} tz={tz} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Время</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-1 text-xs"
                onClick={() => {
                  // Переключаясь на ручной ввод с пустым временем — ставим дефолт,
                  // чтобы селектор не был пустым.
                  if (!manualTime && !time) setTime("10:00");
                  setManualTime((v) => !v);
                }}
              >
                {manualTime ? "Выбрать из свободных" : "Ввести вручную"}
              </Button>
            </div>
            {manualTime ? (
              <TimeScroller value={time} onChange={setTime} />
            ) : (
              <FreeSlotPicker
                masterId={masterId}
                serviceId={serviceId}
                dayKey={dayKey}
                tz={tz}
                value={time}
                onChange={setTime}
              />
            )}
          </div>
          <div>
            <Label>Имя клиента</Label>
            <Input
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              maxLength={100}
            />
          </div>
          <div>
            <Label>Телефон</Label>
            <PhoneInput value={clientPhone} onChange={setClientPhone} />
          </div>
          <div>
            <Label>Комментарий (необяз.)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "..." : "Создать"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ============================= Move Appointment ============================= */

export function MoveAppointmentDialog({
  appt,
  onOpenChange,
  tz,
  onMoved,
}: {
  appt: any | null;
  onOpenChange: (o: boolean) => void;
  tz: string;
  onMoved: (newStart: Date) => Promise<void> | void;
}) {
  const open = !!appt;
  const initial = appt ? new Date(appt.starts_at) : null;
  const [dayKey, setDayKey] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [manualTime, setManualTime] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!appt) return;
    setManualTime(false);
    setTime("");
    setDayKey(dayKeyInTz(appt.starts_at, tz));
  }, [appt, tz]);

  // В режиме свободных окон сбрасываем выбор при смене даты.
  useEffect(() => {
    if (!manualTime) setTime("");
  }, [dayKey, manualTime]);

  async function submit() {
    if (!appt || !dayKey) return;
    if (!time) return toast.error("Выберите время");
    const [hh, mm] = time.split(":").map(Number);
    const [y, mo, da] = dayKey.split("-").map(Number);
    const start = zonedTimeToUtc(y, mo, da, hh, mm, tz);
    if (start.getTime() <= Date.now())
      return toast.error("Нельзя перенести на уже прошедшее время");
    setSaving(true);
    try {
      await onMoved(start);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Перенести запись</DialogTitle>
        </DialogHeader>
        {appt && initial && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Сейчас:{" "}
              <span className="font-medium text-foreground">
                {formatInTz(initial, tz, {
                  day: "numeric",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <div className="space-y-2">
              <Label>Новая дата</Label>
              <DateQuickPicker dayKey={dayKey} setDayKey={setDayKey} tz={tz} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Новое время</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto px-2 py-1 text-xs"
                  onClick={() => {
                    if (!manualTime && !time) setTime("10:00");
                    setManualTime((v) => !v);
                  }}
                >
                  {manualTime ? "Выбрать из свободных" : "Ввести вручную"}
                </Button>
              </div>
              {manualTime ? (
                <TimeScroller value={time} onChange={setTime} />
              ) : (
                <FreeSlotPicker
                  masterId={appt.master_id}
                  serviceId={appt.service_id}
                  dayKey={dayKey}
                  tz={tz}
                  value={time}
                  onChange={setTime}
                />
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Отмена
              </Button>
              <Button onClick={submit} disabled={saving}>
                {saving ? "..." : "Перенести"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
