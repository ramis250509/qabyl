// Первый экран после входа.
//
// НА КАКОЙ ВОПРОС ОТВЕЧАЕТ. «Всё ли работает и нужно ли от меня что-то прямо сейчас». Прежняя
// версия показывала четыре числа и «Быстрый старт», который до сих пор советовал добавить
// «GreenAPI ключи» — транспорт, удалённый из кода месяц назад. По этому экрану нельзя было
// понять ни того, отвечает ли ассистент клиентам, ни того, что подключение сломалось.
//
// ПОРЯДОК БЛОКОВ — это порядок важности, а не порядок написания:
//   1. Состояние канала. Сломанный WhatsApp означает, что клиенты остаются без ответа прямо
//      сейчас; всё остальное на этом фоне не имеет значения.
//   2. Что осталось настроить. Исчезает, когда настроено.
//   3. Числа. Они интересны тому, у кого уже всё работает.
//
// СУПЕР-АДМИН ВИДИТ ДРУГОЕ. У него нет «своего» салона: фильтр стоит на «все», и говорить
// «ваш WhatsApp не подключён» про семь салонов разом бессмысленно. Ему остаются числа и выбор
// салона; состояние канала появляется, когда он выбрал конкретный.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Building2,
  Calendar,
  Copy,
  ExternalLink,
  MessageCircle,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useAdminFilters } from "@/hooks/use-branch-filter";
import { BranchFilterBar } from "@/components/admin/BranchFilterBar";
import { useAuth } from "@/lib/auth-client";
import { useSalonTimezone, startOfDayInTz, addDaysInTz, dayKeyInTz } from "@/lib/tz";
import { useRegisterRefresh } from "@/lib/refresh-context";
import { getOnboardingProgress } from "@/lib/onboarding.functions";
import { SetupChecklist } from "@/components/admin/SetupChecklist";
import { EmptyState, SkeletonBlock, StatusBadge, StatusPanel } from "@/components/ui/status";

export const Route = createFileRoute("/admin/")({
  component: Dashboard,
});

type Progress = Awaited<ReturnType<typeof getOnboardingProgress>>;

/**
 * Три канала связи с клиентом одной строкой.
 *
 * Это не дубликат вкладки WhatsApp: там владелец чинит, здесь — узнаёт. Каждая плашка ведёт
 * туда, где чинят, и ни одна не объясняет причину: причина живёт в одном месте, иначе они
 * разъедутся.
 */
function ChannelStrip({ progress, salonId }: { progress: Progress; salonId: string }) {
  const settings = `/admin/salons/${salonId}`;
  const items = [
    {
      label: "WhatsApp",
      tab: "channels",
      tone: progress.whatsapp.level,
      text: progress.whatsapp.connected
        ? progress.whatsapp.level === "ok"
          ? "работает"
          : "требует внимания"
        : "не подключён",
    },
    {
      label: "Ассистент",
      tab: "ai",
      tone: progress.assistantEnabled ? ("ok" as const) : ("idle" as const),
      text: progress.assistantEnabled ? "отвечает клиентам" : "выключен",
    },
    {
      label: "Страница записи",
      tab: "site",
      // Страница есть всегда, но записываться на ней не на что, пока нет услуги и мастера с
      // графиком. Говорить «работает» в этом состоянии — врать.
      tone:
        progress.servicesCount > 0 && progress.bookableMastersCount > 0
          ? ("ok" as const)
          : ("warn" as const),
      text:
        progress.servicesCount > 0 && progress.bookableMastersCount > 0
          ? "принимает записи"
          : "нечего показать клиенту",
    },
  ];

  return (
    <div className="qb-stagger grid gap-3 sm:grid-cols-3">
      {items.map((it) => (
        <Link
          key={it.label}
          to={settings as any}
          search={{ tab: it.tab } as any}
          className="qb-card-interactive rounded-xl border bg-card p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{it.label}</span>
            <StatusBadge tone={it.tone}>{it.text}</StatusBadge>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** Ссылка для клиентов. Единственное, что владелец из этого экрана реально куда-то копирует. */
function ShareRow({ slug }: { slug: string }) {
  const url = typeof window !== "undefined" ? `${window.location.origin}/book/${slug}` : "";
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Ссылка скопирована");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Ссылка для клиентов:</span>
      <code className="truncate rounded bg-muted px-2 py-1 text-xs">{url}</code>
      <Button variant="ghost" size="icon" onClick={copy} aria-label="Скопировать ссылку">
        <Copy className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" asChild aria-label="Открыть страницу записи">
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}

function Dashboard() {
  const { isSuperAdmin } = useAuth();
  const filters = useAdminFilters();
  const { salonId, branchId } = filters;
  const tz = useSalonTimezone(salonId !== "all" ? salonId : null);
  const loadProgress = useServerFn(getOnboardingProgress);

  const [stats, setStats] = useState({ salons: 0, masters: 0, today: 0, week: 0, chats: 0 });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [progressLoading, setProgressLoading] = useState(true);

  const load = useCallback(async () => {
    const now = new Date();
    const startToday = startOfDayInTz(now, tz).toISOString();
    const endToday = addDaysInTz(now, 1, tz).toISOString();
    const weekEnd = addDaysInTz(now, 7, tz).toISOString();
    const weekAgo = addDaysInTz(now, -7, tz).toISOString();
    const nowIso = now.toISOString();

    function applySalon<T extends { eq: (c: string, v: string) => T }>(q: T): T {
      return salonId !== "all" ? q.eq("salon_id", salonId) : q;
    }
    function applyBranch<T extends { eq: (c: string, v: string) => T }>(q: T): T {
      return branchId !== "all" ? q.eq("branch_id", branchId) : q;
    }

    // GET + count (limit 1), не HEAD count: на бесплатном тарифе аутентифицированный HEAD count
    // периодически отвечает 503 под всплеском запросов этой страницы. GET работает, limit 1
    // держит его дешёвым.
    const salonsQ = isSuperAdmin
      ? supabase.from("salons").select("id", { count: "exact" }).limit(1)
      : Promise.resolve({ count: filters.salons.length });
    // Мастера фильтруются НЕ через applyBranch. В схеме Qabyl branch_id = NULL означает
    // «работает во всех филиалах», и .eq() молча выбрасывает таких — счётчик показывал бы меньше
    // мастеров, чем есть. Тем же способом в июле 2026 сломался виджет записи целиком.
    const mastersBase = applySalon(
      supabase.from("masters").select("id", { count: "exact" }).eq("is_active", true).limit(1),
    );
    const mastersQ =
      branchId !== "all"
        ? mastersBase.or(`branch_id.is.null,branch_id.eq.${branchId}`)
        : mastersBase;
    const todayQ = applyBranch(
      applySalon(
        supabase
          .from("appointments")
          .select("id", { count: "exact" })
          .eq("status", "confirmed")
          .gte("starts_at", startToday)
          .lt("starts_at", endToday)
          .limit(1),
      ),
    );
    const weekQ = applyBranch(
      applySalon(
        supabase
          .from("appointments")
          .select("id", { count: "exact" })
          .eq("status", "confirmed")
          .gte("starts_at", nowIso)
          .lt("starts_at", weekEnd)
          .limit(1),
      ),
    );
    // Сколько людей написало за неделю. Число, которого на этом экране не хватало больше всего:
    // записи показывают результат, а диалоги — поток, из которого он берётся.
    const chatsQ = applySalon(
      supabase
        .from("wa_conversations")
        .select("id", { count: "exact" })
        .gte("last_message_at", weekAgo)
        .limit(1),
    );

    const [s, m, today, week, chats] = await Promise.all([
      salonsQ,
      mastersQ,
      todayQ,
      weekQ,
      chatsQ,
    ]);
    setStats({
      salons: (s as any).count ?? 0,
      masters: m.count ?? 0,
      today: today.count ?? 0,
      week: week.count ?? 0,
      chats: (chats as any).count ?? 0,
    });
  }, [salonId, branchId, isSuperAdmin, filters.salons.length, tz]);

  useEffect(() => {
    load();
  }, [load]);
  useRegisterRefresh(load);

  // Состояние салона — только когда салон один и конкретный. «Все салоны» суммарного состояния
  // не имеют, и показывать там что-то среднее значит вводить в заблуждение.
  useEffect(() => {
    let cancelled = false;
    if (salonId === "all") {
      setProgress(null);
      setProgressLoading(false);
      return;
    }
    setProgressLoading(true);
    loadProgress({ data: { salonId } })
      .then((p) => {
        if (!cancelled) setProgress(p);
      })
      .catch(() => {
        // Не показываем ошибку: состояние канала — вспомогательный блок, и падать из-за него
        // всему дашборду незачем. Владелец увидит причину на вкладке WhatsApp.
        if (!cancelled) setProgress(null);
      })
      .finally(() => {
        if (!cancelled) setProgressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [salonId, loadProgress]);

  // Каждая карточка — кнопка, а не число.
  //
  // ЗАЧЕМ. «4 записи сегодня» — это не ответ, а начало вопроса: какие именно? Раньше владелец
  // читал число, шёл в календарь и заново выбирал сегодняшний день — то есть делал руками ровно
  // то, что уже сообщила карточка. Каждая ведёт туда, где лежит её содержимое, и приводит уже с
  // нужным фильтром.
  //
  // Карточка без осмысленного адреса остаётся просто карточкой: ложная кликабельность хуже
  // честной статики.
  const settings = salonId !== "all" ? `/admin/salons/${salonId}` : null;
  const todayKey = dayKeyInTz(new Date(), tz);
  const cards: {
    label: string;
    value: number;
    icon: typeof Calendar;
    tone: string;
    to?: string;
    search?: Record<string, string>;
    hint?: string;
  }[] = [
    ...(isSuperAdmin
      ? [
          {
            label: "Салонов",
            value: stats.salons,
            icon: Building2,
            tone: "text-info",
            to: "/admin/salons",
            hint: "Все салоны платформы",
          },
        ]
      : []),
    {
      label: "Записей сегодня",
      value: stats.today,
      icon: Calendar,
      tone: "text-success",
      to: "/admin/calendar",
      search: { view: "day", date: todayKey },
      hint: "Открыть календарь на сегодня",
    },
    {
      label: "Записей за 7 дней",
      value: stats.week,
      icon: TrendingUp,
      tone: "text-warning",
      to: "/admin/calendar",
      search: { view: "week", date: todayKey },
      hint: "Открыть календарь на неделю",
    },
    {
      label: "Диалогов за неделю",
      value: stats.chats,
      icon: MessageCircle,
      tone: "text-info",
      ...(settings ? { to: settings, search: { tab: "chats" }, hint: "Открыть переписки" } : {}),
    },
    {
      label: "Мастеров",
      value: stats.masters,
      icon: Users,
      tone: "text-muted-foreground",
      ...(settings ? { to: settings, search: { tab: "masters" }, hint: "Открыть список мастеров" } : {}),
    },
  ];

  const brokenChannel =
    progress && progress.whatsapp.connected && progress.whatsapp.level === "error";

  return (
    <div className="space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {progress?.salonName || "Дашборд"}
        </h1>
        <p className="text-muted-foreground">
          {progress ? "Как идут дела прямо сейчас" : "Обзор ваших салонов"}
        </p>
      </div>

      <BranchFilterBar filters={filters} />

      {/* Поломка канала — единственное, ради чего этот экран может кричать. Всё остальное ждёт. */}
      {brokenChannel && progress && (
        <StatusPanel
          tone="error"
          title={progress.whatsapp.title}
          body={progress.whatsapp.body}
          actions={[
            {
              label: "Открыть настройки WhatsApp",
              onClick: () => {
                window.location.href = `/admin/salons/${salonId}?tab=channels`;
              },
            },
          ]}
        />
      )}

      {salonId !== "all" &&
        (progressLoading ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <SkeletonBlock className="h-16" />
            <SkeletonBlock className="h-16" />
            <SkeletonBlock className="h-16" />
          </div>
        ) : progress ? (
          <ChannelStrip progress={progress} salonId={salonId} />
        ) : null)}

      {progress && salonId !== "all" && <SetupChecklist progress={progress} salonId={salonId} />}

      <div className="qb-stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => {
          const body = (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-muted-foreground">{c.label}</p>
                <p className="mt-1 text-3xl font-bold tabular-nums">{c.value}</p>
              </div>
              <c.icon className={`h-6 w-6 shrink-0 ${c.tone}`} />
            </div>
          );
          if (!c.to) {
            return (
              <Card key={c.label} className="p-5">
                {body}
              </Card>
            );
          }
          return (
            <Link
              key={c.label}
              to={c.to as any}
              search={(c.search ?? {}) as any}
              aria-label={c.hint ?? c.label}
              title={c.hint}
              className="qb-card-interactive rounded-xl border bg-card p-5 text-card-foreground shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {body}
            </Link>
          );
        })}
      </div>

      {/* Пустое место должно помогать, а не констатировать. Ноль записей у настроенного салона
          означает ровно одно: клиенты ещё не знают ссылку. */}
      {progress && progress.appointmentsCount === 0 && progress.servicesCount > 0 && (
        <Card className="p-0">
          <EmptyState
            icon={Sparkles}
            title="Записей пока нет"
            body="Отправьте ссылку клиентам, поставьте её в шапку Instagram или в статус WhatsApp — записи придут сюда сами."
          />
          {progress.slug && (
            <div className="border-t p-5">
              <ShareRow slug={progress.slug} />
            </div>
          )}
        </Card>
      )}

      {progress && progress.appointmentsCount > 0 && progress.slug && (
        <Card className="p-5">
          <ShareRow slug={progress.slug} />
        </Card>
      )}
    </div>
  );
}
