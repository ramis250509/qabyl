// Как в Qabyl выглядит состояние. Одно место на весь продукт.
//
// ЗАЧЕМ. До этого файла каждый экран рисовал состояние по-своему: где-то
// `border-green-300 bg-green-50`, где-то `text-emerald-600`, где-то серая плашка с текстом.
// Ни один из этих вариантов не знал про тёмную тему, и одно и то же событие — «подключено» —
// выглядело на трёх вкладках тремя разными способами. Пользователь читает это как «страницы
// делали разные люди», и он прав.
//
// Здесь четыре тона и ничего больше. Новый тон не добавляется под конкретный экран: если
// состояние не укладывается в четыре, проблема в формулировке состояния, а не в палитре.
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * ok — работает; warn — работает не полностью, нужно внимание; error — не работает;
 * idle — ещё не настроено (не поломка, а пустое место).
 */
export type Tone = "ok" | "warn" | "error" | "idle";

const TONE_SURFACE: Record<Tone, string> = {
  ok: "bg-success-surface border-success-border",
  warn: "bg-warning-surface border-warning-border",
  error: "bg-danger-surface border-danger-border",
  idle: "bg-muted/40 border-border",
};

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  error: "text-danger",
  idle: "text-muted-foreground",
};

const TONE_ICON = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
  idle: Info,
} as const;

/**
 * Точка состояния. Крошечная, но несёт весь смысл в списках, где на подпись места нет.
 *
 * `pulse` включает расходящееся кольцо и означает ровно одно: «прямо сейчас идёт». Не «важно»,
 * не «ново» — иначе пульсация появится в пяти местах и перестанет что-либо значить.
 */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex h-2 w-2 shrink-0 rounded-full",
        TONE_TEXT[tone],
        pulse && "qb-ping",
        className,
      )}
      style={{ backgroundColor: "currentColor" }}
      aria-hidden
    />
  );
}

/** Компактная плашка состояния: точка + слово. Для заголовков карточек и строк таблиц. */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        TONE_SURFACE[tone],
        TONE_TEXT[tone],
        className,
      )}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

export type StatusAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  loading?: boolean;
  /** Второстепенное действие рисуется рядом и тише. */
  variant?: "primary" | "secondary";
};

/**
 * Крупный блок состояния: то, ради чего человек открыл экран.
 *
 * КОНТРАКТ. Заголовок отвечает «что сейчас», текст — «что это значит для меня», действие —
 * «что делать». Блока без действия не бывает у тонов warn и error: сообщить о поломке и не
 * сказать, что с ней делать, — это то же самое, что не сообщать.
 */
export function StatusPanel({
  tone,
  title,
  body,
  actions,
  aside,
  children,
  className,
}: {
  tone: Tone;
  title: string;
  body?: ReactNode;
  actions?: StatusAction[];
  /** Правый верхний угол — обычно время последней проверки или кнопка «обновить». */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      className={cn("qb-rise rounded-xl border p-5 sm:p-6", TONE_SURFACE[tone], className)}
      role={tone === "error" ? "alert" : undefined}
    >
      <div className="flex items-start gap-4">
        <Icon className={cn("mt-0.5 h-6 w-6 shrink-0", TONE_TEXT[tone])} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-base font-semibold tracking-tight sm:text-lg">{title}</h3>
            {aside && <div className="shrink-0 text-xs text-muted-foreground">{aside}</div>}
          </div>
          {body && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>}
          {children}
          {actions && actions.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {actions.map((a) => {
                const variant = a.variant === "secondary" ? "outline" : "default";
                if (a.href) {
                  return (
                    <Button key={a.label} asChild variant={variant} size="sm">
                      <a href={a.href} target="_blank" rel="noreferrer">
                        {a.label}
                      </a>
                    </Button>
                  );
                }
                return (
                  <Button
                    key={a.label}
                    variant={variant}
                    size="sm"
                    onClick={a.onClick}
                    disabled={a.loading}
                  >
                    {a.loading ? "Подождите…" : a.label}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Пустое место, которое помогает сделать следующий шаг.
 *
 * «Ничего нет» — это не сообщение, а тупик. Пустой экран обязан назвать, что здесь появится,
 * зачем это нужно и какой кнопкой это начать.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  body?: ReactNode;
  action?: StatusAction;
  className?: string;
}) {
  return (
    <div className={cn("qb-fade flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {body && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>
      )}
      {action && (
        <Button
          className="mt-5"
          size="sm"
          onClick={action.onClick}
          disabled={action.loading}
          {...(action.href ? { asChild: true } : {})}
        >
          {action.href ? (
            <a href={action.href} target="_blank" rel="noreferrer">
              {action.label}
            </a>
          ) : action.loading ? (
            "Подождите…"
          ) : (
            action.label
          )}
        </Button>
      )}
    </div>
  );
}

export type StepState = "done" | "active" | "failed" | "pending";

/**
 * Ход длинного процесса.
 *
 * Существует ради подключения WhatsApp: там девять запросов в Meta подряд, и без списка шагов
 * владелец видит крутящуюся кнопку двадцать секунд и не знает, зависло или идёт. «Активный»
 * шаг пульсирует — это единственное место в продукте, где пульсация уместна.
 */
export function Stepper({
  steps,
  className,
}: {
  steps: { label: string; state: StepState; detail?: string | null }[];
  className?: string;
}) {
  return (
    <ol className={cn("space-y-2.5", className)}>
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className="flex items-start gap-3 text-sm">
          <span className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center">
            {s.state === "done" && <CheckCircle2 className="h-4 w-4 text-success" />}
            {s.state === "failed" && <XCircle className="h-4 w-4 text-danger" />}
            {s.state === "active" && <StatusDot tone="warn" pulse />}
            {s.state === "pending" && (
              <span className="h-2 w-2 rounded-full border border-muted-foreground/40" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                s.state === "pending" && "text-muted-foreground",
                s.state === "failed" && "text-danger",
              )}
            >
              {s.label}
            </span>
            {s.detail && (
              <span className="mt-0.5 block text-xs text-muted-foreground">{s.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Прямоугольник-заглушка на время загрузки. Держит раскладку, чтобы экран не прыгал. */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("qb-skeleton rounded-md bg-muted", className)} aria-hidden />;
}
