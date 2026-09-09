// Что осталось сделать, чтобы салон работал полностью.
//
// ГДЕ ЖИВЁТ И ПОЧЕМУ ЗДЕСЬ. На дашборде — первом экране после входа. Раньше похожий список стоял
// в настройках салона, то есть там, куда владелец заходит, уже зная, чего хочет. Человек, который
// не знает, что делать дальше, до настроек не доходит: он видит четыре числа на дашборде и
// закрывает вкладку.
//
// ЧТО СЧИТАЕТСЯ ШАГОМ. Только то, без чего салон работает ХУЖЕ. «Заполнить описание сайта» —
// не шаг: салон без описания принимает записи. «Мастер без графика» — шаг, потому что такой салон
// выглядит настроенным и не отдаёт ни одного свободного окна.
//
// ИСЧЕЗАЕТ САМ. Когда всё сделано — блока нет. Чеклист, который висит вечно с галочками, читается
// как упрёк и перестаёт восприниматься.
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Circle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { getOnboardingProgress } from "@/lib/onboarding.functions";

type Progress = Awaited<ReturnType<typeof getOnboardingProgress>>;

type Step = {
  id: string;
  done: boolean;
  title: string;
  /** Что это даёт салону. Не «включите настройку», а «зачем». */
  why: string;
  to: string;
  /** Раздел настроек. Кнопка обязана приводить туда, где делают, а не на первую вкладку. */
  tab: string;
  cta: string;
};

function buildSetupSteps(p: Progress, salonId: string): Step[] {
  const settings = `/admin/salons/${salonId}`;
  return [
    {
      id: "services",
      done: p.servicesCount > 0,
      title: "Добавьте услуги",
      why: "Без них клиенту не на что записываться.",
      to: settings,
      tab: "services",
      cta: "Добавить",
    },
    {
      id: "masters",
      // Не «мастер добавлен», а «мастер может принимать». Мастер без графика виден клиенту и не
      // отдаёт ни одного окна — салон при этом выглядит настроенным.
      done: p.bookableMastersCount > 0,
      title: p.mastersCount > 0 ? "Задайте график мастерам" : "Добавьте мастеров",
      why:
        p.mastersCount > 0
          ? "Мастер без графика не показывает клиентам ни одного свободного времени."
          : "Кто-то должен принимать клиентов — впишите себя, если работаете одна.",
      to: settings,
      tab: "masters",
      cta: "Настроить",
    },
    {
      id: "whatsapp",
      done: p.whatsapp.connected,
      title: "Подключите WhatsApp",
      why: "Ассистент будет отвечать клиентам и записывать их даже ночью.",
      to: settings,
      tab: "integrations",
      cta: "Подключить",
    },
    {
      id: "assistant",
      done: p.assistantEnabled,
      title: "Включите ассистента",
      why: "Он отвечает на вопросы о ценах и сам подбирает свободное время.",
      to: settings,
      tab: "ai",
      cta: "Включить",
    },
  ];
}

export function SetupChecklist({ progress, salonId }: { progress: Progress; salonId: string }) {
  const steps = buildSetupSteps(progress, salonId);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  const next = steps.find((s) => !s.done);

  return (
    <Card className="qb-rise p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">Осталось немного</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {progress.servicesCount > 0 && progress.bookableMastersCount > 0
              ? "Салон уже принимает записи. Эти шаги сделают его сильнее."
              : "Ещё пара шагов — и клиенты смогут записываться сами."}
          </p>
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
          {done} из {steps.length}
        </span>
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>

      <ul className="qb-stagger mt-4 divide-y">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            {s.done ? (
              <Check className="h-5 w-5 shrink-0 text-success" />
            ) : (
              <Circle className="h-5 w-5 shrink-0 text-muted-foreground/30" />
            )}
            <div className="min-w-0 flex-1">
              <p
                className={`text-sm font-medium ${s.done ? "text-muted-foreground line-through" : ""}`}
              >
                {s.title}
              </p>
              {!s.done && <p className="mt-0.5 text-xs text-muted-foreground">{s.why}</p>}
            </div>
            {!s.done && (
              <Button
                asChild
                size="sm"
                variant={s === next ? "default" : "outline"}
                className="shrink-0"
              >
                <Link to={s.to as any} search={{ tab: s.tab } as any}>
                  {s.cta}
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
