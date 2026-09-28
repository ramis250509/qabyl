import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-client";
import { useNotifications } from "@/hooks/use-notifications";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Bell, BellOff, Check, CheckCheck, RotateCcw, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAdminFilters } from "@/hooks/use-branch-filter";
import { BranchFilterBar } from "@/components/admin/BranchFilterBar";
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
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { useSalonTimezone, formatInTz, dayKeyInTz } from "@/lib/tz";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";
import { ensurePushSubscription, isPushSupported, isIos, isStandalonePWA } from "@/lib/push";
import { matchesBranchScope } from "@/lib/branch-scope";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useBusinessVocabulary } from "@/hooks/use-business-vocabulary";

export const Route = createFileRoute("/admin/notifications")({
  head: () => ({ meta: [{ title: "Уведомления — Qabyl" }] }),
  component: NotificationsPage,
});

type ConflictInfo = { client_name: string; service: string; starts_at: string; ends_at: string };
type RestoreTarget = {
  apptId: string;
  notifId: string;
  client_name: string;
  service: string;
  starts_at: string;
  ends_at: string;
};

type AppointmentDetails = {
  client_name: string | null;
  client_phone: string | null;
  starts_at: string;
  status: string;
  services: { name: string } | null;
  masters: { name: string } | null;
  branches: { name: string } | null;
};

function NotificationsPage() {
  const { isSuperAdmin, isMaster, salonId, branchId: ownBranchId } = useAuth();
  const canRestore = !isMaster || isSuperAdmin;
  const filters = useAdminFilters();
  const tz = useSalonTimezone(filters.salonId !== "all" ? filters.salonId : salonId);
  const vocabulary = useBusinessVocabulary(filters.salonId !== "all" ? filters.salonId : salonId);
  // Мастера видят строго свой филиал — независимо от UI-фильтра.
  const effectiveBranchId =
    isMaster && !isSuperAdmin ? ownBranchId : filters.branchId !== "all" ? filters.branchId : null;
  const { items, loading, unreadCount, markRead, markAllRead, refresh } = useNotifications({
    salonId,
    isSuperAdmin,
    branchId: effectiveBranchId,
  }) as any;

  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushDebug, setPushDebug] = useState<string[]>([]);
  const [pushBusy, setPushBusy] = useState(false);
  // Диагностика свёрнута по умолчанию: она нужна редко, а место занимает каждый день.
  const [diagOpen, setDiagOpen] = useState(false);
  useRegisterRefresh(refresh);

  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [conflictInfo, setConflictInfo] = useState<ConflictInfo | null>(null);
  const [detailNotification, setDetailNotification] = useState<any | null>(null);
  const [details, setDetails] = useState<AppointmentDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  async function openDetails(n: any) {
    setDetailNotification(n);
    setDetails(null);
    if (!n.appointment_id) return;
    setDetailsLoading(true);
    const { data } = await supabase
      .from("appointments")
      .select("client_name, client_phone, starts_at, status, services(name), masters(name), branches(name)")
      .eq("id", n.appointment_id)
      .maybeSingle();
    setDetails((data as AppointmentDetails | null) ?? null);
    setDetailsLoading(false);
    if (!n.is_read) markRead(n.id);
  }

  // Map appointment_id → branch_id and addons list.
  const [apptBranch, setApptBranch] = useState<Record<string, string | null>>({});
  const [apptAddons, setApptAddons] = useState<Record<string, string[]>>({});
  const [salonNames, setSalonNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = Array.from(
      new Set(items.map((i: any) => i.appointment_id).filter(Boolean) as string[]),
    );
    const missing = ids.filter((id) => !(id in apptBranch));
    if (missing.length === 0) return;
    supabase
      .from("appointments")
      .select("id, branch_id, salon_id")
      .in("id", missing)
      .then(({ data }) => {
        const next = { ...apptBranch };
        (data ?? []).forEach((r: any) => {
          next[r.id] = r.branch_id ?? null;
        });
        setApptBranch(next);
      });
    supabase
      .from("appointment_addons")
      .select("appointment_id, name_snapshot")
      .in("appointment_id", missing)
      .then(({ data }) => {
        const map: Record<string, string[]> = {};
        for (const a of (data ?? []) as any[]) (map[a.appointment_id] ||= []).push(a.name_snapshot);
        setApptAddons((prev) => ({ ...prev, ...map }));
      });
  }, [items]);

  // Для супер-админа подгружаем названия салонов, чтобы показывать в карточке уведомления.
  useEffect(() => {
    if (!isSuperAdmin) return;
    const sids = Array.from(new Set(items.map((i: any) => i.salon_id).filter(Boolean) as string[]));

    const missing = sids.filter((id) => !(id in salonNames));
    if (missing.length === 0) return;
    supabase
      .from("salons")
      .select("id, name")
      .in("id", missing)
      .then(({ data }) => {
        const map: Record<string, string> = { ...salonNames };
        for (const s of (data ?? []) as any[]) map[s.id] = s.name;
        setSalonNames(map);
      });
  }, [items, isSuperAdmin]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    setPerm(Notification.permission);
    const t = setInterval(() => setPerm(Notification.permission), 1500);
    return () => clearInterval(t);
  }, []);

  const addPushDebug = (message: string, details?: unknown) => {
    const time = new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    let line = `[${time}] ${message}`;
    if (details !== undefined) {
      try {
        line += ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
      } catch {
        line += ` ${String(details)}`;
      }
    }
    setPushDebug((prev) => [line, ...prev].slice(0, 40));
  };

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.source === "qabyl-sw")
        addPushDebug(`SW: ${event.data.event}`, event.data.details ?? null);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  const refreshPushSnapshot = async () => {
    addPushDebug("snapshot", {
      permission: "Notification" in window ? Notification.permission : "missing",
      pushSupported: isPushSupported(),
      ios: isIos(),
      standalone: isStandalonePWA(),
      userAgent: navigator.userAgent,
    });
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js").catch((e) => {
        addPushDebug("SW registration read failed", e?.message ?? String(e));
        return null;
      });
      addPushDebug(
        "SW registration",
        reg
          ? {
              scope: reg.scope,
              active: reg.active?.state ?? null,
              waiting: reg.waiting?.state ?? null,
              installing: reg.installing?.state ?? null,
            }
          : "none",
      );
      const sub = await reg?.pushManager.getSubscription().catch((e) => {
        addPushDebug("subscription read failed", e?.message ?? String(e));
        return null;
      });
      addPushDebug("browser subscription", sub ? { endpoint: sub.endpoint.slice(0, 90) } : "none");
    }
  };

  const requestPerm = async () => {
    setPushBusy(true);
    setPushDebug([]);
    addPushDebug("button click: start direct permission flow");
    if (!isPushSupported()) {
      // Fallback to basic permission request
      if ("Notification" in window) {
        const p = await Notification.requestPermission();
        setPerm(p);
        addPushDebug("permission fallback result", p);
      }
      setPushBusy(false);
      return;
    }
    try {
      addPushDebug("permission before request", Notification.permission);
      if (Notification.permission === "default") {
        const p = await Notification.requestPermission();
        setPerm(p);
        addPushDebug("permission direct result", p);
        if (p !== "granted") {
          toast.error("Разрешение на уведомления не выдано");
          await refreshPushSnapshot();
          return;
        }
      }
      const res = await ensurePushSubscription({
        salonId,
        branchId: filters.branchId !== "all" ? filters.branchId : null,
        forceResubscribe: true,
        skipPermissionRequest: true,
        debug: addPushDebug,
      });
      if (res.ok) {
        setPerm("granted");
        toast.success("Push-уведомления включены");
      } else if (res.reason === "ios-needs-install") {
        toast.info(
          "На iPhone сначала добавьте сайт на главный экран: «Поделиться» → «На экран Домой», затем откройте приложение с домашнего экрана и снова нажмите «Разрешить уведомления».",
        );
      } else if (res.reason === "denied") {
        toast.error("Разрешение на уведомления отклонено. Включите его в настройках браузера.");
      } else if (res.reason === "no-vapid") {
        toast.error("Push не настроен: отсутствует VAPID-ключ");
      } else {
        toast.error(`Не удалось включить уведомления: ${(res as any).error ?? res.reason}`);
      }
      await refreshPushSnapshot();
    } catch (error: any) {
      addPushDebug("fatal error", error?.message ?? String(error));
      toast.error(`Push ошибка: ${error?.message ?? String(error)}`);
    } finally {
      setPushBusy(false);
    }
  };

  // Auto re-subscribe on each load when permission already granted (refresh endpoint mapping)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isPushSupported()) return;
    if (Notification.permission !== "granted") return;
    ensurePushSubscription({
      salonId,
      branchId: filters.branchId !== "all" ? filters.branchId : null,
      skipPermissionRequest: true,
    }).catch(() => {});
  }, [salonId, filters.branchId]);

  const visible = useMemo(() => {
    return items.filter((n: any) => {
      if (filters.salonId !== "all" && n.salon_id !== filters.salonId) return false;
      if (filters.branchId !== "all") {
        // Филиал самого уведомления, а если его нет — филиал записи (строки,
        // созданные до фикса триггера, приходят с branch_id = NULL).
        // null = «на весь салон», undefined = ещё не догрузилось: и то и другое
        // показываем, иначе список молча пустеет — см. matchesBranchScope.
        const b = n.branch_id ?? (n.appointment_id ? apptBranch[n.appointment_id] : null);
        if (!matchesBranchScope(b, filters.branchId)) return false;
      }
      return true;
    });
  }, [items, filters.salonId, filters.branchId, apptBranch]);

  async function openRestore(n: any) {
    if (!n.appointment_id) return;
    const { data, error } = await supabase
      .from("appointments")
      .select("id, status, client_name, starts_at, ends_at, services(name)")
      .eq("id", n.appointment_id)
      .maybeSingle();
    if (error || !data) {
      toast.error("Не удалось загрузить запись");
      return;
    }
    if ((data as any).status === "confirmed") {
      toast.info("Запись уже активна");
      return;
    }
    setRestoreTarget({
      apptId: data.id,
      notifId: n.id,
      client_name: (data as any).client_name ?? "—",
      service: (data as any).services?.name ?? "услуга",
      starts_at: (data as any).starts_at,
      ends_at: (data as any).ends_at,
    });
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    const t = restoreTarget;
    // Conflict check
    const { data: appt } = await supabase
      .from("appointments")
      .select("master_id, starts_at, ends_at")
      .eq("id", t.apptId)
      .maybeSingle();
    if (!appt) {
      toast.error("Запись не найдена");
      setRestoreTarget(null);
      return;
    }
    const { data: conflicts } = await supabase
      .from("appointments")
      .select("id, client_name, starts_at, ends_at, services(name)")
      .eq("master_id", (appt as any).master_id)
      .eq("status", "confirmed")
      .lt("starts_at", (appt as any).ends_at)
      .gt("ends_at", (appt as any).starts_at)
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
    const { error } = await supabase
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", t.apptId);
    if (error) {
      toast.error(humanError(error));
      return;
    }
    toast.success("Запись восстановлена");
    markRead(t.notifId);
    setRestoreTarget(null);
    refresh?.();
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Уведомления</h1>
          <p className="text-sm text-muted-foreground">
            События по записям клиентов в реальном времени
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            <CheckCheck className="h-4 w-4 mr-1" />
            Отметить всё прочитанным
          </Button>
        )}
      </div>

      <BranchFilterBar filters={filters} showSalon={isSuperAdmin || filters.salons.length > 1} />

      {/* Диагностика пушей.
          
          БЫЛО: карточка «Push debug на этом устройстве» со строкой вида
          «Permission: default · PWA: no · iOS: no · Push: yes» — открытым текстом, первым блоком
          на экране, который владелец салона открывает каждый день. Она же дублировала кнопку
          «Включить уведомления» из карточки ниже.
          
          СТАЛО: свёрнутый блок с человеческим вопросом на обложке. Убирать её совсем нельзя —
          это единственное место, где видно точную причину, по которой телефон не показывает
          уведомления, и без неё разбор сводится к переписке «а у вас точно разрешено?». */}
      <Card className="p-0">
        <button
          type="button"
          onClick={() => setDiagOpen((v) => !v)}
          aria-expanded={diagOpen}
          className="qb-press flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted/40"
        >
          <div className="min-w-0">
            <div className="font-medium">Уведомления не приходят?</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Проверим это устройство и покажем, что именно мешает.
            </p>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
              diagOpen ? "rotate-180" : ""
            }`}
          />
        </button>
        {diagOpen && (
          <div className="qb-rise space-y-3 border-t p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={requestPerm} disabled={pushBusy}>
                {pushBusy ? "Проверяю…" : "Включить уведомления здесь"}
              </Button>
              <Button variant="outline" size="sm" onClick={refreshPushSnapshot} disabled={pushBusy}>
                Проверить ещё раз
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Разрешение:{" "}
              {typeof window !== "undefined" && "Notification" in window
                ? Notification.permission === "granted"
                  ? "есть"
                  : Notification.permission === "denied"
                    ? "запрещено в браузере"
                    : "ещё не спрашивали"
                : "браузер не умеет"}{" "}
              · Установлено как приложение: {isStandalonePWA() ? "да" : "нет"}
              {isIos() ? " · iPhone: уведомления приходят только установленному приложению" : ""}
            </p>
            <div className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {pushDebug.length ? (
                pushDebug.map((line, i) => (
                  <div key={`${line}-${i}`} className="break-words">
                    {line}
                  </div>
                ))
              ) : (
                <div>Нажмите кнопку выше — здесь появится точная причина.</div>
              )}
            </div>
          </div>
        )}
      </Card>

      {perm !== "granted" && perm !== "unsupported" && (
        <Card className="p-4 flex items-start gap-3 bg-muted/50">
          <Bell className="h-5 w-5 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Включите push-уведомления</div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Получайте мгновенные оповещения о новых записях — в браузере и на телефоне (даже когда
              приложение закрыто).
            </p>
            {isIos() && !isStandalonePWA() && (
              <p className="text-xs text-amber-700 mt-1">
                На iPhone: нажмите «Поделиться» → «На экран Домой», затем откройте Qabyl с домашнего
                экрана и нажмите «Разрешить».
              </p>
            )}
            <Button size="sm" className="mt-2" onClick={requestPerm} disabled={pushBusy}>
              Включить уведомления на этом устройстве
            </Button>
          </div>
        </Card>
      )}
      {perm === "unsupported" && (
        <Card className="p-4 flex items-center gap-3 bg-muted/50">
          <BellOff className="h-5 w-5" />
          <p className="text-sm text-muted-foreground">
            Этот браузер не поддерживает push-уведомления.
          </p>
        </Card>
      )}

      {loading ? (
        <LoadingState />
      ) : visible.length === 0 ? (
        <Card className="p-8 text-center">
          <Bell className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
          <p className="text-muted-foreground">Уведомлений для выбранного фильтра пока нет</p>
        </Card>
      ) : (
        <NotificationsByDay
          items={visible}
          markRead={markRead}
          canRestore={canRestore}
          onRestore={openRestore}
          tz={tz}
          apptAddons={apptAddons}
          salonNames={isSuperAdmin ? salonNames : null}
          openDetails={openDetails}
        />
      )}

      <Dialog open={!!detailNotification} onOpenChange={(open) => !open && setDetailNotification(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Детали записи</DialogTitle></DialogHeader>
          {detailsLoading ? <LoadingState /> : details ? (
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{vocabulary.client[0].toUpperCase() + vocabulary.client.slice(1)}</dt><dd>{details.client_name || "—"}</dd>
              <dt className="text-muted-foreground">Телефон</dt><dd>{details.client_phone || "—"}</dd>
              <dt className="text-muted-foreground">{vocabulary.service[0].toUpperCase() + vocabulary.service.slice(1)}</dt><dd>{details.services?.name || "—"}</dd>
              <dt className="text-muted-foreground">{vocabulary.specialist[0].toUpperCase() + vocabulary.specialist.slice(1)}</dt><dd>{details.masters?.name || "—"}</dd>
              {details.branches?.name && <><dt className="text-muted-foreground">Филиал</dt><dd>{details.branches.name}</dd></>}
              <dt className="text-muted-foreground">Дата и время</dt><dd>{formatInTz(details.starts_at, tz, { dateStyle: "medium", timeStyle: "short" })}</dd>
              <dt className="text-muted-foreground">Статус</dt><dd>{details.status === "confirmed" ? "Подтверждена" : details.status === "cancelled" ? "Отменена" : details.status}</dd>
              {detailNotification?.metadata?.previous_starts_at && <><dt className="text-muted-foreground">Было</dt><dd>{formatInTz(detailNotification.metadata.previous_starts_at, tz, { dateStyle: "medium", timeStyle: "short" })}</dd></>}
              {detailNotification?.metadata?.cancelled_by && <><dt className="text-muted-foreground">Кто отменил</dt><dd>{detailNotification.metadata.cancelled_by}</dd></>}
            </dl>
          ) : <p className="text-sm text-muted-foreground">Исторические детали этой записи недоступны. {detailNotification?.body}</p>}
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
                  {restoreTarget.service}
                  {", "}
                  {formatInTz(restoreTarget.starts_at, tz, {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                  {" – "}
                  {formatInTz(restoreTarget.ends_at, tz, { hour: "2-digit", minute: "2-digit" })}
                  {". После восстановления статус снова станет «Подтверждена»."}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRestore}>Восстановить</AlertDialogAction>
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
                  {" ("}
                  {conflictInfo.service}
                  {") "}с{" "}
                  {formatInTz(conflictInfo.starts_at, tz, { hour: "2-digit", minute: "2-digit" })}
                  {" до "}
                  {formatInTz(conflictInfo.ends_at, tz, { hour: "2-digit", minute: "2-digit" })}.
                  Восстановить нельзя — сначала отмените или перенесите конфликтующую запись.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setConflictInfo(null)}>Понятно</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NotificationsByDay({
  items,
  markRead,
  canRestore,
  onRestore,
  tz,
  apptAddons,
  salonNames,
  openDetails,
}: {
  items: any[];
  markRead: (id: string) => void;
  canRestore: boolean;
  onRestore: (n: any) => void;
  tz: string;
  apptAddons: Record<string, string[]>;
  salonNames?: Record<string, string> | null;
  openDetails: (n: any) => void;
}) {
  const groups = useMemo(() => {
    const todayKey = dayKeyInTz(new Date(), tz);
    const yKey = dayKeyInTz(new Date(Date.now() - 86400000), tz);
    const fmtLabel = (key: string, sample: Date) => {
      if (key === todayKey)
        return "Сегодня, " + formatInTz(sample, tz, { day: "numeric", month: "long" });
      if (key === yKey)
        return "Вчера, " + formatInTz(sample, tz, { day: "numeric", month: "long" });
      return formatInTz(sample, tz, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    };
    const map = new Map<string, { label: string; items: any[] }>();
    for (const n of items) {
      const k = dayKeyInTz(n.created_at, tz);
      if (!map.has(k)) map.set(k, { label: fmtLabel(k, new Date(n.created_at)), items: [] });
      map.get(k)!.items.push(n);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([_, v]) => v);
  }, [items, tz]);

  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const unread = g.items.filter((i) => !i.is_read).length;
        return (
          <div key={g.label} className="space-y-2">
            <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {g.label}{" "}
                <span className="text-xs font-normal text-muted-foreground/70">
                  · {g.items.length}
                </span>
              </h2>
              {unread > 0 && (
                <button
                  onClick={() => g.items.filter((i) => !i.is_read).forEach((i) => markRead(i.id))}
                  className="text-xs text-primary hover:underline"
                >
                  Прочитать всё ({unread})
                </button>
              )}
            </div>
            <div className="space-y-2">
              {g.items.map((n) => {
                const isCancelled = n.type === "appointment.cancelled" && !!n.appointment_id;
                return (
                  <Card
                    key={n.id}
                    role={n.appointment_id ? "button" : undefined}
                    tabIndex={n.appointment_id ? 0 : undefined}
                    onClick={() => n.appointment_id && openDetails(n)}
                    onKeyDown={(e) => {
                      if (n.appointment_id && (e.key === "Enter" || e.key === " ")) openDetails(n);
                    }}
                    className={`p-4 flex items-start gap-3 ${n.appointment_id ? "cursor-pointer hover:bg-muted/30" : ""} ${n.is_read ? "opacity-70" : ""}`}
                  >
                    <div
                      className={`h-2 w-2 rounded-full mt-2 shrink-0 ${n.is_read ? "bg-muted" : "bg-primary"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{n.title}</div>
                      {salonNames && n.salon_id && salonNames[n.salon_id] && (
                        <div className="text-[11px] uppercase tracking-wide text-primary/80 mt-0.5">
                          Салон: {salonNames[n.salon_id]}
                        </div>
                      )}
                      {n.body && (
                        <p className="text-sm text-muted-foreground mt-0.5 break-words">
                          {n.body}
                          {n.appointment_id && apptAddons[n.appointment_id]?.length
                            ? " + " + apptAddons[n.appointment_id].join(", ")
                            : ""}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatInTz(n.created_at, tz, { hour: "2-digit", minute: "2-digit" })}
                      </p>

                      {isCancelled && canRestore && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={(e) => { e.stopPropagation(); onRestore(n); }}
                        >
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                          Восстановить запись
                        </Button>
                      )}
                    </div>
                    {!n.is_read && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                        title="Отметить прочитанным"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
