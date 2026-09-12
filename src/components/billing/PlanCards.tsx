// Карточки тарифов — одни и те же в мастере настройки и на экране «Тариф и оплата».
//
// Что входит в тариф, берётся из данных тарифа (describePlan на сервере), а не пишется здесь:
// иначе после смены лимита в базе карточки продолжат обещать старое.
//
// ЧТО ИЗМЕНИЛОСЬ ПЕРЕД ЗАПУСКОМ.
//
// 1. Нажимается вся карточка, а не только кнопка внизу. Люди тыкают в карточку — это и есть
//    естественный жест выбора; кнопка внизу остаётся, но теперь она подтверждает уже сделанный
//    выбор, а не является единственным способом его сделать.
//
// 2. Бесплатный период выделен. «30 дней бесплатно» — главный аргумент на этом экране и главная
//    причина дойти до конца настройки, а он был написан самым мелким серым шрифтом под ценой.
//    Теперь это плашка рядом с ценой.
//
// 3. На телефоне карточки компактные. Полный список из восьми пунктов на каждой из трёх карточек
//    — это три экрана прокрутки, на которых человек теряет и цену, и кнопку. На узком экране
//    видны первые три отличия, остальное раскрывается по «показать всё».
//
// 4. Отличия видны сразу. Первые строки описания — это лимиты (сообщения, каналы, точки), то
//    есть ровно то, чем тарифы различаются; общие для всех возможности уехали вниз.
import { useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber, plural } from "@/lib/billing-logic";

export type PlanCardData = {
  code: string;
  name: string;
  tagline: string | null;
  price_kgs: number;
  trial_days: number;
  is_featured: boolean;
  pack_messages: number;
  pack_price_kgs: number;
  lines: string[];
};

/** Сколько отличий показывать на телефоне до «показать всё». */
const MOBILE_PREVIEW = 3;

export function PlanCards({
  plans,
  currentCode,
  selectedCode,
  pendingCode,
  busyCode,
  disabled,
  onChoose,
  mode = "billing",
}: {
  plans: PlanCardData[];
  currentCode?: string | null;
  /** Отмеченный, но ещё не подтверждённый тариф. Используется в мастере настройки. */
  selectedCode?: string | null;
  pendingCode?: string | null;
  busyCode?: string | null;
  disabled?: boolean;
  onChoose: (plan: PlanCardData) => void;
  mode?: "billing" | "onboarding";
}) {
  return (
    <div className="grid items-stretch gap-3 pt-3 sm:gap-4 md:grid-cols-3">
      {plans.map((p) => (
        <PlanCard
          key={p.code}
          plan={p}
          mode={mode}
          isCurrent={p.code === currentCode}
          isSelected={mode === "onboarding" ? p.code === selectedCode : p.code === currentCode}
          isPending={p.code === pendingCode}
          busy={busyCode === p.code}
          disabled={disabled}
          onChoose={onChoose}
        />
      ))}
    </div>
  );
}

function PlanCard({
  plan: p,
  mode,
  isCurrent,
  isSelected,
  isPending,
  busy,
  disabled,
  onChoose,
}: {
  plan: PlanCardData;
  mode: "billing" | "onboarding";
  isCurrent: boolean;
  isSelected: boolean;
  isPending: boolean;
  busy: boolean;
  disabled?: boolean;
  onChoose: (plan: PlanCardData) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const trial = `${p.trial_days} ${plural(p.trial_days, "день", "дня", "дней")} бесплатно`;
  const label =
    mode === "onboarding"
      ? isSelected
        ? "Выбран"
        : "Выбрать"
      : isCurrent
        ? "Ваш тариф"
        : isPending
          ? "Со следующего месяца"
          : "Выбрать";

  // На экране оплаты по текущему тарифу нажимать бессмысленно — он уже ваш.
  const clickable = !disabled && !(mode === "billing" && (isCurrent || isPending));
  const hidden = Math.max(0, p.lines.length - MOBILE_PREVIEW);

  return (
    <div
      role={clickable ? "radio" : undefined}
      aria-checked={clickable ? isSelected : undefined}
      tabIndex={clickable ? 0 : -1}
      onClick={() => clickable && onChoose(p)}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose(p);
        }
      }}
      className={`relative flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-all duration-200 sm:gap-4 sm:p-5 ${
        clickable ? "qb-card-interactive" : ""
      } ${
        isSelected
          ? "border-primary ring-2 ring-primary"
          : p.is_featured
            ? "ring-1 ring-primary/30"
            : ""
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {p.is_featured && !isSelected && (
        <span className="absolute -top-2.5 left-4 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground">
          Самый популярный
        </span>
      )}
      {isSelected && mode === "onboarding" && (
        <span className="absolute -top-2.5 left-4 flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground">
          <Check className="h-3 w-3" />
          Выбран
        </span>
      )}

      <div className="space-y-0.5">
        <h3 className="text-base font-semibold sm:text-lg">{p.name}</h3>
        {p.tagline && <p className="text-xs text-muted-foreground sm:text-sm">{p.tagline}</p>}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
        <span className="text-2xl font-bold tabular-nums sm:text-3xl">
          {formatNumber(p.price_kgs)}
        </span>
        <span className="text-sm text-muted-foreground">сом/мес</span>
        {/* Главный аргумент экрана. Раньше он был серой строчкой в 11 пикселей под ценой. */}
        <span className="rounded-full border border-success-border bg-success-surface px-2 py-0.5 text-xs font-semibold text-success">
          {trial}
        </span>
      </div>

      <ul className="flex-1 space-y-1.5 text-sm">
        {p.lines.map((line, i) => (
          <li
            key={line}
            className={`flex gap-2 ${i >= MOBILE_PREVIEW && !expanded ? "hidden md:flex" : ""}`}
          >
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <span>{line}</span>
          </li>
        ))}
        <li className="hidden gap-2 text-muted-foreground md:flex">
          <Check className="mt-0.5 h-4 w-4 shrink-0 opacity-0" aria-hidden />
          <span>
            Пакет +{formatNumber(p.pack_messages)} сообщений — {formatNumber(p.pack_price_kgs)} сом
          </span>
        </li>
      </ul>

      {hidden > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="qb-press -mt-1 flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground md:hidden"
        >
          {expanded ? "Свернуть" : `Ещё ${hidden}`}
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      )}

      <Button
        variant={isSelected ? "default" : "outline"}
        className="w-full"
        disabled={disabled || (mode === "billing" && (isCurrent || isPending))}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onChoose(p);
        }}
      >
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {label}
      </Button>
    </div>
  );
}
