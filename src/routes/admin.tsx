import { Link, Outlet, useNavigate, createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signOutFromApp, useAuth } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  LayoutDashboard,
  Building2,
  Calendar,
  LogOut,
  BarChart3,
  Settings,
  Menu,
  Bell,
  UserCog,
  Activity,
  AlertOctagon,
  CreditCard,
} from "lucide-react";
import { useNotifications } from "@/hooks/use-notifications";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { RefreshProvider } from "@/lib/refresh-context";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { ensurePushSubscription, isPushSupported, isIos, isStandalonePWA } from "@/lib/push";
import { getBillingStatus } from "@/lib/billing.functions";
import { BillingBanner, BillingPaywall } from "@/components/admin/BillingBanner";
import { ProductTour, ownerTourSteps, useTourAutostart } from "@/components/admin/ProductTour";
import { InstallPrompt } from "@/components/admin/InstallPrompt";
import type { BillingState } from "@/lib/billing-logic";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Админ-панель — Qabyl" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const { user, loading, rolesLoading, isSuperAdmin, isSalonAdmin, isMaster, salonId, branchId } =
    useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [billing, setBilling] = useState<BillingState | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  // Роль появляется только после того, как салон заведён (create_salon_for_owner выдаёт
  // salon_admin в той же транзакции). Пока её нет, идти в кабинет некуда — там всё пусто.
  useEffect(() => {
    if (loading || rolesLoading || !user) return;
    if (!isSuperAdmin && !isSalonAdmin && !isMaster) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [loading, rolesLoading, user, isSuperAdmin, isSalonAdmin, isMaster, navigate]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Состояние оплаты салона: баннер и экран блокировки. Перечитывается при переходах, чтобы после
  // оплаты кабинет открылся без перезагрузки. Ошибка чтения — кабинет открыт (fail-open): сбой
  // нашего учёта не должен запирать салон.
  useEffect(() => {
    if (!salonId || isSuperAdmin) return;
    let cancelled = false;
    getBillingStatus({ data: { salonId } })
      .then((r) => {
        if (!cancelled) setBilling(r.state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [salonId, isSuperAdmin, location.pathname]);

  // Master should land on calendar — no dashboard available
  useEffect(() => {
    if (isMaster && !isSuperAdmin && !isSalonAdmin && location.pathname === "/admin") {
      navigate({ to: "/admin/calendar", replace: true });
    }
  }, [isMaster, isSuperAdmin, isSalonAdmin, location.pathname, navigate]);

  // Auto-request push permission on first visit to admin area.
  // Masters get only their branch; salon_admins get whole salon; super_admin gets all (no salon/branch filter).
  useEffect(() => {
    if (!user) return;
    if (!isPushSupported()) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "denied") return;
    if (isIos() && !isStandalonePWA()) return; // iOS needs PWA install
    const masterScope = isMaster && !isSuperAdmin && !isSalonAdmin;
    const subSalonId = isSuperAdmin ? null : (salonId ?? null);
    const subBranchId = masterScope ? (branchId ?? null) : null;
    ensurePushSubscription({
      salonId: subSalonId,
      branchId: subBranchId,
      skipPermissionRequest: true,
    }).catch(() => {});

    // Браузер может отозвать подписку в любой момент (см. pushsubscriptionchange
    // в public/sw.js). Без этого слушателя новый endpoint попадёт в базу только
    // при следующем заходе в /admin — а до тех пор пуши тихо не приходят.
    if (!("serviceWorker" in navigator)) return;
    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.source !== "qabyl-sw") return;
      if (event.data.event !== "subscription-renew") return;
      ensurePushSubscription({
        salonId: subSalonId,
        branchId: subBranchId,
        skipPermissionRequest: true,
      }).catch(() => {});
    };
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onSwMessage);
  }, [user, isSuperAdmin, isSalonAdmin, isMaster, salonId, branchId]);

  // Экскурсия заказывается онбордингом и запускается здесь: раньше просто нечего подсвечивать —
  // меню ещё не нарисовано. Мастеру и супер-админу она не показывается: первому кабинет состоит
  // из одного календаря, второй его и построил.
  const tourEligible = Boolean(isSalonAdmin && !isSuperAdmin && salonId);
  const [tourOpen, closeTour] = useTourAutostart(tourEligible);

  const { unreadCount } = useNotifications({
    salonId,
    isSuperAdmin,
    branchId: isMaster && !isSuperAdmin && !isSalonAdmin ? branchId : null,
  });

  // Пока сессия или роли еще не подгрузились — показываем спиннер,
  // а не экран "Нет доступа" и не редирект на /auth.
  if (loading || (user && rolesLoading)) return <FullScreenLoader />;
  if (!user) return null;

  const hasAccess = isSuperAdmin || isSalonAdmin || isMaster;

  // Аккаунт без единой роли — это НЕ «нет доступа». Это человек, который только что
  // зарегистрировался и ещё не завёл салон: раньше он упирался здесь в тупик, из которого не было
  // выхода, кроме письма в поддержку. Отправляем его в мастер настройки — единственное место, где
  // из такого состояния есть дорога дальше.
  if (!hasAccess) return null;

  const navItems =
    isMaster && !isSuperAdmin && !isSalonAdmin
      ? [
          { to: "/admin/calendar", label: "Календарь", icon: Calendar, tour: "nav-calendar" },
          { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
          { to: "/admin/account", label: "Аккаунт", icon: UserCog },
        ]
      : isSuperAdmin
        ? [
            { to: "/admin", label: "Дашборд", icon: LayoutDashboard, exact: true },
            { to: "/admin/ops", label: "Ops Dashboard", icon: Activity },
            { to: "/admin/errors", label: "Ошибки", icon: AlertOctagon },
            { to: "/admin/salons", label: "Салоны", icon: Building2 },
            { to: "/admin/billing", label: "Биллинг", icon: CreditCard },
            { to: "/admin/calendar", label: "Календарь", icon: Calendar },
            { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
            { to: "/admin/stats", label: "Статистика", icon: BarChart3 },
            { to: "/admin/account", label: "Аккаунт", icon: UserCog },
          ]
        : [
            {
              to: "/admin",
              label: "Дашборд",
              icon: LayoutDashboard,
              exact: true,
              tour: "nav-dashboard",
            },
            { to: "/admin/calendar", label: "Календарь", icon: Calendar, tour: "nav-calendar" },
            { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
            { to: "/admin/stats", label: "Статистика", icon: BarChart3 },
            ...(salonId
              ? [
                  {
                    to: `/admin/salons/${salonId}`,
                    label: "Мой салон",
                    icon: Settings,
                    tour: "nav-settings",
                  },
                ]
              : []),
            { to: "/admin/billing", label: "Тариф и оплата", icon: CreditCard },
            { to: "/admin/account", label: "Аккаунт", icon: UserCog },
          ];

  const roleLabel = isSuperAdmin
    ? "Админ-панель"
    : isSalonAdmin
      ? "Кабинет салона"
      : "Кабинет мастера";

  // Неоплаченный салон видит только экран оплаты. Страницы тарифа и аккаунта открыты: без первой
  // не оплатить, без второй не сменить пароль и не выйти.
  const paywalled =
    !isSuperAdmin &&
    billing?.blocked === true &&
    !location.pathname.startsWith("/admin/billing") &&
    !location.pathname.startsWith("/admin/account");

  const SidebarContent = (
    <>
      <div className="p-6 border-b">
        <h1 className="font-bold">Qabyl</h1>
        <p className="text-xs text-muted-foreground">{roleLabel}</p>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const active = item.exact
            ? location.pathname === item.to
            : location.pathname.startsWith(item.to);
          const badge = (item as any).badge as number | undefined;
          return (
            <Link
              key={item.to}
              to={item.to as any}
              data-tour={(item as any).tour}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              <item.icon className="h-4 w-4" />
              <span className="flex-1">{item.label}</span>
              {badge ? (
                <span
                  className={`text-[10px] min-w-5 h-5 px-1.5 rounded-full flex items-center justify-center ${active ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground"}`}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={async () => {
            await signOutFromApp();
            navigate({ to: "/auth", replace: true });
          }}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Выйти
        </Button>
      </div>
    </>
  );

  return (
    <div className="h-[100dvh] flex overflow-hidden">
      <aside className="hidden md:flex w-60 border-r bg-card flex-col shrink-0">
        {SidebarContent}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        {/* На телефоне шапка показывала только слово «Qabyl». После перехода вглубь (запись,
            настройки, переписка) понять, где ты находишься, было можно только по содержимому
            экрана. Название раздела стоит одной строки и снимает этот вопрос. */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card px-4 md:hidden">
          <div className="min-w-0">
            <div className="truncate font-semibold leading-tight">
              {navItems.find((i) =>
                (i as any).exact ? location.pathname === i.to : location.pathname.startsWith(i.to),
              )?.label ?? "Qabyl"}
            </div>
            <div className="text-[11px] leading-tight text-muted-foreground">Qabyl</div>
          </div>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0 flex flex-col">
              {SidebarContent}
            </SheetContent>
          </Sheet>
        </header>
        {!isSuperAdmin && isSalonAdmin && <BillingBanner state={billing} />}
        <RefreshProvider>
          <PullToRefresh className="flex-1 overflow-auto relative">
            {paywalled ? <BillingPaywall isOwner={isSalonAdmin} /> : <Outlet />}
          </PullToRefresh>
        </RefreshProvider>
        {/* Предложение установки не показывается, пока салон заперт экраном оплаты: просить
            поставить приложение у того, кто не может им пользоваться, — издевательство. */}
        {!paywalled && isSalonAdmin && !isSuperAdmin && <InstallPrompt />}
      </div>
      {tourEligible && (
        <ProductTour steps={ownerTourSteps(salonId)} open={tourOpen} onClose={closeTour} />
      )}
    </div>
  );
}
