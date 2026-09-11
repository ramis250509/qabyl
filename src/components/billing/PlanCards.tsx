// Карточки тарифов — одни и те же в мастере регистрации и на экране «Тариф и оплата».
//
// Что входит в тариф, берётся из данных тарифа (describePlan на сервере), а не пишется здесь:
// иначе после смены лимита в базе карточки продолжат обещать старое.
import { Check, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
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

export function PlanCards({
  plans,
  currentCode,
  pendingCode,
  busyCode,
  disabled,
  onChoose,
  mode = "billing",
}: {
  plans: PlanCardData[];
  currentCode?: string | null;
  pendingCode?: string | null;
  busyCode?: string | null;
  disabled?: boolean;
  onChoose: (plan: PlanCardData) => void;
  mode?: "billing" | "onboarding";
}) {
  return (
    <div className="grid items-stretch gap-4 pt-3 md:grid-cols-3">
      {plans.map((p) => {
        const isCurrent = p.code === currentCode;
        const isPending = p.code === pendingCode;
        const trial = `${p.trial_days} ${plural(p.trial_days, "день", "дня", "дней")} бесплатно`;
        const label =
          mode === "onboarding"
            ? isCurrent
              ? "Выбран"
              : `Выбрать ${p.name}`
            : isCurrent
              ? "Ваш тариф"
              : isPending
                ? "Со следующего месяца"
                : "Выбрать";
        return (
          <Card
            key={p.code}
            className={`relative flex flex-col gap-4 p-5 transition-all duration-200 hover:shadow-md ${
              p.is_featured ? "shadow-md ring-2 ring-primary md:-translate-y-1" : ""
            } ${mode === "onboarding" && isCurrent ? "bg-primary/5" : ""}`}
          >
            {p.is_featured && (
              <span className="absolute -top-3 left-5 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                Самый популярный
              </span>
            )}
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{p.name}</h3>
              {p.tagline && <p className="text-sm text-muted-foreground">{p.tagline}</p>}
            </div>
            <div>
              <span className="text-3xl font-bold tabular-nums">{formatNumber(p.price_kgs)}</span>
              <span className="text-muted-foreground"> сом/мес</span>
              <p
                className={`mt-1 text-xs ${mode === "onboarding" ? "font-medium text-success" : "text-muted-foreground"}`}
              >
                {mode === "onboarding" ? trial : `${trial} для новых салонов`}
              </p>
            </div>
            <ul className="flex-1 space-y-2 text-sm">
              {p.lines.map((line) => (
                <li key={line} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                  <span>{line}</span>
                </li>
              ))}
              <li className="flex gap-2 text-muted-foreground">
                <Check className="mt-0.5 h-4 w-4 shrink-0 opacity-0" aria-hidden />
                <span>
                  Пакет +{formatNumber(p.pack_messages)} сообщений —{" "}
                  {formatNumber(p.pack_price_kgs)} сом
                </span>
              </li>
            </ul>
            <Button
              variant={p.is_featured && !isCurrent ? "default" : "outline"}
              disabled={disabled || isCurrent || isPending}
              aria-pressed={mode === "onboarding" ? isCurrent : undefined}
              onClick={() => onChoose(p)}
            >
              {busyCode === p.code && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {label}
            </Button>
          </Card>
        );
      })}
    </div>
  );
}
