import { Link, Outlet, useNavigate, createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signOutFromApp, useAuth } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { LayoutDashboard, Building2, Calendar, LogOut, BarChart3, Settings, Menu, Bell, UserCog } from "lucide-react";
import { useNotifications } from "@/hooks/use-notifications";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { RefreshProvider } from "@/lib/refresh-context";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { ensurePushSubscription, isPushSupported, isIos, isStandalonePWA } from "@/lib/push";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Админ-панель — Qabyl" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const { user, loading, rolesLoading, isSuperAdmin, isSalonAdmin, isMaster, salonId, branchId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

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
    const subSalonId = isSuperAdmin ? null : salonId ?? null;
    const subBranchId = masterScope ? branchId ?? null : null;
    ensurePushSubscription({ salonId: subSalonId, branchId: subBranchId, skipPermissionRequest: true }).catch(() => {});
  }, [user, isSuperAdmin, isSalonAdmin, isMaster, salonId, branchId]);

  const { unreadCount } = useNotifications({ salonId, isSuperAdmin, branchId: isMaster && !isSuperAdmin && !isSalonAdmin ? branchId : null });

  // Пока сессия или роли еще не подгрузились — показываем спиннер,
  // а не экран "Нет доступа" и не редирект на /auth.
  if (loading || (user && rolesLoading)) return <FullScreenLoader />;
  if (!user) return null;

  const hasAccess = isSuperAdmin || isSalonAdmin || isMaster;

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-semibold">Нет доступа</h1>
          <p className="text-muted-foreground mt-2">Этот аккаунт не имеет прав доступа в админ-панель.</p>
          <Button className="mt-4" onClick={async () => { await signOutFromApp(); navigate({ to: "/auth", replace: true }); }}>Выйти</Button>
        </div>
      </div>
    );
  }

  const navItems = (isMaster && !isSuperAdmin && !isSalonAdmin)
    ? [
        { to: "/admin/calendar", label: "Календарь", icon: Calendar },
        { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
        { to: "/admin/account", label: "Аккаунт", icon: UserCog },
      ]
    : isSuperAdmin
    ? [
        { to: "/admin", label: "Дашборд", icon: LayoutDashboard, exact: true },
        { to: "/admin/salons", label: "Салоны", icon: Building2 },
        { to: "/admin/calendar", label: "Календарь", icon: Calendar },
        { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
        { to: "/admin/stats", label: "Статистика", icon: BarChart3 },
        { to: "/admin/account", label: "Аккаунт", icon: UserCog },
      ]
    : [
        { to: "/admin", label: "Дашборд", icon: LayoutDashboard, exact: true },
        { to: "/admin/calendar", label: "Календарь", icon: Calendar },
        { to: "/admin/notifications", label: "Уведомления", icon: Bell, badge: unreadCount },
        { to: "/admin/stats", label: "Статистика", icon: BarChart3 },
        ...(salonId ? [{ to: `/admin/salons/${salonId}`, label: "Мой салон", icon: Settings }] : []),
        { to: "/admin/account", label: "Аккаунт", icon: UserCog },
      ];

  const roleLabel = isSuperAdmin ? "Админ-панель" : isSalonAdmin ? "Кабинет салона" : "Кабинет мастера";

  const SidebarContent = (
    <>
      <div className="p-6 border-b">
        <h1 className="font-bold">Qabyl</h1>
        <p className="text-xs text-muted-foreground">{roleLabel}</p>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const active = item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to);
          const badge = (item as any).badge as number | undefined;
          return (
            <Link key={item.to} to={item.to as any} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
              <item.icon className="h-4 w-4" /><span className="flex-1">{item.label}</span>
              {badge ? (
                <span className={`text-[10px] min-w-5 h-5 px-1.5 rounded-full flex items-center justify-center ${active ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground"}`}>
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t">
        <Button variant="ghost" className="w-full justify-start" onClick={async () => { await signOutFromApp(); navigate({ to: "/auth", replace: true }); }}>
          <LogOut className="h-4 w-4 mr-2" />Выйти
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
        <header className="md:hidden h-14 border-b bg-card flex items-center justify-between px-4 sticky top-0 z-30">
          <div className="font-bold">Qabyl</div>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon"><Menu className="h-5 w-5" /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0 flex flex-col">
              {SidebarContent}
            </SheetContent>
          </Sheet>
        </header>
        <RefreshProvider>
          <PullToRefresh className="flex-1 overflow-auto relative">
            <Outlet />
          </PullToRefresh>
        </RefreshProvider>
      </div>
    </div>
  );
}
