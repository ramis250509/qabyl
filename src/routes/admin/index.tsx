// Первый экран после входа.
//
// НА КАКОЙ ВОПРОС ОТВЕЧАЕТ. «Что у меня сегодня и всё ли работает». Он называется «Сегодня», а
// не «Дашборд», потому что так его и открывают: на минуту, между клиентами, чтобы посмотреть
// день. «Дашборд» — слово из другого продукта, и владелице салона оно не говорит ничего.
//
// ЧТО БЫЛО НЕ ТАК. Экран складывал шесть блоков в столбик: заголовок, фильтр филиала, красная
// плашка, полоса из трёх каналов, чек-лист «Осталось немного», четыре числа и ссылка. Первые
// три экрана телефона занимало то, что ЧЕГО-ТО ПРОСИТ, а ответ на вопрос «что у меня сегодня»
// не помещался вовсе — за ним приходилось идти в «Календарь».
//
// ПОРЯДОК ТЕПЕРЬ ТАКОЙ:
//   1. Ответ. Числа дня и список сегодняшних записей — то, за чем пришли.
//   2. Поломка. Только настоящая и только та, которую этот человек может починить.
//   3. Просьбы. Чек-лист настройки — ниже ответа, а не вместо него.
//
// СОСТОЯНИЕ КАНАЛОВ СВЕРНУТО В ОДНУ СТРОКУ. Три карточки-плашки занимали высоту, равную всему
// списку записей, и повторяли то, что подробнее написано во вкладке «Каналы». Вместо них —
// одна подпись у заголовка, называющая САМОЕ ПЛОХОЕ из трёх состояний. Подробности живут в
// одном месте, иначе они разъезжаются.
//
// СУПЕР-АДМИН ВИДИТ ДРУГОЕ. У него нет «своего» салона: фильтр стоит на «все», и говорить
// «ваш WhatsApp не подключён» про семь салонов разом бессмысленно. Ему остаются числа и выбор
// салона; состояние и день появляются, когда он выбрал конкретный.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Building2,
  Calendar,
  ChevronRight,
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
import { useSalonTimezone, startOfDayInTz, addDaysInTz, dayKeyInTz, formatInTz } from "@/lib/tz";
import { useRegisterRefresh } from "@/lib/refresh-context";
import { getOnboardingProgress } from "@/lib/onboarding.functions";
import { SetupChecklist } from "@/components/admin/SetupChecklist";
import { EmptyState, SkeletonBlock, StatusBadge, StatusPanel } from "@/components/ui/status";
import { waStatusForViewer } from "@/lib/wa-status-view";

export const Route = createFileRoute("/admin/")({
  component: Dashboard,
});

type Progress = Awaited<ReturnType<typeof getOnboardingProgress>>;

type TodayAppt = {
  id: string;
  starts_at: string;
  client_name: string | null;
  status: string;
  masters: { name: string } | null;
  services: { name: string; color: string | null } | null;
};

/**
 * Состояние салона одной строкой.
 *
 * Называет худшее из трёх — канал, ассистент, страница записи. Не «есть проблемы», а какая
 * именно: «ассистент выключен» ведёт к выключателю, «есть проблемы» не ведёт никуда.
 */
function healthLine(
  progress: Progress,
  isSuperAdmin: boolean,
): { tone: "ok" | "warn" | "error" | "idle"; text: string; tab: string } {
  const wa = waStatusForViewer(progress.whatsapp, isSuperAdmin);
  if (!wa.connected) return { tone: "idle", text: "WhatsApp не подключён", tab: "channels" };
  if (wa.level === "error") return { tone: "error", text: "WhatsApp не работает", tab: "channels" };
  if (progress.servicesCount === 0 || progress.bookableMastersCount === 0) {
    return { tone: "warn", text: "записываться пока не на что", tab: "services" };
  }
  if (!progress.assistantEnabled) {
    return { tone: "warn", text: "ассистент выключен", tab: "channels" };
  }
  if (wa.level !== "ok")
    return { tone: "warn", text: "WhatsApp требует внимания", tab: "channels" };
  return { tone: "ok", text: "всё работает", tab: "channels" };
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

/**
 * День списком.
 *
 * То, ради чего этот экран вообще открывают, и чего на нём раньше не было: число «4 записи»
 * сообщало, что день не пустой, но не отвечало, чем именно он занят — за этим приходилось идти
 * в календарь и заново выбирать сегодняшнее число.
 */
function TodayList({
  items,
  loading,
  tz,
  todayKey,
}: {
  items: TodayAppt[];
  loading: boolean;
  tz: string;
  todayKey: string;
}) {
  if (loading) {
    return (
      <Card className="p-0">
        <div className="space-y-3 p-4 sm:p-5">
          <SkeletonBlock className="h-5 w-full" />
          <SkeletonBlock className="h-5 w-5/6" />
          <SkeletonBlock className="h-5 w-4/6" />
        </div>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="p-0">
        <EmptyState
          icon={Calendar}
          title="На сегодня записей нет"
          body="Как только клиент запишется — через WhatsApp или на странице записи — он появится здесь."
        />
      </Card>
    );
  }

  const now = Date.now();

  return (
    <Card className="overflow-hidden p-0">
      <ul className="divide-y">
        {items.map((a) => {
          const past = new Date(a.starts_at).getTime() < now;
          return (
            <li key={a.id}>
              <Link
                to="/admin/calendar"
                search={{ view: "day", date: todayKey } as never}
                className="qb-press flex items-center gap-3 px-4 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
              >
                {/* Цвет услуги — тот же, что в календаре: запись должна узнаваться одинаково
                    на обоих экранах. Полоска, а не точка: она задаёт ритм списку. */}
                <span
                  aria-hidden
                  className="h-8 w-1 shrink-0 rounded-full"
                  style={{ background: a.services?.color || "var(--color-primary)" }}
                />
                <time
                  dateTime={a.starts_at}
                  className={`w-12 shrink-0 text-sm font-medium ${past ? "text-muted-foreground" : ""}`}
                >
                  {formatInTz(a.starts_at, tz, { hour: "2-digit", minute: "2-digit" })}
                </time>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {a.client_name || "Без имени"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[a.services?.name, a.masters?.name].filter(Boolean).join(" · ") || "Услуга"}
                  </span>
                </span>
                {a.status === "no_show" && (
                  <StatusBadge tone="warn" className="hidden sm:inline-flex">
                    не пришёл
                  </StatusBadge>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
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
  const [todayList, setTodayList] = useState<TodayAppt[]>([]);
  const [todayLoading, setTodayLoading] = useState(true);

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
      salons: (s as { count?: number }).count ?? 0,
      masters: m.count ?? 0,
      today: today.count ?? 0,
      week: week.count ?? 0,
      chats: (chats as { count?: number }).count ?? 0,
    });
  }, [salonId, branchId, isSuperAdmin, filters.salons.length, tz]);

  // Сам день. Отдельным запросом и отдельным состоянием: он нужен только когда салон выбран,
  // и не должен задерживать числа наверху.
  const loadToday = useCallback(async () => {
    if (salonId === "all") {
      setTodayList([]);
      setTodayLoading(false);
      return;
    }
    setTodayLoading(true);
    const start = startOfDayInTz(new Date(), tz).toISOString();
    const end = addDaysInTz(new Date(), 1, tz).toISOString();
    let q = supabase
      .from("appointments")
      .select("id, starts_at, client_name, status, masters(name), services(name, color)")
      .eq("salon_id", salonId)
      // Отменённые не показываем: день — это то, что состоится, а не то, что отменили.
      .in("status", ["confirmed", "no_show", "completed"])
      .gte("starts_at", start)
      .lt("starts_at", end)
      .order("starts_at")
      .limit(20);
    if (branchId !== "all") q = q.eq("branch_id", branchId);
    const { data } = await q;
    setTodayList((data ?? []) as unknown as TodayAppt[]);
    setTodayLoading(false);
  }, [salonId, branchId, tz]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadToday()]);
  }, [load, loadToday]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);
  useRegisterRefresh(refreshAll);

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
      tone: "text-primary",
      to: "/admin/calendar",
      search: { view: "day", date: todayKey },
      hint: "Открыть календарь на сегодня",
    },
    {
      label: "Записей за 7 дней",
      value: stats.week,
      icon: TrendingUp,
      tone: "text-success",
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
      ...(settings
        ? { to: settings, search: { tab: "masters" }, hint: "Открыть список мастеров" }
        : {}),
    },
  ];

  // Состояние канала глазами того, кто смотрит. Платформенная поломка (оплата сообщений на
  // кредитной линии Qabyl) для владелицы салона превращается в «заканчиваем настройку» и теряет
  // тон error — то есть перестаёт занимать первый экран кабинета. Супер-админ видит её как есть:
  // он единственный, кто может её закрыть.
  const waStatus = progress ? waStatusForViewer(progress.whatsapp, isSuperAdmin) : null;
  const brokenChannel = waStatus && waStatus.connected && waStatus.level === "error";
  const health = progress ? healthLine(progress, isSuperAdmin) : null;

  return (
    <div className="space-y-5 p-4 sm:space-y-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {salonId !== "all" ? "Сегодня" : "Обзор"}
          </h1>
          <p className="text-sm text-muted-foreground first-letter:uppercase">
            {salonId !== "all"
              ? formatInTz(new Date(), tz, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })
              : "Все салоны платформы"}
          </p>
        </div>
        {/* Состояние салона одной подписью, а не тремя карточками. Ведёт туда, где чинят. */}
        {health && settings && !progressLoading && (
          <Link
            to={settings as never}
            search={{ tab: health.tab } as never}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Состояние салона: ${health.text}`}
          >
            <StatusBadge tone={health.tone}>{health.text}</StatusBadge>
          </Link>
        )}
      </div>

      <BranchFilterBar filters={filters} />

      {/* Поломка канала — единственное, ради чего этот экран может кричать. Всё остальное ждёт. */}
      {brokenChannel && waStatus && (
        <StatusPanel
          tone="error"
          title={waStatus.title}
          body={waStatus.body}
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

      <div className="qb-stagger grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {cards.map((c) => {
          const body = (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground sm:text-sm">{c.label}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums sm:text-3xl">{c.value}</p>
              </div>
              <c.icon className={`h-5 w-5 shrink-0 sm:h-6 sm:w-6 ${c.tone}`} />
            </div>
          );
          if (!c.to) {
            return (
              <Card key={c.label} className="p-4 sm:p-5">
                {body}
              </Card>
            );
          }
          return (
            <Link
              key={c.label}
              to={c.to as never}
              search={(c.search ?? {}) as never}
              aria-label={c.hint ?? c.label}
              title={c.hint}
              className="qb-card-interactive rounded-xl border bg-card p-4 text-card-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5"
            >
              {body}
            </Link>
          );
        })}
      </div>

      {/* День. Главное содержимое экрана и причина, по которой он называется «Сегодня». */}
      {salonId !== "all" && (
        <TodayList items={todayList} loading={todayLoading} tz={tz} todayKey={todayKey} />
      )}

      {/* Просьбы — ниже ответа. Чек-лист исчезает сам, когда настроено. */}
      {progress && salonId !== "all" && <SetupChecklist progress={progress} salonId={salonId} />}

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
        <Card className="p-4 sm:p-5">
          <ShareRow slug={progress.slug} />
        </Card>
      )}
    </div>
  );
}
