import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ChevronLeft, ChevronRight, Phone, Clock, Scissors, User, RotateCcw, Plus, ArrowRightLeft, ZoomIn, ZoomOut, UserX, Check } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-client";
import { useAdminFilters } from "@/hooks/use-branch-filter";
import { BranchFilterBar } from "@/components/admin/BranchFilterBar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSalonTimezone, formatInTz, dayKeyInTz, minutesFromMidnightInTz, startOfDayInTz, addDaysInTz, dowInTz, zonedTimeToUtc } from "@/lib/tz";
import { CreateAppointmentDialog, MoveAppointmentDialog } from "@/components/admin/AppointmentDialogs";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";
import { rescheduleAppointment } from "@/lib/appointments.functions";

export const Route = createFileRoute("/admin/calendar")({
  component: CalendarPage,
});

const SNAP_MIN = 15;
const DEFAULT_START = 8;
const DEFAULT_END = 22;
const MIN_BOUND = 6;
const MAX_BOUND = 24;

type Density = "compact" | "comfortable" | "spacious";
const HOUR_PX_BY_DENSITY: Record<Density, number> = { compact: 36, comfortable: 60, spacious: 96 };
const DENSITY_ORDER: Density[] = ["compact", "comfortable", "spacious"];
const DENSITY_LABEL: Record<Density, string> = { compact: "Компактный", comfortable: "Стандартный", spacious: "Просторный" };

type DragData = { id: string; durationMin: number; masterId: string; salonId: string };

function parseHour(t: string): number {
  // "HH:MM:SS" → number with fraction
  const [h, m] = t.split(":").map(Number);
  return h + (m || 0) / 60;
}

function CalendarPage() {
  const { isMaster, isSuperAdmin, branchId: ownBranchId } = useAuth();
  const lockedMaster = isMaster && !isSuperAdmin;
  const isMobile = useIsMobile();
  const filters = useAdminFilters();
  const { salonId, branchId } = filters;
  const effectiveSalonId = salonId !== "all" ? salonId : (filters.salons[0]?.id ?? "");
  const tz = useSalonTimezone(effectiveSalonId || null);
  useEffect(() => {
    if (salonId === "all" && filters.salons.length > 0) filters.setSalonId(filters.salons[0].id);
  }, [salonId, filters.salons.length]);
  const [masters, setMasters] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [selectedMasterId, setSelectedMasterId] = useState<string>("all");
  const [view, setView] = useState<"day" | "week">("day");
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === "undefined") return "comfortable";
    const v = window.localStorage.getItem("qabyl.calendar.density") as Density | null;
    return v && HOUR_PX_BY_DENSITY[v] ? v : "comfortable";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("qabyl.calendar.density", density);
  }, [density]);
  const hourPx = HOUR_PX_BY_DENSITY[density];
  function zoom(delta: number) {
    const idx = DENSITY_ORDER.indexOf(density);
    const next = DENSITY_ORDER[Math.max(0, Math.min(DENSITY_ORDER.length - 1, idx + delta))];
    setDensity(next);
  }
  const [date, setDate] = useState<Date>(() => startOfDayInTz(new Date(), null));
  const [appointments, setAppointments] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<any | null>(null);
  const [conflictInfo, setConflictInfo] = useState<{ client_name: string; service: string; starts_at: string; ends_at: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<any | null>(null);
  const dragRef = useRef<DragData | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRaf = useRef<number | null>(null);

  function handleDragOverScroll(e: React.DragEvent) {
    const el = scrollRef.current;
    if (!el || !dragRef.current) return;
    const rect = el.getBoundingClientRect();
    const edge = 60;
    let dy = 0, dx = 0;
    if (e.clientY < rect.top + edge) dy = -Math.max(4, (rect.top + edge - e.clientY) / 4);
    else if (e.clientY > rect.bottom - edge) dy = Math.max(4, (e.clientY - (rect.bottom - edge)) / 4);
    if (e.clientX < rect.left + edge) dx = -Math.max(4, (rect.left + edge - e.clientX) / 4);
    else if (e.clientX > rect.right - edge) dx = Math.max(4, (e.clientX - (rect.right - edge)) / 4);
    if (autoScrollRaf.current) cancelAnimationFrame(autoScrollRaf.current);
    if (dy !== 0 || dx !== 0) {
      const step = () => {
        el.scrollTop += dy;
        el.scrollLeft += dx;
        autoScrollRaf.current = requestAnimationFrame(step);
      };
      autoScrollRaf.current = requestAnimationFrame(step);
    }
  }
  function stopAutoScroll() {
    if (autoScrollRaf.current) { cancelAnimationFrame(autoScrollRaf.current); autoScrollRaf.current = null; }
  }

  useEffect(() => {
    if (!effectiveSalonId) return;
    let q = supabase.from("masters").select("*").eq("salon_id", effectiveSalonId).eq("is_active", true).order("sort_order");
    if (branchId !== "all") q = q.eq("branch_id", branchId);
    q.then(({ data }) => {
      const list = data ?? [];
      setMasters(list);
      if (list.length > 0) {
        const ids = list.map((m) => m.id);
        supabase.from("master_schedules").select("master_id, start_time, end_time").in("master_id", ids)
          .then(({ data: s }) => setSchedules(s ?? []));
      } else {
        setSchedules([]);
      }
    });
  }, [effectiveSalonId, branchId]);

  // Reset master filter when masters list changes. Always allow "all" (within current branch scope).
  useEffect(() => {
    if (masters.length === 0) { setSelectedMasterId("all"); return; }
    if (selectedMasterId !== "all" && !masters.some((m) => m.id === selectedMasterId)) {
      setSelectedMasterId("all");
    }
  }, [masters]);

  const visibleMasters = useMemo(() =>
    selectedMasterId === "all" ? masters : masters.filter((m) => m.id === selectedMasterId),
  [masters, selectedMasterId]);

  const visibleAppointments = useMemo(() =>
    selectedMasterId === "all" ? appointments : appointments.filter((a) => a.master_id === selectedMasterId),
  [appointments, selectedMasterId]);

  // Dynamic hour range from master_schedules + visible appointments
  const { hourStart, hourEnd, hours, totalPx } = useMemo(() => {
    const visIds = new Set(visibleMasters.map((m) => m.id));
    const relevant = schedules.filter((s) => visIds.has(s.master_id));
    let minH = DEFAULT_START, maxH = DEFAULT_END;
    if (relevant.length > 0) {
      minH = Math.min(...relevant.map((s) => parseHour(s.start_time)));
      maxH = Math.max(...relevant.map((s) => parseHour(s.end_time)));
      minH = Math.floor(minH) - 1;
      maxH = Math.ceil(maxH) + 1;
    }
    // extend to fit any appointments — using salon tz
    for (const a of visibleAppointments) {
      const sMin = minutesFromMidnightInTz(a.starts_at, tz);
      const eMin = minutesFromMidnightInTz(a.ends_at, tz);
      minH = Math.min(minH, Math.floor(sMin / 60));
      maxH = Math.max(maxH, Math.ceil(eMin / 60));
    }
    minH = Math.max(MIN_BOUND, minH);
    maxH = Math.min(MAX_BOUND, maxH);
    if (maxH <= minH) { minH = DEFAULT_START; maxH = DEFAULT_END; }
    const hrs = Array.from({ length: maxH - minH }, (_, i) => minH + i);
    return { hourStart: minH, hourEnd: maxH, hours: hrs, totalPx: (maxH - minH) * hourPx };
  }, [schedules, visibleMasters, visibleAppointments, tz, hourPx]);

  const range = useMemo(() => {
    if (view === "week") {
      const dow = dowInTz(date, tz);
      const start = addDaysInTz(date, -dow, tz);
      const end = addDaysInTz(start, 7, tz);
      return { start, end };
    }
    return { start: date, end: addDaysInTz(date, 1, tz) };
  }, [date, view, tz]);

  const [addonsByAppt, setAddonsByAppt] = useState<Record<string, { name: string }[]>>({});
  const [loadingAppts, setLoadingAppts] = useState(true);

  async function loadAppointments() {
    if (!effectiveSalonId) { setLoadingAppts(false); return; }
    setLoadingAppts(true);
    const selectCols = lockedMaster
      ? "id, salon_id, branch_id, master_id, service_id, client_name, client_notes, starts_at, ends_at, price, status, created_at, masters(name), services(name, color)"
      : "*, masters(name), services(name, color)";
    let q = supabase.from("appointments")
      .select(selectCols)
      .eq("salon_id", effectiveSalonId)
      // Attendance-marked visits (no_show/completed) stay on the calendar so the outcome is
      // visible and reversible; only cancelled bookings are hidden from the grid.
      .in("status", ["confirmed", "no_show", "completed"])
      .gte("starts_at", range.start.toISOString())
      .lt("starts_at", range.end.toISOString())
      .order("starts_at");
    if (branchId !== "all") q = q.eq("branch_id", branchId);
    const { data } = await q;
    const list = data ?? [];
    setAppointments(list);
    const ids = list.map((a: any) => a.id);
    if (ids.length === 0) { setAddonsByAppt({}); setLoadingAppts(false); return; }
    const { data: ad } = await supabase.from("appointment_addons")
      .select("appointment_id, name_snapshot")
      .in("appointment_id", ids);
    const grp: Record<string, { name: string }[]> = {};
    for (const a of (ad ?? []) as any[]) {
      (grp[a.appointment_id] ||= []).push({ name: a.name_snapshot });
    }
    setAddonsByAppt(grp);
    setLoadingAppts(false);
  }

  useEffect(() => { loadAppointments(); }, [effectiveSalonId, branchId, range.start.getTime(), range.end.getTime()]);
  useRegisterRefresh(loadAppointments);

  // Realtime: refresh on any appointment change within this salon.
  useEffect(() => {
    if (!effectiveSalonId) return;
    const ch = supabase
      .channel(`appts-${effectiveSalonId}-${Date.now()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `salon_id=eq.${effectiveSalonId}` }, () => {
        loadAppointments();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "appointment_addons" }, () => {
        loadAppointments();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [effectiveSalonId, branchId, range.start.getTime(), range.end.getTime()]);

  const days = view === "week"
    ? Array.from({ length: 7 }, (_, i) => addDaysInTz(range.start, i, tz))
    : [date];

  function shiftDate(delta: number) {
    setDate(addDaysInTz(date, view === "week" ? delta * 7 : delta, tz));
  }

  async function cancelAppt(id: string) {
    if (!confirm("Отменить эту запись?")) return;
    const { error } = await supabase.from("appointments").update({ status: "cancelled" }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Запись отменена");
    setSelected(null);
    loadAppointments();
  }

  // Mark attendance outcome for a past visit. "no_show" powers the No-Show analytics; "completed"
  // records a normal visit; both are reversible back to "confirmed". No client WhatsApp is sent —
  // the change trigger only messages on cancel/reschedule, so attendance stays internal.
  async function markStatus(id: string, status: "no_show" | "completed" | "confirmed") {
    const { error } = await supabase.from("appointments").update({ status }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success(
      status === "no_show" ? "Отмечено: клиент не пришёл" : status === "completed" ? "Отмечено: визит состоялся" : "Возвращено в подтверждённые",
    );
    setSelected((prev: any) => (prev && prev.id === id ? { ...prev, status } : prev));
    loadAppointments();
  }

  async function restoreAppt(appt: any) {
    if (lockedMaster) { toast.error("Недостаточно прав для восстановления записи"); setRestoreTarget(null); return; }
    // Conflict check with details
    const { data: conflicts } = await supabase
      .from("appointments")
      .select("id, client_name, starts_at, ends_at, services(name)")
      .eq("master_id", appt.master_id)
      .eq("status", "confirmed")
      .lt("starts_at", appt.ends_at)
      .gt("ends_at", appt.starts_at)
      .limit(1);
    if (conflicts && conflicts.length > 0) {
      const c: any = conflicts[0];
      setRestoreTarget(null);
      setConflictInfo({
        client_name: c.client_name ?? "—",
        service: c.services?.name ?? "услуга",
        starts_at: c.starts_at,
        ends_at: c.ends_at,
      });
      return;
    }
    const { error } = await supabase.from("appointments").update({ status: "confirmed" }).eq("id", appt.id);
    if (error) return toast.error(error.message);
    toast.success("Запись восстановлена");
    setRestoreTarget(null);
    setSelected(null);
    loadAppointments();
  }

  async function moveAppointment(drag: DragData, day: Date, minutesFromTop: number, newMasterId?: string) {
    const snapped = Math.round(minutesFromTop / SNAP_MIN) * SNAP_MIN;
    const totalMin = hourStart * 60 + snapped;
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    const key = dayKeyInTz(day, tz);
    const [y, mo, da] = key.split("-").map(Number);
    const start = zonedTimeToUtc(y, mo, da, hh, mm, tz);
    // Block past — in salon tz
    if (start.getTime() <= Date.now()) {
      toast.error("Нельзя перенести запись на уже прошедшее время");
      loadAppointments();
      return;
    }
    const end = new Date(start.getTime() + drag.durationMin * 60000);
    setAppointments((prev) => prev.map((a) => (a.id === drag.id ? { ...a, starts_at: start.toISOString(), ends_at: end.toISOString(), master_id: newMasterId ?? a.master_id } : a)));
    // Route through the validated server RPC (atomic double-booking / break / past-time checks)
    // instead of writing straight to the table — and it notifies the client over WhatsApp.
    try {
      const res = await rescheduleAppointment({
        data: {
          appointmentId: drag.id,
          newStartsAt: start.toISOString(),
          newMasterId: newMasterId ?? null,
        },
      });
      if (!res.ok) { toast.error(res.error); loadAppointments(); return; }
      toast.success("Запись перенесена");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось перенести запись");
    }
    loadAppointments();
  }

  return (
    <div className="p-4 sm:p-8 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold">Календарь</h1>
          <p className="text-muted-foreground text-sm">Тапните по записи для управления</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!lockedMaster && effectiveSalonId && (
            <Button onClick={() => setCreateOpen(true)} className="gap-1">
              <Plus className="h-4 w-4" />Добавить запись
            </Button>
          )}
          <Select value={view} onValueChange={(v) => setView(v as any)}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="day">День</SelectItem><SelectItem value="week">Неделя</SelectItem></SelectContent>
          </Select>
          <div className="flex items-center rounded-md border bg-background">
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-r-none" onClick={() => zoom(-1)} disabled={density === "compact"} title="Уменьшить">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Select value={density} onValueChange={(v) => setDensity(v as Density)}>
              <SelectTrigger className="h-9 w-[136px] rounded-none border-0 border-x focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DENSITY_ORDER.map((d) => <SelectItem key={d} value={d}>{DENSITY_LABEL[d]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-l-none" onClick={() => zoom(1)} disabled={density === "spacious"} title="Увеличить">
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
          <Button variant="outline" size="icon" onClick={() => shiftDate(-1)}><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" onClick={() => setDate(startOfDayInTz(new Date(), tz))}>Сегодня</Button>
          <Button variant="outline" size="icon" onClick={() => shiftDate(1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <BranchFilterBar filters={filters} allowAllSalons={false} />

      {masters.length > 0 && (
        <div className={isMobile ? "space-y-1" : "flex items-center gap-2 flex-wrap"}>
          <span className="text-sm text-muted-foreground">Мастер:</span>
          <Select value={selectedMasterId} onValueChange={setSelectedMasterId}>
            <SelectTrigger className={isMobile ? "w-full" : "w-56"}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все мастера{branchId !== "all" ? " филиала" : ""}</SelectItem>
              {masters.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="text-sm font-medium">
        {view === "day"
          ? formatInTz(date, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
          : `${formatInTz(days[0], tz, { day: "numeric", month: "short" })} — ${formatInTz(days[6], tz, { day: "numeric", month: "short", year: "numeric" })}`}
      </div>

      {loadingAppts && appointments.length === 0 ? (
        <Card className="p-0"><LoadingState /></Card>
      ) : visibleMasters.length === 0 ? (
        <Card className="p-12 text-center text-muted-foreground">
          Сначала добавьте мастеров в настройках салона
        </Card>
      ) : (
        <Card className="overflow-auto max-h-[calc(100vh-220px)]" ref={scrollRef as any} onDragOver={handleDragOverScroll} onDrop={stopAutoScroll} onDragEnd={stopAutoScroll} onDragLeave={stopAutoScroll}>
          <div className={isMobile ? "w-full" : "min-w-fit"}>
            {view === "day" ? (
              <DayGrid
                masters={visibleMasters}
                day={date}
                tz={tz}
                hours={hours}
                hourStart={hourStart}
                hourPx={hourPx}
                totalPx={totalPx}
                appointments={visibleAppointments}
                addonsByAppt={addonsByAppt}
                onSelect={setSelected}
                dragRef={dragRef}
                onDropAt={(masterId, minutesFromTop) => {
                  stopAutoScroll();
                  const d = dragRef.current; if (!d) return;
                  moveAppointment(d, date, minutesFromTop, masterId);
                }}
              />
            ) : (
              <WeekGrid
                days={days}
                tz={tz}
                hours={hours}
                hourStart={hourStart}
                hourPx={hourPx}
                totalPx={totalPx}
                appointments={visibleAppointments}
                addonsByAppt={addonsByAppt}
                onSelect={setSelected}
                dragRef={dragRef}
                onDropAt={(day, minutesFromTop) => {
                  stopAutoScroll();
                  const d = dragRef.current; if (!d) return;
                  moveAppointment(d, day, minutesFromTop);
                }}
              />
            )}
          </div>
        </Card>
      )}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Детали записи</DialogTitle></DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2"><User className="h-4 w-4 text-muted-foreground" /><span className="font-medium">{selected.client_name}</span></div>
              {!lockedMaster && selected.client_phone && (
                <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" /><a href={`tel:${selected.client_phone}`} className="text-primary">{selected.client_phone}</a></div>
              )}
              <div className="flex items-center gap-2"><Scissors className="h-4 w-4 text-muted-foreground" /><span>{selected.services?.name}</span></div>
              <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-muted-foreground" /><span>{formatInTz(selected.starts_at, tz, { dateStyle: "short", timeStyle: "short" })} – {formatInTz(selected.ends_at, tz, { hour: "2-digit", minute: "2-digit" })}</span></div>
              <div className="text-muted-foreground">Мастер: {selected.masters?.name}</div>
              <div className="font-medium">{Number(selected.price).toLocaleString("ru-RU")} сом</div>
              <AppointmentAddons appointmentId={selected.id} />
              {selected.client_notes && <div className="p-2 rounded bg-muted text-muted-foreground">{selected.client_notes}</div>}
              {selected.status === "cancelled" && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-amber-900 dark:text-amber-200 text-xs space-y-1">
                  <div className="font-semibold">Запись отменена</div>
                  <div>
                    {lockedMaster
                      ? "Для восстановления записи обратитесь к администратору салона."
                      : "Нажмите «Восстановить эту запись», чтобы вернуть её в календарь. Перед восстановлением мы проверим, что время свободно."}
                  </div>
                </div>
              )}
              {(selected.status === "no_show" || selected.status === "completed") && (
                <div className="rounded-md border p-3 text-xs flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {selected.status === "no_show" ? "❌ Клиент не пришёл" : "✅ Визит состоялся"}
                  </span>
                  {!lockedMaster && (
                    <Button size="sm" variant="ghost" onClick={() => markStatus(selected.id, "confirmed")}>
                      <RotateCcw className="h-4 w-4 mr-1" />Вернуть
                    </Button>
                  )}
                </div>
              )}
              {/* Attendance controls appear once the visit time has passed, so no-shows can be logged. */}
              {!lockedMaster && selected.status === "confirmed" && new Date(selected.starts_at).getTime() < Date.now() && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => markStatus(selected.id, "completed")}>
                    <Check className="h-4 w-4 mr-1" />Пришёл
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => markStatus(selected.id, "no_show")}>
                    <UserX className="h-4 w-4 mr-1" />Не пришёл
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setSelected(null)}>Закрыть</Button>
                {selected.status === "cancelled" ? (
                  !lockedMaster && (
                    <Button onClick={() => setRestoreTarget(selected)}>
                      <RotateCcw className="h-4 w-4 mr-2" />Восстановить
                    </Button>
                  )
                ) : (
                  !lockedMaster && (
                    <>
                      <Button variant="secondary" onClick={() => { setMoveTarget(selected); setSelected(null); }}>
                        <ArrowRightLeft className="h-4 w-4 mr-2" />Перенести
                      </Button>
                      <Button variant="destructive" onClick={() => cancelAppt(selected.id)}>Удалить</Button>
                    </>
                  )
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!restoreTarget} onOpenChange={(o) => !o && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Восстановить запись?</AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget && (
                <>
                  <span className="font-medium text-foreground">{restoreTarget.client_name}</span>
                  {" — "}
                  {restoreTarget.services?.name ?? "услуга"}
                  {", "}
                  {formatInTz(restoreTarget.starts_at, tz, { dateStyle: "short", timeStyle: "short" })}
                  {" – "}
                  {formatInTz(restoreTarget.ends_at, tz, { hour: "2-digit", minute: "2-digit" })}
                  {". После восстановления статус снова станет «Подтверждена»."}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => restoreTarget && restoreAppt(restoreTarget)}>Восстановить</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!conflictInfo} onOpenChange={(o) => !o && setConflictInfo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Время уже занято</AlertDialogTitle>
            <AlertDialogDescription>
              {conflictInfo && (
                <>
                  На это время у мастера уже стоит другая запись:{" "}
                  <span className="font-medium text-foreground">{conflictInfo.client_name}</span>
                  {" ("}{conflictInfo.service}{") "}
                  с {formatInTz(conflictInfo.starts_at, tz, { hour: "2-digit", minute: "2-digit" })}
                  {" до "}
                  {formatInTz(conflictInfo.ends_at, tz, { hour: "2-digit", minute: "2-digit" })}
                  . Восстановить нельзя — сначала отмените или перенесите конфликтующую запись.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setConflictInfo(null)}>Понятно</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {effectiveSalonId && (
        <CreateAppointmentDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          salonId={effectiveSalonId}
          branchId={branchId !== "all" ? branchId : null}
          tz={tz}
          defaultDayKey={dayKeyInTz(date, tz)}
          onCreated={loadAppointments}
        />
      )}

      <MoveAppointmentDialog
        appt={moveTarget}
        onOpenChange={(o) => !o && setMoveTarget(null)}
        tz={tz}
        onMoved={async (newStart) => {
          if (!moveTarget) return;
          // Same validated, client-notifying server path as drag-to-move above.
          try {
            const res = await rescheduleAppointment({
              data: { appointmentId: moveTarget.id, newStartsAt: newStart.toISOString(), newMasterId: null },
            });
            if (!res.ok) { toast.error(res.error); return; }
            toast.success("Запись перенесена");
            loadAppointments();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Не удалось перенести запись");
          }
        }}
      />
    </div>
  );
}

function AppointmentAddons({ appointmentId }: { appointmentId: string }) {
  const [items, setItems] = useState<{ id: string; name_snapshot: string; price_snapshot: number; duration_snapshot: number }[]>([]);
  useEffect(() => {
    supabase.from("appointment_addons").select("id, name_snapshot, price_snapshot, duration_snapshot").eq("appointment_id", appointmentId)
      .then(({ data }) => setItems((data ?? []) as any));
  }, [appointmentId]);
  if (items.length === 0) return null;
  const total = items.reduce((s, a) => s + Number(a.price_snapshot || 0), 0);
  return (
    <div className="rounded-md border p-2 space-y-1 text-xs">
      <div className="font-medium text-foreground text-sm">Доп. услуги</div>
      {items.map((a) => (
        <div key={a.id} className="flex justify-between text-muted-foreground">
          <span>{a.name_snapshot}</span>
          <span>+{Number(a.price_snapshot).toLocaleString("ru-RU")}</span>
        </div>
      ))}
      <div className="flex justify-between pt-1 border-t font-medium"><span>Сумма доп.</span><span>+{total.toLocaleString("ru-RU")}</span></div>
    </div>
  );
}

function HoursColumn({ hours, totalPx, hourPx }: { hours: number[]; totalPx: number; hourPx: number }) {
  return (
    <div className="border-r bg-card" style={{ width: 60 }}>
      <div className="h-10 border-b" />
      <div className="relative" style={{ height: totalPx }}>
        {hours.map((h, i) => (
          <div key={h} className="absolute left-0 right-0 px-2 text-xs text-muted-foreground border-b" style={{ top: i * hourPx, height: hourPx }}>
            {String(h).padStart(2, "0")}:00
          </div>
        ))}
      </div>
    </div>
  );
}

function ColumnBackground({ hours, totalPx, hourPx }: { hours: number[]; totalPx: number; hourPx: number }) {
  return (
    <>
      {hours.map((h, i) => (
        <div key={h} className="absolute left-0 right-0 border-b pointer-events-none" style={{ top: i * hourPx, height: hourPx }} />
      ))}
    </>
  );
}

function DropColumn({ children, onDropAt, dragRef, totalPx, hourPx }: { children: React.ReactNode; onDropAt: (minutesFromTop: number) => void; dragRef: React.MutableRefObject<DragData | null>; totalPx: number; hourPx: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="relative"
      style={{ height: totalPx }}
      onDragOver={(e) => { if (dragRef.current) e.preventDefault(); }}
      onDrop={(e) => {
        e.preventDefault();
        if (!dragRef.current || !ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const minutesFromTop = (y / hourPx) * 60;
        onDropAt(Math.max(0, minutesFromTop));
        dragRef.current = null;
      }}
    >
      {children}
    </div>
  );
}

function DayGrid({ masters, day, tz, hours, hourStart, totalPx, hourPx, appointments, addonsByAppt, onSelect, dragRef, onDropAt }: {
  masters: any[]; day: Date; tz: string; hours: number[]; hourStart: number; totalPx: number; hourPx: number; appointments: any[]; addonsByAppt: Record<string, { name: string }[]>; onSelect: (a: any) => void;
  dragRef: React.MutableRefObject<DragData | null>;
  onDropAt: (masterId: string, minutesFromTop: number) => void;
}) {
  const dayKey = dayKeyInTz(day, tz);
  return (
    <div className="flex">
      <HoursColumn hours={hours} totalPx={totalPx} hourPx={hourPx} />
      {masters.map((m) => {
        const cellAppts = appointments.filter((a) => a.master_id === m.id && dayKeyInTz(a.starts_at, tz) === dayKey);
        return (
          <div key={m.id} className="border-r" style={{ minWidth: masters.length === 1 ? 0 : 140, flex: 1 }}>
            <div className="h-10 border-b p-2 text-center font-medium text-sm truncate">{m.name}</div>
            <DropColumn dragRef={dragRef} totalPx={totalPx} hourPx={hourPx} onDropAt={(min) => onDropAt(m.id, min)}>
              <ColumnBackground hours={hours} totalPx={totalPx} hourPx={hourPx} />
              {cellAppts.map((a) => <PositionedBlock key={a.id} a={a} tz={tz} hourStart={hourStart} hourPx={hourPx} onSelect={onSelect} dragRef={dragRef} addons={addonsByAppt[a.id]} />)}
            </DropColumn>
          </div>
        );
      })}
    </div>
  );
}

function WeekGrid({ days, tz, hours, hourStart, totalPx, hourPx, appointments, addonsByAppt, onSelect, dragRef, onDropAt }: {
  days: Date[]; tz: string; hours: number[]; hourStart: number; totalPx: number; hourPx: number; appointments: any[]; addonsByAppt: Record<string, { name: string }[]>; onSelect: (a: any) => void;
  dragRef: React.MutableRefObject<DragData | null>;
  onDropAt: (day: Date, minutesFromTop: number) => void;
}) {
  return (
    <div className="flex">
      <HoursColumn hours={hours} totalPx={totalPx} hourPx={hourPx} />
      {days.map((d) => {
        const dKey = dayKeyInTz(d, tz);
        const dayAppts = appointments.filter((a) => dayKeyInTz(a.starts_at, tz) === dKey);
        return (
          <div key={dKey} className="border-r" style={{ minWidth: 120, flex: 1 }}>
            <div className="h-10 border-b p-1 text-center text-sm">
              <div className="font-medium">{formatInTz(d, tz, { weekday: "short" })}</div>
              <div className="text-muted-foreground text-xs">{Number(dKey.slice(-2))}</div>
            </div>
            <DropColumn dragRef={dragRef} totalPx={totalPx} hourPx={hourPx} onDropAt={(min) => onDropAt(d, min)}>
              <ColumnBackground hours={hours} totalPx={totalPx} hourPx={hourPx} />
              {dayAppts.map((a) => <PositionedBlock key={a.id} a={a} tz={tz} hourStart={hourStart} hourPx={hourPx} onSelect={onSelect} dragRef={dragRef} addons={addonsByAppt[a.id]} compact />)}
            </DropColumn>
          </div>
        );
      })}
    </div>
  );
}

function PositionedBlock({ a, tz, hourStart, hourPx, onSelect, dragRef, addons, compact }: {
  a: any; tz: string; hourStart: number; hourPx: number; onSelect: (a: any) => void; dragRef: React.MutableRefObject<DragData | null>; addons?: { name: string }[]; compact?: boolean;
}) {
  const start = new Date(a.starts_at);
  const end = new Date(a.ends_at);
  const startMin = minutesFromMidnightInTz(start, tz);
  const endMin = minutesFromMidnightInTz(end, tz);
  const top = ((startMin - hourStart * 60) / 60) * hourPx;
  const height = Math.max(20, ((endMin - startMin) / 60) * hourPx);
  const color = a.services?.color ?? "#0ea5e9";
  const durationMin = (end.getTime() - start.getTime()) / 60000;
  const isCancelled = a.status === "cancelled";
  const isNoShow = a.status === "no_show";
  const isPast = !isCancelled && end.getTime() < Date.now();
  const isDimmed = isCancelled || isPast;
  const attendanceLabel = isNoShow ? " · не пришёл" : a.status === "completed" ? " · пришёл" : isCancelled ? " · отменено" : isPast ? " · завершено" : "";
  const serviceText = (a.services?.name ?? "") + (addons && addons.length > 0 ? " + " + addons.map((x) => x.name).join(", ") : "");
  return (
    <div
      draggable={!isCancelled && !isPast}
      onDragStart={(e) => {
        if (isCancelled || isPast) { e.preventDefault(); return; }
        dragRef.current = { id: a.id, durationMin, masterId: a.master_id, salonId: a.salon_id };
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", a.id); } catch {}
      }}
      onDragEnd={() => { dragRef.current = null; }}
      onClick={() => onSelect(a)}
      className={`absolute left-1 right-1 rounded p-1.5 text-xs text-left overflow-hidden select-none hover:opacity-90 ${isDimmed ? "cursor-pointer opacity-50 line-through" : "cursor-move"}`}
      style={{ top, height, background: color + "22", borderLeft: `3px solid ${color}` }}
      role="button"
      tabIndex={0}
      title={serviceText}
    >
      <div className="font-medium truncate">{a.client_name}{attendanceLabel}</div>
      {!compact && <div className="text-muted-foreground truncate">{serviceText}</div>}

      <div className="text-muted-foreground">
        {formatInTz(start, tz, { hour: "2-digit", minute: "2-digit" })}–{formatInTz(end, tz, { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  );
}
