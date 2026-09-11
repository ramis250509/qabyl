// «Тариф и оплата» — кабинет владельца салона.
//
// Слова экрана — слова салона: сообщения, каналы, филиалы. Ни Meta, ни шлюза, ни токенов.
// Владелец платформы открывает тот же экран для любого салона через ?salon=<id> и видит внизу
// панель ручной оплаты и освобождения от оплаты.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CreditCard, Loader2, MessageSquare, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth-client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { formatNumber, type BillingState } from "@/lib/billing-logic";
import {
  buyMessagesPack,
  changeBillingPlan,
  getBillingOverview,
  payBillingNow,
  recordManualBillingPayment,
  setBillingAutoTopup,
  setBillingCancel,
  setBillingExempt,
} from "@/lib/billing.functions";
import { PlatformBillingOverview } from "@/components/admin/PlatformBillingOverview";
import { PlanCards } from "@/components/billing/PlanCards";

export const Route = createFileRoute("/admin/billing")({
  head: () => ({ meta: [{ title: "Тариф и оплата — Qabyl" }] }),
  validateSearch: (s: Record<string, unknown>): { payment?: string; salon?: string } => ({
    payment: typeof s.payment === "string" ? s.payment : undefined,
    salon: typeof s.salon === "string" ? s.salon : undefined,
  }),
  component: BillingPage,
});

type Overview = Awaited<ReturnType<typeof getBillingOverview>>;

function fmtDate(d?: string | null): string {
  return d
    ? new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    : "—";
}

function statusView(s: BillingState): {
  tone: "ok" | "warn" | "error";
  title: string;
  text: string;
} {
  if (s.exempt) {
    return {
      tone: "ok",
      title: "Бесплатно",
      text: s.salon_exempt ? "Салон-партнёр: оплата не требуется." : "Оплата сейчас не требуется.",
    };
  }
  switch (s.status) {
    case "trialing":
      return {
        tone: "ok",
        title: `Пробный период до ${fmtDate(s.trial_ends_at)}`,
        text: "Все возможности тарифа уже работают. Оплатите до конца пробного периода, чтобы не было перерыва.",
      };
    case "active":
      return s.cancel_at_period_end
        ? {
            tone: "warn",
            title: `Подписка закончится ${fmtDate(s.current_period_end)}`,
            text: "После этой даты онлайн-запись и ассистент остановятся. Передумали — возобновите подписку.",
          }
        : {
            tone: "ok",
            title: `Оплачено до ${fmtDate(s.current_period_end)}`,
            text: "Всё работает.",
          };
    case "past_due":
      return {
        tone: "error",
        title: `Нужна оплата до ${fmtDate(s.grace_until)}`,
        text: "Оплата не поступила. Пока всё работает, но после этой даты онлайн-запись и ассистент остановятся.",
      };
    case "suspended":
      return {
        tone: "error",
        title: "Кабинет приостановлен",
        text: "Онлайн-запись и ассистент остановлены. Данные сохранены — после оплаты всё заработает сразу.",
      };
    case "canceled":
      return {
        tone: "error",
        title: "Подписка отменена",
        text: "Выберите тариф, чтобы снова принимать записи.",
      };
    default:
      return { tone: "ok", title: "", text: "" };
  }
}

const KIND_LABEL: Record<string, string> = {
  subscription: "Подписка",
  overage_pack: "Пакет сообщений",
  proration: "Доплата за смену тарифа",
  card_check: "Проверка карты",
};
const STATUS_LABEL: Record<string, string> = {
  paid: "Оплачен",
  pending: "Ожидает оплаты",
  failed: "Не прошёл",
  canceled: "Отменён",
};

function BillingPage() {
  const { loading, salonId: ownSalonId, isSuperAdmin } = useAuth();
  const search = Route.useSearch();
  const salonId = (isSuperAdmin && search.salon) || ownSalonId || null;
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!salonId) return;
    try {
      setData(await getBillingOverview({ data: { salonId } }));
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? "Не удалось загрузить тариф");
    }
  }, [salonId]);

  useEffect(() => {
    load();
  }, [load]);

  // Возврат с формы оплаты. Подтверждение банка приходит отдельно и может отстать на несколько
  // секунд — перечитываем чуть позже, чтобы владелец увидел новый статус без перезагрузки.
  useEffect(() => {
    if (search.payment === "success") {
      toast.success("Оплата принята. Статус обновится через несколько секунд.");
      const t = setTimeout(load, 6000);
      return () => clearTimeout(t);
    }
    if (search.payment === "failed") {
      toast.error("Оплата не прошла. Попробуйте ещё раз или другую карту.");
    }
  }, [search.payment, load]);

  async function run(key: string, fn: () => Promise<any>, okText?: string) {
    setBusy(key);
    try {
      const r = await fn();
      if (r?.redirectUrl) {
        window.location.assign(r.redirectUrl);
        return;
      }
      if (okText) toast.success(okText);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Не получилось");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <FullScreenLoader />;
  if (isSuperAdmin && !search.salon) return <PlatformBillingOverview />;
  if (!salonId) {
    return (
      <div className="p-6 text-muted-foreground">
        {isSuperAdmin
          ? "Откройте тариф конкретного салона: /admin/billing?salon=<id салона>"
          : "Салон не найден"}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-destructive">{loadError}</p>
        <Button variant="outline" onClick={load}>
          Повторить
        </Button>
      </div>
    );
  }
  if (!data) return <FullScreenLoader />;

  const s = data.state;
  if (!s?.has_subscription) {
    return (
      <div className="p-6 text-muted-foreground">
        Тариф для салона ещё не заведён. Напишите в поддержку: {data.supportContact}
      </div>
    );
  }

  const view = statusView(s);
  const currentPlan = data.plans.find((p) => p.code === s.plan_code);
  const pendingPlan = data.plans.find((p) => p.code === s.pending_plan_code);
  const used = s.messages_used ?? 0;
  const allowance = s.messages_allowance ?? 0;
  const pct = allowance > 0 ? Math.min(100, Math.round((used * 100) / allowance)) : 0;
  const payLabel =
    s.status === "trialing"
      ? "Оплатить тариф"
      : s.status === "active"
        ? "Оплатить следующий месяц"
        : `Оплатить ${formatNumber(pendingPlan?.price_kgs ?? s.price_kgs ?? 0)} сом`;

  async function choosePlan(code: string, name: string) {
    const trial = s?.status === "trialing";
    const question = trial
      ? `Перейти на тариф ${name}? В пробном периоде это бесплатно.`
      : `Перейти на тариф ${name}? При повышении доплата за остаток месяца спишется сразу, понижение включится со следующего месяца.`;
    if (!window.confirm(question)) return;
    await run(`plan:${code}`, async () => {
      const r = await changeBillingPlan({ data: { salonId: salonId!, planCode: code } });
      if (r.result === "downgrade_scheduled") {
        toast.success(`Тариф ${name} включится со следующего месяца`);
      } else if (r.result !== "checkout" && r.result !== "same") {
        toast.success(`Тариф ${name} включён`);
      }
      return r;
    });
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 animate-in fade-in-0 duration-300">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Тариф и оплата</h1>
        <p className="text-sm text-muted-foreground">
          Сейчас:{" "}
          <span className="font-medium text-foreground">{currentPlan?.name ?? s.plan_name}</span>
          {pendingPlan ? ` · с ${fmtDate(s.current_period_end)} — ${pendingPlan.name}` : ""}
        </p>
      </header>

      {/* Статус */}
      <Card
        className={`p-5 border-l-4 ${
          view.tone === "error"
            ? "border-l-red-500"
            : view.tone === "warn"
              ? "border-l-amber-500"
              : "border-l-emerald-500"
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex-1 space-y-1">
            <h2 className="font-semibold">{view.title}</h2>
            <p className="text-sm text-muted-foreground">{view.text}</p>
            {s.card_mask && (
              <p className="text-sm text-muted-foreground flex items-center gap-2 pt-1">
                <CreditCard className="h-4 w-4" aria-hidden /> Карта {s.card_mask} — продление
                спишется автоматически
              </p>
            )}
          </div>
          {!s.exempt && (
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              {data.paymentsEnabled ? (
                <Button
                  size="lg"
                  disabled={busy !== null}
                  onClick={() => run("pay", () => payBillingNow({ data: { salonId: salonId! } }))}
                >
                  {busy === "pay" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {payLabel}
                </Button>
              ) : null}
              {s.status === "active" && (
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    if (
                      !s.cancel_at_period_end &&
                      !window.confirm(
                        "Отменить подписку? Всё будет работать до конца оплаченного месяца, затем онлайн-запись и ассистент остановятся.",
                      )
                    )
                      return;
                    run(
                      "cancel",
                      () =>
                        setBillingCancel({
                          data: { salonId: salonId!, cancel: !s.cancel_at_period_end },
                        }),
                      s.cancel_at_period_end ? "Подписка возобновлена" : "Подписка будет отменена",
                    );
                  }}
                >
                  {s.cancel_at_period_end ? "Возобновить подписку" : "Отменить подписку"}
                </Button>
              )}
            </div>
          )}
        </div>
        {!s.exempt && !data.paymentsEnabled && (
          <div className="mt-4 rounded-md bg-muted p-3 text-sm space-y-1">
            <p className="font-medium">Как оплатить</p>
            <p className="text-muted-foreground whitespace-pre-line">
              {data.manualInstructions ||
                `Оплата картой скоро появится. Сейчас оплатить можно переводом — напишите нам: ${data.supportContact}. Тариф включится сразу после поступления оплаты.`}
            </p>
          </div>
        )}
      </Card>

      {/* Расход */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <MessageSquare className="h-5 w-5 mt-0.5 text-muted-foreground" aria-hidden />
          <div className="flex-1 space-y-1">
            <h2 className="font-semibold">Сообщения ассистента</h2>
            <p className="text-sm text-muted-foreground">
              {s.status === "trialing" ? "За пробный период" : "В этом месяце"}: ответы клиентам,
              подтверждения и напоминания во всех каналах.
            </p>
          </div>
          <div className="text-right tabular-nums">
            <div className="text-lg font-semibold">
              {formatNumber(used)}{" "}
              <span className="text-muted-foreground font-normal">
                из {formatNumber(allowance)}
              </span>
            </div>
            {(s.messages_credits ?? 0) > 0 && (
              <div className="text-xs text-muted-foreground">
                включая {formatNumber(s.messages_credits ?? 0)} из пакетов
              </div>
            )}
          </div>
        </div>
        <Progress
          value={pct}
          aria-label="Израсходовано сообщений"
          className={
            s.assistant_paused
              ? "[&>div]:bg-red-500"
              : pct >= (s.usage_warn_pct ?? 80)
                ? "[&>div]:bg-amber-500"
                : ""
          }
        />
        {s.assistant_paused && !s.exempt && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Сообщения закончились — ассистент не отвечает клиентам. Сообщения клиентов по-прежнему
            видны в переписках.
          </p>
        )}
        {!s.exempt && currentPlan && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
            <label className="flex items-center gap-3 flex-1 text-sm cursor-pointer">
              <Switch
                checked={s.auto_topup ?? false}
                disabled={busy !== null}
                onCheckedChange={(v) =>
                  run(
                    "topup",
                    () => setBillingAutoTopup({ data: { salonId: salonId!, enabled: v } }),
                    v ? "Автодокупка включена" : "Автодокупка выключена",
                  )
                }
              />
              <span>
                Докупать {formatNumber(currentPlan.pack_messages)} сообщений за{" "}
                {formatNumber(currentPlan.pack_price_kgs)} сом автоматически, когда закончатся
              </span>
            </label>
            {data.paymentsEnabled && (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "pack",
                    () => buyMessagesPack({ data: { salonId: salonId! } }),
                    "Пакет добавлен",
                  )
                }
              >
                {busy === "pack" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Докупить сейчас
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* Тарифы */}
      <section className="space-y-3" aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="text-lg font-semibold">
          Тарифы
        </h2>
        <PlanCards
          plans={data.plans}
          currentCode={s.plan_code}
          pendingCode={s.pending_plan_code}
          busyCode={busy?.startsWith("plan:") ? busy.slice(5) : null}
          disabled={busy !== null || (s.exempt === true && !isSuperAdmin)}
          onChoose={(p) => choosePlan(p.code, p.name)}
        />
        <p className="text-xs text-muted-foreground">
          Сообщения — это ответы ассистента, подтверждения и напоминания, которые Qabyl отправляет
          клиентам от имени салона. Входящие сообщения не считаются. Когда сообщения заканчиваются,
          записи и календарь продолжают работать.
        </p>
      </section>

      {/* Счета */}
      {data.invoices.length > 0 && (
        <Card className="p-5 space-y-3">
          <h2 className="font-semibold">История оплат</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-normal">Дата</th>
                  <th className="py-2 pr-4 font-normal">Что</th>
                  <th className="py-2 pr-4 font-normal text-right">Сумма</th>
                  <th className="py-2 font-normal">Статус</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr key={inv.id} className="border-t">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {fmtDate(inv.paid_at ?? inv.created_at)}
                    </td>
                    <td className="py-2 pr-4">
                      {KIND_LABEL[inv.kind] ?? inv.kind}
                      {inv.period_start && inv.period_end
                        ? ` · ${fmtDate(inv.period_start)} — ${fmtDate(inv.period_end)}`
                        : ""}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums whitespace-nowrap">
                      {formatNumber(inv.amount_kgs)} сом
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {STATUS_LABEL[inv.status] ?? inv.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {isSuperAdmin && (
        <PlatformPanel salonId={salonId} state={s} plans={data.plans} busy={busy} run={run} />
      )}
    </div>
  );
}

function PlatformPanel({
  salonId,
  state,
  plans,
  busy,
  run,
}: {
  salonId: string;
  state: BillingState;
  plans: Overview["plans"];
  busy: string | null;
  run: (key: string, fn: () => Promise<any>, okText?: string) => Promise<void>;
}) {
  const [planCode, setPlanCode] = useState(
    state.pending_plan_code ?? state.plan_code ?? "business",
  );
  const [months, setMonths] = useState(1);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const plan = plans.find((p) => p.code === planCode);
  const defaultAmount = (plan?.price_kgs ?? 0) * months;

  return (
    <Card className="p-5 space-y-4 border-dashed">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h2 className="font-semibold">Владелец платформы</h2>
      </div>

      <label className="flex items-center gap-3 text-sm cursor-pointer">
        <Switch
          checked={state.salon_exempt ?? state.exempt ?? false}
          disabled={busy !== null}
          onCheckedChange={(v) =>
            run(
              "exempt",
              () => setBillingExempt({ data: { salonId, exempt: v } }),
              v ? "Салон освобождён от оплаты" : "Освобождение снято",
            )
          }
        />
        <span>Освободить от оплаты (партнёрский салон)</span>
      </label>

      <div className="space-y-3">
        <p className="text-sm font-medium">Отметить оплату переводом</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="mp-plan">Тариф</Label>
            <select
              id="mp-plan"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={planCode}
              onChange={(e) => setPlanCode(e.target.value)}
            >
              {plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="mp-months">Месяцев</Label>
            <Input
              id="mp-months"
              type="number"
              min={1}
              max={12}
              value={months}
              onChange={(e) => setMonths(Math.min(12, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mp-amount">Сумма, сом</Label>
            <Input
              id="mp-amount"
              inputMode="numeric"
              placeholder={String(defaultAmount)}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mp-note">Комментарий</Label>
            <Input
              id="mp-note"
              placeholder="MBANK, 11.09"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy !== null}
            onClick={() =>
              run(
                "manual",
                () =>
                  recordManualBillingPayment({
                    data: {
                      salonId,
                      kind: "subscription",
                      planCode,
                      months,
                      amountKgs: amount ? Number(amount) : null,
                      note: note || null,
                    },
                  }),
                "Оплата отмечена",
              )
            }
          >
            {busy === "manual" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Отметить оплату тарифа
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run(
                "manual-pack",
                () =>
                  recordManualBillingPayment({
                    data: { salonId, kind: "overage_pack", note: note || null },
                  }),
                "Пакет сообщений добавлен",
              )
            }
          >
            Отметить оплату пакета сообщений
          </Button>
        </div>
      </div>
    </Card>
  );
}
