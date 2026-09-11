// Баннер оплаты над кабинетом и экран блокировки при неоплате.
//
// Пороги (за сколько дней предупреждать, с какого процента расхода) приходят из состояния салона,
// то есть из billing_settings — здесь только слова.
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plural, type BillingState } from "@/lib/billing-logic";

function fmtDate(d?: string | null): string {
  return d ? new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "";
}

export function billingBannerText(
  s: BillingState | null,
): { tone: "warn" | "error"; text: string } | null {
  if (!s?.has_subscription || s.exempt || s.blocked) return null;
  if (s.status === "past_due") {
    return {
      tone: "error",
      text: `Оплата не поступила. Оплатите до ${fmtDate(s.grace_until)} — иначе онлайн-запись и ассистент остановятся.`,
    };
  }
  if (s.assistant_paused) {
    return {
      tone: "error",
      text: "Сообщения тарифа закончились — ассистент не отвечает клиентам. Докупите пакет или смените тариф.",
    };
  }
  if (s.status === "trialing" && s.trial_ends_at) {
    const days = Math.ceil((new Date(s.trial_ends_at).getTime() - Date.now()) / 86_400_000);
    if (days <= (s.trial_warn_days ?? 3)) {
      return {
        tone: "warn",
        text:
          days <= 0
            ? "Пробный период закончился. Оплатите тариф, чтобы всё продолжило работать."
            : `Пробный период закончится через ${days} ${plural(days, "день", "дня", "дней")}. Оплатите тариф, чтобы не было перерыва.`,
      };
    }
  }
  if ((s.usage_pct ?? 0) >= (s.usage_warn_pct ?? 80)) {
    return {
      tone: "warn",
      text: `Израсходовано ${s.usage_pct}% сообщений ассистента в этом месяце.`,
    };
  }
  return null;
}

export function BillingBanner({ state }: { state: BillingState | null }) {
  const b = billingBannerText(state);
  if (!b) return null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm border-b ${
        b.tone === "error"
          ? "bg-red-50 text-red-900 border-red-200 dark:bg-red-950/40 dark:text-red-100 dark:border-red-900"
          : "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-900"
      }`}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">{b.text}</span>
      <Link to="/admin/billing" className="font-medium underline underline-offset-2">
        Тариф и оплата
      </Link>
    </div>
  );
}

export function BillingPaywall({ isOwner }: { isOwner: boolean }) {
  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4 animate-in fade-in-0 zoom-in-95 duration-300">
        <div className="mx-auto h-14 w-14 rounded-full bg-muted flex items-center justify-center">
          <Lock className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <h2 className="text-xl font-semibold">Кабинет приостановлен</h2>
        {isOwner ? (
          <p className="text-muted-foreground">
            Подписка Qabyl не оплачена. Онлайн-запись и ассистент остановлены — клиенты сейчас не
            могут записаться. Все данные сохранены: после оплаты всё заработает сразу.
          </p>
        ) : (
          <p className="text-muted-foreground">
            Подписка салона на Qabyl не оплачена. Обратитесь к владельцу салона.
          </p>
        )}
        {isOwner && (
          <Button asChild size="lg">
            <Link to="/admin/billing">Оплатить тариф</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
