// Баннер оплаты над кабинетом и экран блокировки при неоплате.
//
// Пороги (за сколько дней предупреждать, с какого процента расхода) приходят из состояния салона,
// то есть из billing_settings — здесь только слова.
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plural, type BillingState } from "@/lib/billing-logic";
import { adminLocale, makeTr, useAdminLang, type AdminLang } from "@/lib/admin-lang";

function fmtDate(d: string | null | undefined, lang: AdminLang): string {
  return d
    ? new Date(d).toLocaleDateString(adminLocale(lang), { day: "numeric", month: "long" })
    : "";
}

/**
 * @param isOwner Владелец видит, что делать; сотрудник — что происходит.
 *
 * Раньше баннер показывали только владельцу. Для администратора на ресепшене это означало, что
 * однажды утром онлайн-запись просто перестаёт работать без единого слова на экране, и он звонит
 * владельцу выяснять, что сломалось. Предупреждать надо того, кто столкнётся с последствиями.
 */
export function billingBannerText(
  s: BillingState | null,
  isOwner = true,
  lang: AdminLang = "ru",
): { tone: "warn" | "error"; text: string } | null {
  const tr = makeTr(lang);
  if (!s?.has_subscription || s.exempt || s.blocked) return null;
  if (s.status === "past_due") {
    const until = fmtDate(s.grace_until, lang);
    return {
      tone: "error",
      text: isOwner
        ? tr(
            `Оплата не поступила. Оплатите до ${until} — иначе онлайн-запись и ассистент остановятся.`,
            `Payment has not arrived. Pay by ${until}, otherwise online booking and the assistant will stop.`,
          )
        : tr(
            `Салон не оплатил Qabyl. Если не оплатить до ${until}, онлайн-запись и ассистент остановятся — скажите владельцу.`,
            `The salon has not paid for Qabyl. If it is not paid by ${until}, online booking and the assistant will stop — tell the owner.`,
          ),
    };
  }
  if (s.assistant_paused) {
    return {
      tone: "error",
      text: isOwner
        ? tr(
            "Сообщения тарифа закончились — ассистент не отвечает клиентам. Докупите пакет или смените тариф.",
            "Your plan's messages have run out — the assistant is not replying to clients. Buy a top-up or change the plan.",
          )
        : tr(
            "Сообщения тарифа закончились — ассистент не отвечает клиентам. Отвечайте вручную и скажите владельцу.",
            "The plan's messages have run out — the assistant is not replying to clients. Reply manually and tell the owner.",
          ),
    };
  }
  if (s.status === "trialing" && s.trial_ends_at) {
    const days = Math.ceil((new Date(s.trial_ends_at).getTime() - Date.now()) / 86_400_000);
    const daysRu = `${days} ${plural(days, "день", "дня", "дней")}`;
    const daysEn = `${days} ${days === 1 ? "day" : "days"}`;
    if (days <= (s.trial_warn_days ?? 3)) {
      if (!isOwner) {
        return {
          tone: "warn",
          text:
            days <= 0
              ? tr(
                  "Бесплатный период салона закончился. Пока владелец не оплатит, запись может остановиться.",
                  "The salon's free trial has ended. Until the owner pays, booking may stop.",
                )
              : tr(
                  `Бесплатный период салона заканчивается через ${daysRu}.`,
                  `The salon's free trial ends in ${daysEn}.`,
                ),
        };
      }
      return {
        tone: "warn",
        text:
          days <= 0
            ? tr(
                "Бесплатный период закончился. Оплатите тариф, чтобы всё продолжило работать.",
                "Your free trial has ended. Pay for a plan to keep everything running.",
              )
            : tr(
                `Бесплатно осталось ${daysRu}. Оплатите тариф, чтобы не было перерыва.`,
                `${daysEn} of free trial left. Pay for a plan to avoid a break.`,
              ),
      };
    }
  }
  // Сотруднику про расход сообщений не говорим: он на это никак не влияет, а строка наверху
  // экрана каждый день — это шум, который через неделю перестают читать вместе с важным.
  if (isOwner && (s.usage_pct ?? 0) >= (s.usage_warn_pct ?? 80)) {
    return {
      tone: "warn",
      text: tr(
        `Израсходовано ${s.usage_pct}% сообщений ассистента в этом месяце.`,
        `${s.usage_pct}% of this month's assistant messages used.`,
      ),
    };
  }
  return null;
}

export function BillingBanner({
  state,
  isOwner = true,
}: {
  state: BillingState | null;
  isOwner?: boolean;
}) {
  const { lang, tr } = useAdminLang();
  const b = billingBannerText(state, isOwner, lang);
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
      {isOwner && (
        <Link to="/admin/billing" className="font-medium underline underline-offset-2">
          {tr("Оплатить", "Pay")}
        </Link>
      )}
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
            Владелец салона пока не продлил Qabyl. Записи и клиенты на месте, ничего не пропало —
            как только оплата пройдёт, кабинет откроется сам. Скажите владельцу, что запись
            остановилась.
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
