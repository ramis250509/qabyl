// Короткая экскурсия по кабинету — один раз, сразу после настройки.
//
// ЗАЧЕМ. Человек выходит из мастера настройки в кабинет с семью пунктами меню и не знает, куда
// смотреть первым. Обычный ответ на это — «позвонить Рамису». Экскурсия отвечает на тот же вопрос
// за сорок секунд и ровно один раз.
//
// ЧЕГО ОНА НЕ ДЕЛАЕТ. Не учит пользоваться: у каждого шага одна фраза, а не инструкция. Не
// повторяется: пройденную или пропущенную больше не показываем никогда. Не держит в заложниках —
// «Пропустить» видно на каждом шаге.
//
// ПОЧЕМУ ОНА ХОДИТ ПО КАБИНЕТУ, А НЕ РИСУЕТ КАРТИНКИ. Подсветить пункт меню и объяснить, что за
// ним, — это описание. Привести туда и показать настоящий экран — это память. Поэтому шаги умеют
// переходить по адресам и ждать появления цели.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

const DONE_KEY = "qb_tour_done_v1";
const PENDING_KEY = "qb_tour_pending_v1";

export function markTourPending() {
  try {
    localStorage.setItem(PENDING_KEY, "1");
  } catch {
    /* приватный режим — экскурсии просто не будет */
  }
}

export function isTourDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true;
  }
}

function consumePending(): boolean {
  try {
    if (localStorage.getItem(PENDING_KEY) !== "1") return false;
    localStorage.removeItem(PENDING_KEY);
    return true;
  } catch {
    return false;
  }
}

export function resetTour() {
  try {
    localStorage.removeItem(DONE_KEY);
    localStorage.setItem(PENDING_KEY, "1");
  } catch {
    /* пусто */
  }
}

export type TourStep = {
  /** Значение атрибута data-tour у элемента, который подсвечиваем. */
  target: string;
  title: string;
  body: string;
  /** Куда перейти перед шагом. Если уже там — перехода не будет. */
  to?: string;
  search?: Record<string, string>;
};

/** Шаги для владельца салона. Шесть — предел: седьмой уже никто не читает. */
export function ownerTourSteps(salonId: string | null): TourStep[] {
  const settings = salonId ? `/admin/salons/${salonId}` : null;
  return [
    {
      target: "nav-dashboard",
      to: "/admin",
      title: "Главный экран",
      body: "Здесь видно, работает ли всё: подключены ли каналы, отвечает ли ассистент, сколько записей сегодня. Если что-то сломается — узнаете отсюда.",
    },
    {
      target: "nav-calendar",
      to: "/admin/calendar",
      title: "Календарь",
      body: "Все записи — и те, что создал ассистент, и те, что вы добавили сами. Записи можно двигать мышкой.",
    },
    ...(settings
      ? ([
          {
            target: "tab-channels",
            to: settings,
            search: { tab: "channels" },
            title: "Каналы",
            body: "Подключение WhatsApp и Instagram, и один переключатель: отвечает ассистент или отвечаете вы.",
          },
          {
            target: "tab-ai",
            to: settings,
            search: { tab: "ai" },
            title: "Ассистент",
            body: "Как он разговаривает: приветствие, тон, правила записи и то, что он знает о салоне.",
          },
          {
            target: "tab-team",
            to: settings,
            search: { tab: "team" },
            title: "Команда",
            body: "Доступы сотрудников. Администратор на ресепшене видит записи, но не видит цен и настроек.",
          },
          {
            target: "nav-settings",
            to: settings,
            title: "Настройки салона",
            body: "Услуги, мастера, графики и страница записи — всё здесь, во вкладках сверху. Это всё, спасибо!",
          },
        ] as TourStep[])
      : []),
  ];
}

type Rect = { top: number; left: number; width: number; height: number };

/** Ищем цель не один раз: после перехода экран ещё рисуется, и элемента может не быть секунду. */
function useTargetRect(target: string, tick: number): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    let tries = 0;
    let raf = 0;

    const measure = () => {
      if (cancelled) return;
      // ВСЕ элементы с этим именем, а не первый.
      //
      // Один и тот же пункт меню теперь существует дважды: в боковой панели (скрыта на
      // телефоне) и в нижней панели (скрыта на десктопе). Первый в DOM — всегда боковой, и
      // querySelector на телефоне возвращал невидимый элемент размером 0×0. Экскурсия честно
      // ждала 90 кадров и сдавалась: ни один шаг на телефоне ничего не подсвечивал.
      for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
        const r = el.getBoundingClientRect();
        // Цель может быть за краем экрана — на телефоне вкладки уезжают вбок.
        if (r.width > 0 && r.height > 0) {
          el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
          return;
        }
      }
      if (tries++ < 90) raf = requestAnimationFrame(measure);
      else setRect(null); // не нашли — шаг покажем по центру, без подсветки
    };

    setRect(null);
    measure();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [target, tick]);

  return rect;
}

export function ProductTour({
  steps,
  open,
  onClose,
}: {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [i, setI] = useState(0);
  const [tick, setTick] = useState(0);
  const startedAt = useRef(0);

  const step = steps[i];
  const rect = useTargetRect(step?.target ?? "", tick);

  // Переход к экрану шага. Отдельным эффектом, а не внутри «Далее»: шаг может быть первым.
  useEffect(() => {
    if (!open || !step?.to) return;
    if (location.pathname === step.to) return;
    navigate({ to: step.to as any, search: (step.search ?? {}) as any });
  }, [open, step?.to, step?.search, location.pathname, navigate]);

  // Пересчёт рамки при прокрутке и повороте телефона.
  useEffect(() => {
    if (!open) return;
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => {
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, [open]);

  const finish = useCallback(
    (completed: boolean) => {
      try {
        localStorage.setItem(DONE_KEY, "1");
      } catch {
        /* пусто */
      }
      void completed;
      onClose();
    },
    [onClose],
  );

  // Клавиатура: Esc закрывает, стрелки листают. Тур, из которого нельзя выйти клавишей, —
  // это не тур, а модальное окно без крестика.
  useEffect(() => {
    if (!open) return;
    startedAt.current = Date.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "ArrowRight" || e.key === "Enter") {
        setI((v) => (v + 1 >= steps.length ? (finish(true), v) : v + 1));
      }
      if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, steps.length, finish]);

  if (!open || !step) return null;

  const pad = 6;
  const hole = rect
    ? {
        top: Math.max(4, rect.top - pad),
        left: Math.max(4, rect.left - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      }
    : null;

  // Подсказка ставится под целью, а если снизу не помещается — над ней.
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const cardW = Math.min(340, vw - 24);
  const below = hole ? hole.top + hole.height + 12 : 0;
  const placeBelow = !hole || below + 190 < vh;
  const cardTop = hole ? (placeBelow ? below : Math.max(12, hole.top - 196)) : vh / 2 - 100;
  const cardLeft = hole
    ? Math.min(Math.max(12, hole.left), vw - cardW - 12)
    : Math.max(12, vw / 2 - cardW / 2);

  const last = i === steps.length - 1;

  return (
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с кабинетом"
    >
      {/* Затемнение делается тенью вокруг «окна», а не четырьмя блоками: одна коробка —
          один пересчёт раскладки, и дырка всегда ровно совпадает с целью. */}
      {hole ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary transition-all duration-300"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            boxShadow: "0 0 0 9999px rgba(2, 6, 23, 0.62)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(2,6,23,0.62)]" />
      )}

      {/* Ловим клики мимо подсказки, чтобы человек не «проваливался» в интерфейс под затемнением. */}
      <button
        type="button"
        aria-label="Пропустить знакомство"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={() => finish(false)}
      />

      <div
        className="qb-pop absolute rounded-xl border bg-card p-4 shadow-xl"
        style={{ top: cardTop, left: cardLeft, width: cardW }}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold tracking-tight">{step.title}</h3>
          <button
            type="button"
            onClick={() => finish(false)}
            aria-label="Закрыть"
            className="qb-press -mr-1 -mt-1 rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((_, n) => (
              <span
                key={n}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  n === i ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30"
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {i > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setI((v) => v - 1)}>
                Назад
              </Button>
            )}
            <Button size="sm" onClick={() => (last ? finish(true) : setI((v) => v + 1))}>
              {last ? "Понятно" : "Далее"}
            </Button>
          </div>
        </div>

        {!last && (
          <button
            type="button"
            onClick={() => finish(false)}
            className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Пропустить
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Запускать ли экскурсию прямо сейчас.
 *
 * ПОЧЕМУ ОНА ПРОПАДАЛА. Условий было два: «мастер настройки поставил отметку» И «ещё не
 * пройдена». Отметку ставила кнопка на ПОСЛЕДНЕМ шаге мастера — а до неё доходят не все:
 * кто-то закрывает мастер крестиком, кто-то жмёт «Решу позже» на тарифе и уходит в кабинет
 * сам, кто-то заводит салон и открывает /admin в другой вкладке. Все они не видели экскурсию
 * никогда, и понять это было нельзя: отметки просто не было.
 *
 * Условие теперь одно: экскурсия НЕ ПРОЙДЕНА. Отметка мастера осталась, но лишь ускоряет
 * показ — ждать её перестали. «Пройдена» ставится и при прохождении, и при пропуске, поэтому
 * второй раз она по-прежнему не появится.
 */
export function useTourAutostart(ready: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!ready || isTourDone()) return;
    // Пришли прямо из мастера настройки — показываем почти сразу. Зашли сами — даём
    // осмотреться пару секунд, чтобы экскурсия не прыгала поверх ещё пустого экрана.
    const delay = consumePending() ? 600 : 1800;
    const t = setTimeout(() => setOpen(true), delay);
    return () => clearTimeout(t);
  }, [ready]);
  return [open, () => setOpen(false)];
}
