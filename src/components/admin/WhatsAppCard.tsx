// Экран «WhatsApp» в панели салона.
//
// ДЛЯ КОГО НАПИСАН. Для владелицы салона, которая не знает и не должна знать, что такое WABA,
// Phone Number ID, app secret и вебхук. Она задаёт экрану два вопроса: «работает ли» и «что мне
// сделать». Всё остальное — служебное и живёт под кнопкой «Для специалистов», куда обычный
// владелец не заходит никогда.
//
// ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ по сравнению с прежней версией:
//   • токена и app secret в состоянии React — сервер их больше не отдаёт (см. wa-cloud.functions);
//   • карточки моста Make — обход App Review, удалён 09.09.2026 вместе с транспортом;
//   • переключателя «шаблоны одобрены» — его значение теперь приходит от Meta, а не от того,
//     кто последний нажал тумблер;
//   • строчки «кнопка заработает после того, как Meta одобрит платформу» — одобрила.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, Loader2, MessageCircle, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import {
  EmptyState,
  SkeletonBlock,
  StatusBadge,
  StatusPanel,
  Stepper,
  type StatusAction,
  type Tone,
} from "@/components/ui/status";
import {
  getWaCloudConfig,
  getWaCloudDiagnostics,
  upsertWaCloudConfig,
} from "@/lib/wa-cloud.functions";
import {
  checkWaConnection,
  createWaTemplates,
  disconnectWa,
  finishWaOnboarding,
  subscribeWaWebhooks,
} from "@/lib/wa-onboarding.functions";
import { WaConnectButton, type SignupOutcome } from "@/components/admin/WaConnectButton";
import { useAuth } from "@/lib/auth-client";
import { humanError } from "@/lib/human-error";
import { waStatusForViewer } from "@/lib/wa-status-view";

type Config = Awaited<ReturnType<typeof getWaCloudConfig>>;
type Status = Config["status"];
type Diagnostics = Awaited<ReturnType<typeof getWaCloudDiagnostics>>;

/** Как называется каждое уведомление на языке салона, а не на языке шаблонов Meta. */
const KIND_LABELS: Record<string, string> = {
  confirmation: "Подтверждение записи",
  reminder: "Напоминание за 2 часа",
  reschedule: "Перенос записи",
  cancellation: "Отмена записи",
  owner_alert: "Уведомление вам о новой записи",
  owner_change: "Клиент сам перенёс или отменил",
};

/** Статус шаблона у Meta → что это значит для салона. */
function templateTone(status?: string | null): { tone: Tone; label: string } {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
      return { tone: "ok", label: "работает" };
    case "PENDING":
      return { tone: "warn", label: "на проверке" };
    case "REJECTED":
      return { tone: "error", label: "отклонено" };
    case "PAUSED":
      return { tone: "warn", label: "приостановлено" };
    case "DISABLED":
      return { tone: "error", label: "отключено" };
    case "MISSING":
      return { tone: "error", label: "удалено в Meta" };
    default:
      return { tone: "idle", label: "неизвестно" };
  }
}

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} ч назад`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** Короткая подпись под большим блоком состояния: то, что владелец хочет видеть сразу. */
function Facts({ status }: { status: Status }) {
  const f = status.facts;
  const items = [
    f.phone ? { label: "Номер", value: f.phone } : null,
    f.verifiedName ? { label: "Имя в WhatsApp", value: f.verifiedName } : null,
    f.quality ? { label: "Отношение клиентов", value: f.quality } : null,
    {
      label: "Уведомления",
      value: `${f.templatesApproved} из ${f.templatesTotal} готовы`,
    },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <dl className="qb-stagger mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 truncate text-sm font-medium">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Диагностика: «Meta вообще звонила в наш вебхук?»
 *
 * Отвечает на вопрос, который возникает ровно в один момент — клиент написал, ответа нет.
 * Свёрнута по умолчанию: пока всё работает, читать её незачем.
 */
function DiagnosticsBlock({ salonId, connected }: { salonId: string; connected: boolean }) {
  const load = useServerFn(getWaCloudDiagnostics);
  const [open, setOpen] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setDiag(await load({ data: { salonId } }));
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось загрузить диагностику"));
    } finally {
      setBusy(false);
    }
  }, [salonId]);

  useEffect(() => {
    if (open && !diag) void refresh();
  }, [open, diag, refresh]);

  if (!connected) return null;

  // Порядок ровно как в жизни: сначала «есть ли свежая поломка», потом «ходит ли трафик».
  const issueAt = diag?.lastWebhookIssueAt ? new Date(diag.lastWebhookIssueAt).getTime() : 0;
  const outAt = diag?.lastOutboundAt ? new Date(diag.lastOutboundAt).getTime() : 0;
  const verdict = !diag
    ? null
    : issueAt && issueAt > outAt
      ? {
          tone: "warn" as Tone,
          text: `${diag.lastWebhookIssue ?? "причина не записана"} — ${whenLabel(diag.lastWebhookIssueAt)}.`,
        }
      : diag.lastInboundAt && diag.lastOutboundAt
        ? {
            tone: "ok" as Tone,
            text: `Последнее сообщение клиента — ${whenLabel(diag.lastInboundAt)}, последний ответ ассистента — ${whenLabel(diag.lastOutboundAt)}.`,
          }
        : diag.lastInboundAt
          ? {
              tone: "warn" as Tone,
              text: "Сообщения приходят, но ответов ещё не было. Напишите салону с другого телефона и обновите — причина появится здесь.",
            }
          : {
              tone: "idle" as Tone,
              text: "Клиенты ещё не писали в WhatsApp. Напишите салону сами с другого телефона — это лучшая проверка.",
            };

  return (
    <Card className="overflow-hidden p-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Как идут сообщения</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Проверка, доходят ли сообщения клиентов и уходят ли ответы
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="qb-fade space-y-3 border-t p-5">
          {busy && !diag ? (
            <div className="space-y-2">
              <SkeletonBlock className="h-4 w-3/4" />
              <SkeletonBlock className="h-4 w-1/2" />
            </div>
          ) : verdict ? (
            <div className="flex items-start gap-3">
              <StatusBadge tone={verdict.tone}>
                {verdict.tone === "ok" ? "Всё идёт" : verdict.tone === "warn" ? "Внимание" : "Тихо"}
              </StatusBadge>
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">{verdict.text}</p>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              Обновить
            </Button>
            {diag && (
              <span className="text-xs text-muted-foreground">
                Диалогов: {diag.conversationCount}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Служебная часть. Видна только владельцу платформы.
 *
 * Ручной ввод реквизитов нужен ровно одному сценарию: у салона своё приложение Meta, и Embedded
 * Signup ему недоступен. Владельцу салона показывать эту форму нельзя — она требует понимать
 * системных пользователей и app secret, и единственное, что он может в неё внести, это ошибку.
 */
function AdvancedBlock({
  salonId,
  cfg,
  onChanged,
}: {
  salonId: string;
  cfg: Config;
  onChanged: () => void;
}) {
  const save = useServerFn(upsertWaCloudConfig);
  const subscribe = useServerFn(subscribeWaWebhooks);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState(cfg.phone_number_id);
  const [wabaId, setWabaId] = useState(cfg.waba_id);
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");

  useEffect(() => {
    setPhoneNumberId(cfg.phone_number_id);
    setWabaId(cfg.waba_id);
  }, [cfg.phone_number_id, cfg.waba_id]);

  async function onSave() {
    setBusy(true);
    try {
      await save({
        data: {
          salonId,
          phone_number_id: phoneNumberId || null,
          waba_id: wabaId || null,
          token: token || null,
          app_secret: appSecret || null,
        },
      });
      // Подписка отдельным шагом и после сохранения: без неё салон выглядит подключённым и
      // молчит — сообщения уходят в Meta и до нас не доезжают.
      try {
        await subscribe({ data: { salonId } });
      } catch (e: any) {
        toast.warning(`Сохранено, но подписка не оформилась: ${e?.message ?? ""}`);
      }
      setToken("");
      setAppSecret("");
      toast.success("Сохранено");
      onChanged();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden p-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Для специалистов</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Ручные реквизиты для салона со своим приложением Meta
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="qb-fade space-y-4 border-t p-5">
          <p className="text-xs text-muted-foreground">
            Путь для номера, заведённого через собственное приложение Meta. Значения лежат в разделе{" "}
            <b>WhatsApp → API Setup</b>. Токен из API Setup живёт 24 часа — для постоянной работы
            нужен системный пользователь с правами{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              whatsapp_business_messaging
            </code>{" "}
            и{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              whatsapp_business_management
            </code>
            .
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-sm">ID номера (Phone Number ID)</Label>
              <Input
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="1152652971275812"
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-sm">ID аккаунта (WABA ID)</Label>
              <Input
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="1032772542716543"
                className="mt-1 font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-sm">Токен доступа</Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={cfg.has_token ? "сохранён — оставьте пустым" : "EAAG…"}
                className="mt-1 font-mono text-xs"
                autoComplete="off"
              />
              {/* Пустое поле означает «не менять», а не «стереть»: текущее значение сюда больше
                  не приходит, и трактовать пустоту как удаление значило бы стирать рабочий токен
                  каждый раз, когда правят соседнее поле. */}
              <p className="mt-1 text-xs text-muted-foreground">
                {cfg.has_token ? "Уже сохранён. Пустое поле его не тронет." : "Пока не задан."}
              </p>
            </div>
            <div>
              <Label className="text-sm">App Secret приложения салона</Label>
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={cfg.has_app_secret ? "сохранён — оставьте пустым" : "не требуется"}
                className="mt-1 font-mono text-xs"
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Нужен только для своего приложения. При подключении кнопкой — не нужен.
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium">Адреса вебхуков</p>
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
              Своё приложение: {cfg.webhook_url}
            </p>
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              Приложение Qabyl: {cfg.platform_webhook_url}
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              Verify token: {cfg.verify_token}
            </p>
          </div>

          <Button onClick={onSave} disabled={busy} size="sm">
            {busy ? "Сохранение…" : "Сохранить и подписать на вебхуки"}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function WhatsAppCard({ salonId }: { salonId: string }) {
  const { isSuperAdmin } = useAuth();
  const loadConfig = useServerFn(getWaCloudConfig);
  const onboard = useServerFn(finishWaOnboarding);
  const recheck = useServerFn(checkWaConnection);
  const makeTemplates = useServerFn(createWaTemplates);
  const unplug = useServerFn(disconnectWa);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  /** Какое действие выполняется прямо сейчас. Одно за раз — параллельные бессмысленны. */
  const [busy, setBusy] = useState<null | "connect" | "check" | "templates" | "disconnect">(null);

  const reload = useCallback(async () => {
    try {
      setCfg(await loadConfig({ data: { salonId } }));
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось загрузить настройки WhatsApp"));
    } finally {
      setLoading(false);
    }
  }, [salonId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSignup(outcome: SignupOutcome) {
    if (outcome.kind === "cancelled") {
      toast.info("Подключение отменено");
      return;
    }
    if (outcome.kind === "error") {
      toast.error(outcome.message, { duration: 10000 });
      return;
    }

    setBusy("connect");
    try {
      const res = await onboard({
        data: {
          salonId,
          code: outcome.code,
          wabaId: outcome.wabaId,
          phoneNumberId: outcome.phoneNumberId,
          coexistence: outcome.coexistence,
        },
      });
      // Говорим о результате словами состояния, а не списком технических шагов: «подключено,
      // тексты на проверке» понятнее, чем «template:visit_reminder — уже существует».
      const said = waStatusForViewer(res.status, isSuperAdmin);
      if (said.level === "ok") toast.success("WhatsApp подключён");
      else toast.success(said.title);
      await reload();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось завершить подключение"), { duration: 10000 });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function onRecheck() {
    setBusy("check");
    try {
      const status = await recheck({ data: { salonId } });
      setCfg((c) => (c ? { ...c, status } : c));
      const said = waStatusForViewer(status, isSuperAdmin);
      toast[said.level === "error" ? "error" : said.level === "warn" ? "warning" : "success"](
        said.title,
      );
    } catch (e: any) {
      toast.error(humanError(e, "Проверка не удалась"));
    } finally {
      setBusy(null);
    }
  }

  async function onCreateTemplates() {
    setBusy("templates");
    try {
      const res = await makeTemplates({ data: { salonId } });
      const failed = res.steps.filter((s) => !s.ok);
      if (failed.length === 0) {
        toast.success("Тексты отправлены на проверку в Meta — обычно это занимает несколько минут");
      } else {
        toast.warning(
          `Часть текстов Meta не приняла: ${failed.map((f) => f.detail ?? f.step).join("; ")}`,
          { duration: 12000 },
        );
      }
      await reload();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось создать тексты уведомлений"));
    } finally {
      setBusy(null);
    }
  }

  async function onDisconnect() {
    if (
      !confirm(
        "Отключить WhatsApp? Ассистент перестанет отвечать клиентам, а подтверждения и напоминания не будут отправляться. Переписка и записи сохранятся.",
      )
    )
      return;
    setBusy("disconnect");
    try {
      await unplug({ data: { salonId } });
      toast.success("WhatsApp отключён");
      await reload();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось отключить"));
    } finally {
      setBusy(null);
    }
  }

  if (loading || !cfg) {
    return (
      <div className="space-y-4">
        <Card className="space-y-3 p-4 sm:p-6">
          <SkeletonBlock className="h-6 w-52" />
          <SkeletonBlock className="h-4 w-full" />
          <SkeletonBlock className="h-4 w-2/3" />
        </Card>
      </div>
    );
  }

  // Состояние глазами смотрящего. Сырое состояние знает про кредитную линию YCloud и про то, что
  // WABA салона осталась без способа оплаты; владелице салона это ни о чём не говорит и чинится
  // не ею. См. src/lib/wa-status-view.ts — правило одно на все четыре экрана.
  const status = waStatusForViewer(cfg.status, isSuperAdmin);
  const connecting = busy === "connect";

  // Действие из состояния превращается в кнопку здесь и только здесь. Логика «что предлагать»
  // живёт на сервере (computeWaStatus) — иначе через месяц одно и то же состояние в двух местах
  // предлагает разное.
  const actions: StatusAction[] = [];
  switch (status.action?.kind) {
    case "add_payment":
      actions.push({ label: status.action.label, href: status.action.url });
      break;
    case "recreate_templates":
      actions.push({
        label: status.action.label,
        onClick: onCreateTemplates,
        loading: busy === "templates",
      });
      break;
    case "recheck":
    case "wait":
      actions.push({ label: status.action.label, onClick: onRecheck, loading: busy === "check" });
      break;
    case "support":
      actions.push({ label: status.action.label, href: "mailto:support@qabyl.com" });
      break;
    default:
      break;
  }

  return (
    <div className="space-y-4">
      {/* ---- Состояние. Первым, потому что это и есть ответ на вопрос «работает ли». */}
      {connecting ? (
        <div className="qb-rise rounded-xl border bg-info-surface p-6">
          <div className="flex items-start gap-4">
            <Loader2 className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-info" />
            <div className="min-w-0">
              <h3 className="text-base font-semibold sm:text-lg">Настраиваем подключение</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Обычно это занимает от десяти секунд до минуты. Не закрывайте страницу.
              </p>
              {/* Честный список того, что делается, без выдуманного прогресса: сервер выполняет
                  шаги одним запросом и не сообщает о них по одному. Показывать бегущую галочку
                  «по таймеру» значило бы врать про то, что уже готово. */}
              <Stepper
                className="mt-4"
                steps={[
                  { label: "Проверяем доступ к вашему аккаунту", state: "active" },
                  { label: "Подключаем приём сообщений", state: "pending" },
                  { label: "Готовим тексты подтверждений и напоминаний", state: "pending" },
                ]}
              />
            </div>
          </div>
        </div>
      ) : (
        <StatusPanel
          tone={status.level}
          title={status.title}
          body={status.body}
          actions={actions}
          aside={
            status.connected && status.facts.lastCheckedAt
              ? `проверено ${whenLabel(status.facts.lastCheckedAt)}`
              : undefined
          }
        >
          {status.connected && <Facts status={status} />}
        </StatusPanel>
      )}

      {/* ---- Подключение. */}
      <Card className="space-y-4 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="font-semibold">Официальное подключение через Meta</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Вы входите в свой Facebook и подтверждаете номер — остальное Qabyl настраивает сам.
              WhatsApp Business на телефоне при этом продолжает работать: вы по-прежнему видите
              переписку и можете отвечать вручную.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <WaConnectButton connected={status.connected} onConnected={onSignup} />
          {status.connected && (
            <>
              <Button variant="outline" onClick={onRecheck} disabled={busy !== null}>
                <RefreshCw className={`mr-1.5 h-4 w-4 ${busy === "check" ? "animate-spin" : ""}`} />
                Проверить
              </Button>
              <Button
                variant="ghost"
                onClick={onDisconnect}
                disabled={busy !== null}
                className="text-muted-foreground hover:text-danger"
              >
                <Unplug className="mr-1.5 h-4 w-4" />
                Отключить
              </Button>
            </>
          )}
        </div>
      </Card>

      {/* ---- Уведомления клиентам. */}
      {/* Карточка «Тексты уведомлений» убрана из кабинета салона.

          Шаблоны подтверждения, напоминания, переноса и отмены — наши, они одинаковы для всех
          салонов, и Qabyl отправляет их на проверку в Meta сам при подключении канала. Владельцу
          здесь решать нечего: до подключения карточка честно писала «пока подключать нечего», а
          после подключения повторяла работу, которая уже сделана. */}

      <DiagnosticsBlock salonId={salonId} connected={status.connected} />

      {isSuperAdmin && <AdvancedBlock salonId={salonId} cfg={cfg} onChanged={reload} />}
    </div>
  );
}
