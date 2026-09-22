import { Link, Outlet, useNavigate, createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signOutFromApp, useAuth } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  MessageSquare,
  LayoutDashboard,
  Building2,
  Calendar,
  LogOut,
  BarChart3,
  Settings,
  Menu,
  Bell,
  UserCog,
  Smartphone,
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
import { watchSystemTheme } from "@/lib/theme";
import type { BillingState } from "@/lib/billing-logic";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Админ-панель — Qabyl" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const {
    user,
    loading,
    rolesLoading,
    recovering,
    isSuperAdmin,
    isSalonAdmin,
    isManager,
    isMaster,
    salonId,
    branchId,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [billing, setBilling] = useState<BillingState | null>(null);

  // Редирект на экран входа — необратимое действие: человек теряет место, на котором стоял, и
  // обратно его приводит только повторный ввод пароля. Поэтому он делается ТОЛЬКО когда сессии
  // действительно нет: пока auth-client пробует её поднять (recovering), кабинет ждёт. Раньше
  // этого условия не было, и любой разрыв связи на телефоне читался как выход.
  useEffect(() => {
    if (!loading && !recovering && !user) navigate({ to: "/auth" });
  }, [loading, recovering, user, navigate]);

  // Роль появляется только после того, как салон заведён (create_salon_for_owner выдаёт
  // salon_admin в той же транзакции). Пока её нет, идти в кабинет некуда — там всё пусто.
  useEffect(() => {
    if (loading || rolesLoading || !user) return;
    if (!isSuperAdmin && !isSalonAdmin && !isManager && !isMaster) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [loading, rolesLoading, user, isSuperAdmin, isSalonAdmin, isManager, isMaster, navigate]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Телефон, уходящий в тёмную тему по расписанию, должен утащить за собой и кабинет —
  // но только у тех, кто не выбрал тему руками. См. src/lib/theme.ts.
  useEffect(() => {
    watchSystemTheme();
  }, []);

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
  // а не экран "Нет доступа" и не редирект на /auth. recovering здесь по той же причине:
  // восстановление сессии выглядит для человека как обычная загрузка, а не как выход.
  if (loading || recovering || (user && rolesLoading)) return <FullScreenLoader />;
  if (!user) return null;

  const hasAccess = isSuperAdmin || isSalonAdmin || isManager || isMaster;

  // Аккаунт без единой роли — это НЕ «нет доступа». Это человек, который только что
  // зарегистрировался и ещё не завёл салон: раньше он упирался здесь в тупик, из которого не было
  // выхода, кроме письма в поддержку. Отправляем его в мастер настройки — единственное место, где
  // из такого состояния есть дорога дальше.
  if (!hasAccess) return null;

  // Администратор на ресепшене: всё про сегодняшний день и ни одной настройки. Цены, тариф и
  // статистика — не его работа и не его данные.
  const managerOnly = isManager && !isSuperAdmin && !isSalonAdmin;

  const navItems = managerOnly
    ? [
        { to: "/admin/calendar", label: "Календарь", icon: Calendar, tour: "nav-calendar" },
        { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
        ...(salonId
          ? [
              {
                to: `/admin/salons/${salonId}`,
                search: { tab: "chats" },
                label: "Переписки",
                icon: MessageSquare,
              },
            ]
          : []),
        { to: "/admin/install", label: "Приложение", icon: Smartphone },
        { to: "/admin/account", label: "Аккаунт", icon: UserCog },
      ]
    : isMaster && !isSuperAdmin && !isSalonAdmin
      ? [
          { to: "/admin/calendar", label: "Календарь", icon: Calendar, tour: "nav-calendar" },
          { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
          { to: "/admin/install", label: "Приложение", icon: Smartphone },
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
            { to: "/admin/install", label: "Приложение", icon: Smartphone },
            { to: "/admin/account", label: "Аккаунт", icon: UserCog },
          ]
        : [
            {
              to: "/admin",
              // «Сегодня», а не «Дашборд». Раздел называется тем, что в нём лежит: записи на
              // сегодня и состояние салона на сейчас. «Дашборд» — слово из другого продукта, и
              // владелице салона оно не говорит ничего.
              label: "Сегодня",
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
            { to: "/admin/install", label: "Приложение", icon: Smartphone },
            { to: "/admin/account", label: "Аккаунт", icon: UserCog },
          ];

  /**
   * Нижняя навигация телефона.
   *
   * ЗАЧЕМ. До неё единственным входом в разделы на телефоне был бургер в ЛЕВОМ ВЕРХНЕМ углу:
   * любой переход стоил трёх касаний, одно из которых — в угол, куда большой палец правой руки
   * не достаёт. Кабинет, который владелица открывает двадцать раз в день между клиентами,
   * стоял на навигации, спроектированной для мыши.
   *
   * ПОЧЕМУ РОВНО ЧЕТЫРЕ. Пятая вкладка уже не попадает под палец на узком экране, а главное —
   * пятый пункт всегда оказывается чьим-то шестым. Четыре — это три самых частых дела роли и
   * дверь «Ещё» во всё остальное; полный список никуда не делся, он за этой дверью.
   *
   * Набор различается по роли, потому что различается работа: владелица смотрит день и
   * переписки, мастер — только свой календарь, супер-админ — все салоны.
   */
  const moreTab = { key: "more", label: "Ещё", icon: Menu } as const;
  const mobileTabs: {
    key: string;
    label: string;
    icon: typeof Calendar;
    to?: string;
    search?: Record<string, string>;
    exact?: boolean;
    badge?: number;
    tour?: string;
  }[] = managerOnly
    ? [
        {
          key: "cal",
          to: "/admin/calendar",
          label: "Календарь",
          icon: Calendar,
          tour: "nav-calendar",
        },
        ...(salonId
          ? [
              {
                key: "chats",
                to: `/admin/salons/${salonId}`,
                search: { tab: "chats" },
                label: "Переписки",
                icon: MessageSquare,
              },
            ]
          : []),
        {
          key: "notif",
          to: "/admin/notifications",
          label: "Уведомления",
          icon: Bell,
          badge: unreadCount,
        },
        moreTab,
      ]
    : isMaster && !isSuperAdmin && !isSalonAdmin
      ? [
          {
            key: "cal",
            to: "/admin/calendar",
            label: "Календарь",
            icon: Calendar,
            tour: "nav-calendar",
          },
          {
            key: "notif",
            to: "/admin/notifications",
            label: "Уведомления",
            icon: Bell,
            badge: unreadCount,
          },
          moreTab,
        ]
      : isSuperAdmin
        ? [
            { key: "home", to: "/admin", label: "Дашборд", icon: LayoutDashboard, exact: true },
            { key: "salons", to: "/admin/salons", label: "Салоны", icon: Building2 },
            { key: "ops", to: "/admin/ops", label: "Ops", icon: Activity },
            moreTab,
          ]
        : [
            {
              key: "home",
              to: "/admin",
              label: "Сегодня",
              icon: LayoutDashboard,
              exact: true,
              tour: "nav-dashboard",
            },
            {
              key: "cal",
              to: "/admin/calendar",
              label: "Календарь",
              icon: Calendar,
              tour: "nav-calendar",
            },
            ...(salonId
              ? [
                  {
                    key: "chats",
                    to: `/admin/salons/${salonId}`,
                    search: { tab: "chats" },
                    label: "Переписки",
                    icon: MessageSquare,
                  },
                ]
              : []),
            moreTab,
          ];

  // Бейдж непрочитанных не должен пропадать только потому, что «Уведомления» уехали в «Ещё»:
  // иначе владелица узнаёт о новой записи, лишь заглянув туда по своей воле.
  const moreBadge = mobileTabs.some((t) => t.key === "notif") ? 0 : unreadCount;

  const roleLabel = isSuperAdmin
    ? "Админ-панель"
    : isSalonAdmin
      ? "Кабинет салона"
      : managerOnly
        ? "Кабинет администратора"
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
          const active = (item as any).exact
            ? location.pathname === item.to
            : location.pathname.startsWith(item.to);
          const badge = (item as any).badge as number | undefined;
          return (
            <Link
              key={item.to}
              to={item.to as any}
              search={((item as any).search ?? {}) as any}
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
        {/* Шапка телефона: только «где я нахожусь».
            
            Бургера здесь больше нет — переходы уехали вниз, под большой палец. Шапка осталась
            ради одной вещи: на вложенных страницах (настройки салона, тариф, ошибки) название
            активной вкладки внизу уже не отвечает на вопрос, что именно открыто. */}
        <header
          className="sticky z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-card px-4 md:hidden"
          style={{ top: "env(safe-area-inset-top, 0px)" }}
        >
          <span className="truncate text-[15px] font-semibold leading-none">
            {navItems.find((i) =>
              (i as any).exact ? location.pathname === i.to : location.pathname.startsWith(i.to),
            )?.label ?? "Кабинет"}
          </span>
        </header>
        {!isSuperAdmin && <BillingBanner state={billing} isOwner={isSalonAdmin} />}
        <RefreshProvider>
          <PullToRefresh className="flex-1 overflow-auto relative">
            {paywalled ? <BillingPaywall isOwner={isSalonAdmin} /> : <Outlet />}
          </PullToRefresh>
        </RefreshProvider>
        {/* Предложение установки не показывается, пока салон заперт экраном оплаты: просить
            поставить приложение у того, кто не может им пользоваться, — издевательство.
            Мастерам предлагаем наравне с владельцем: они смотрят календарь с телефона весь день,
            а на iPhone push о новой записи приходит только установленному приложению. */}
        {!paywalled && !isSuperAdmin && (isSalonAdmin || isMaster) && <InstallPrompt />}

        {/* Нижняя навигация. Не position: fixed, а обычный последний ребёнок колонки: так она
            физически не может наехать на содержимое, и странице не нужен «отступ под панель»,
            который обязательно разъедется с высотой панели. */}
        <nav
          className="flex shrink-0 border-t bg-card md:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          aria-label="Разделы"
        >
          {mobileTabs.map((tab) => {
            if (tab.key === "more") {
              return (
                <Sheet key="more" open={mobileOpen} onOpenChange={setMobileOpen}>
                  <SheetTrigger asChild>
                    <button
                      type="button"
                      className="qb-press relative flex min-h-[54px] flex-1 flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <tab.icon className="h-5 w-5" />
                      <span className="leading-none">{tab.label}</span>
                      {moreBadge > 0 && (
                        <span className="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-primary" />
                      )}
                    </button>
                  </SheetTrigger>
                  <SheetContent side="left" className="flex w-[17rem] flex-col p-0">
                    {SidebarContent}
                  </SheetContent>
                </Sheet>
              );
            }
            const active = tab.exact
              ? location.pathname === tab.to
              : location.pathname.startsWith(tab.to!);
            return (
              <Link
                key={tab.key}
                to={tab.to as any}
                search={(tab.search ?? {}) as any}
                data-tour={tab.tour}
                aria-current={active ? "page" : undefined}
                className={`qb-press relative flex min-h-[54px] flex-1 flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <tab.icon className={`h-5 w-5 ${active ? "stroke-[2.4]" : ""}`} />
                <span className="truncate leading-none">{tab.label}</span>
                {tab.badge ? (
                  <span className="absolute right-[22%] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
                    {tab.badge > 99 ? "99+" : tab.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>
      {tourEligible && (
        <ProductTour steps={ownerTourSteps(salonId)} open={tourOpen} onClose={closeTour} />
      )}
    </div>
  );
}
