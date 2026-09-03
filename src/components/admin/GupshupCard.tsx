// Админка → вкладка WhatsApp → подключение через Gupshup.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН, а не поля в соседней карточке. Подключение через BSP — это не «ещё пара
// реквизитов», а другой порядок действий: часть шагов делается у нас, часть в кабинете Gupshup,
// часть в окне Meta. Владелец салона теряется не в полях, а в том, ЧТО СЕЙЧАС делать и что уже
// сделано. Поэтому экран построен как список шагов с живым состоянием, а не как форма.
//
// Всё, что можно сделать за владельца, делается кнопкой: подписки на события настраиваются одним
// нажатием вместо пяти полей в чужом кабинете, на каждый салон отдельно. Всё, чего сделать нельзя
// — окно Meta внутри попапа Facebook, — честно помечено как «делается вручную», а не спрятано.
//
// Ключ Gupshup сюда НЕ приходит: сервер отдаёт только маску. Экран настроек, с которого можно
// снять рабочий доступ скриншотом, — это тот недостаток соседней карточки, который здесь
// намеренно не повторён.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
} from "lucide-react";
import {
  getGupshupConfig,
  getGupshupDiagnostics,
  setGupshupEnabled,
  syncGupshupSubscriptions,
  testGupshupConnection,
  upsertGupshupConfig,
} from "@/lib/gupshup.functions";

type Config = Awaited<ReturnType<typeof getGupshupConfig>>;
type Diagnostics = Awaited<ReturnType<typeof getGupshupDiagnostics>>;

/** «12 минут назад» вместо ISO-строки: экран читает владелица салона, а не разработчик. */
function whenLabel(iso: string | null): string {
  if (!iso) return "никогда";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Значение, которое надо перенести в чужой интерфейс, — только читать и копировать. */
function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Не удалось скопировать — выделите и скопируйте вручную");
    }
  }
  return (
    <div className="space-y-1">
      <Label className="text-sm">{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="icon" onClick={copy} disabled={!value}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

type StepState = "done" | "todo" | "blocked";

/**
 * Один шаг подключения.
 *
 * Состояний три, а не два: «сделано» и «не сделано» не различают шаг, до которого просто ещё не
 * дошли, и шаг, который сделать НЕЛЬЗЯ, пока не закрыт предыдущий. Без этого различия владелец
 * жмёт кнопку, получает отказ и решает, что сломалось.
 */
function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={
            state === "done"
              ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
              : state === "blocked"
                ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/40 text-primary"
          }
        >
          {state === "done" ? (
            <Check className="h-4 w-4" />
          ) : (
            <span className="text-xs font-medium tabular-nums">{n}</span>
          )}
        </div>
      </div>
      <div className={`min-w-0 flex-1 pb-5 ${state === "blocked" ? "opacity-55" : ""}`}>
        <div className="font-medium text-sm">{title}</div>
        <div className="mt-1 space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function GupshupCard({ salonId }: { salonId: string }) {
  const loadConfig = useServerFn(getGupshupConfig);
  const saveConfig = useServerFn(upsertGupshupConfig);
  const testConn = useServerFn(testGupshupConnection);
  const syncSubs = useServerFn(syncGupshupSubscriptions);
  const setEnabled = useServerFn(setGupshupEnabled);
  const loadDiag = useServerFn(getGupshupDiagnostics);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState(false);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);

  const [appId, setAppId] = useState("");
  const [appName, setAppName] = useState("");
  const [sourceNumber, setSourceNumber] = useState("");
  const [wabaId, setWabaId] = useState("");
  // Пустое поле означает «не менять». Настоящий ключ сюда никогда не приходит с сервера.
  const [apiKey, setApiKey] = useState("");
  const [subsOk, setSubsOk] = useState<boolean | null>(null);

  function applyConfig(c: Config) {
    setCfg(c);
    setAppId(c.app_id);
    setAppName(c.app_name);
    setSourceNumber(c.source_number);
    setWabaId(c.waba_id);
    setApiKey("");
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const c = await loadConfig({ data: { salonId } });
        if (!cancelled) applyConfig(c);
      } catch (e: any) {
        if (!cancelled) toast.error(e?.message ?? "Не удалось загрузить настройки Gupshup");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  async function refreshDiagnostics() {
    try {
      setDiag(await loadDiag({ data: { salonId } }));
    } catch {
      /* диагностика вспомогательная — молчим, чтобы не пугать красным на ровном месте */
    }
  }

  useEffect(() => {
    if (!loading) void refreshDiagnostics();
  }, [loading]);

  const hasCreds = Boolean(cfg?.has_api_key && appId && appName && sourceNumber);
  const enabled = Boolean(cfg?.enabled);

  async function onSave() {
    setSaving(true);
    try {
      await saveConfig({
        data: {
          salonId,
          app_id: appId || null,
          app_name: appName || null,
          source_number: sourceNumber || null,
          waba_id: wabaId || null,
          ...(apiKey ? { api_key: apiKey } : {}),
        },
      });
      const c = await loadConfig({ data: { salonId } });
      applyConfig(c);
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    try {
      const res = await testConn({ data: { salonId } });
      if (res.ok) {
        toast.success(
          res.templateCount > 0
            ? `Связь есть. Шаблонов в приложении: ${res.templateCount}`
            : "Связь есть. Шаблонов пока нет — сообщения вне 24 часов отправлять будет нечем",
          { duration: 8000 },
        );
      } else {
        toast.error(res.error, { duration: 12000 });
      }
      const c = await loadConfig({ data: { salonId } });
      applyConfig(c);
    } catch (e: any) {
      toast.error(e?.message ?? "Проверка не удалась");
    } finally {
      setTesting(false);
    }
  }

  async function onSync() {
    setSyncing(true);
    try {
      const res = await syncSubs({ data: { salonId } });
      setSubsOk(res.ok);
      if (res.ok) {
        const created = res.steps.filter((s) => s.ok && !s.existed && s.step !== "Список подписок");
        toast.success(
          created.length
            ? `Готово: ${created.map((s) => s.step.toLowerCase()).join(", ")}`
            : "Подписки уже были настроены верно",
          { duration: 8000 },
        );
      } else {
        const bad = res.steps.filter((s) => !s.ok);
        toast.error(bad.map((s) => `${s.step}: ${s.detail ?? "ошибка"}`).join("; "), {
          duration: 14000,
        });
      }
      void refreshDiagnostics();
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось настроить подписки");
    } finally {
      setSyncing(false);
    }
  }

  async function onToggle(next: boolean) {
    setToggling(true);
    try {
      const res = await setEnabled({ data: { salonId, enabled: next } });
      if (next) {
        const syncOk = (res as any).sync?.ok !== false;
        setSubsOk(syncOk);
        if (syncOk) toast.success("Канал включён, подписки настроены");
        else
          toast.warning(
            "Канал включён, но подписки настроить не удалось — нажмите «Настроить подписки» и посмотрите причину",
            { duration: 12000 },
          );
      } else {
        const removed = (res as any).removed ?? 0;
        setSubsOk(null);
        toast.success(
          removed > 0
            ? `Канал выключен, подписки сняты (${removed})`
            : "Канал выключен. Реквизиты сохранены — включить обратно можно одним переключателем",
        );
      }
      const c = await loadConfig({ data: { salonId } });
      applyConfig(c);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось переключить канал");
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return <Card className="p-6 text-sm text-muted-foreground">Загрузка настроек Gupshup…</Card>;
  }

  const gotEvent = Boolean(diag?.lastEventAt);
  const stepCreds: StepState = hasCreds ? "done" : "todo";
  const stepCoex: StepState = !hasCreds ? "blocked" : "todo";
  const stepSubs: StepState = !hasCreds ? "blocked" : subsOk ? "done" : "todo";
  const stepLive: StepState = !enabled ? "blocked" : gotEvent ? "done" : "todo";

  return (
    <div className="space-y-4">
      {/* ---- Состояние. Первым, потому что от него зависит смысл всего остального. */}
      <Card className="p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold flex items-center gap-2">
              <Plug className="h-4 w-4" />
              WhatsApp через Gupshup
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {enabled
                ? gotEvent
                  ? `Канал работает. Последнее событие — ${whenLabel(diag?.lastEventAt ?? null)}.`
                  : "Канал включён, но событий от Gupshup ещё не было. Если клиент уже писал — проверьте подписки на шаге 3."
                : hasCreds
                  ? "Реквизиты заполнены, канал выключен. Включите переключателем справа."
                  : "Не подключён. Заполните реквизиты ниже."}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {toggling && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <Switch checked={enabled} onCheckedChange={onToggle} disabled={toggling || !hasCreds} />
          </div>
        </div>

        {cfg?.last_error && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            {cfg.last_error}
            <span className="text-amber-700"> ({whenLabel(cfg.last_error_at)})</span>
          </div>
        )}
      </Card>

      {/* ---- Шаги. Порядок действий, а не набор полей. */}
      <Card className="p-6">
        <h3 className="font-semibold mb-4">Как подключить салон</h3>

        <Step n={1} state={stepCreds} title="Реквизиты приложения Gupshup">
          <p>
            Приложение на салон заводится вручную в кабинете Gupshup. Оттуда нужны App ID, имя
            приложения и API-ключ.
          </p>

          <div className="grid gap-3 sm:grid-cols-2 pt-1">
            <div className="space-y-1">
              <Label className="text-sm">App ID</Label>
              <Input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="9fac4661-6cdc-…"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Имя приложения</Label>
              <Input
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="QabylWA"
              />
              <p className="text-xs text-muted-foreground">
                По нему события находят салон. У каждого салона своё.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Номер салона</Label>
              <Input
                value={sourceNumber}
                onChange={(e) => setSourceNumber(e.target.value)}
                placeholder="+996 707 111 726"
              />
              <p className="text-xs text-muted-foreground">
                Можно с плюсом и пробелами — приведём сами.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">WABA ID (необязательно)</Label>
              <Input
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-sm">API-ключ</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg?.has_api_key ? `Сохранён: ${cfg.api_key_masked}` : "sk_…"}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {cfg?.has_api_key
                  ? "Ключ сохранён и наружу не отдаётся. Оставьте поле пустым, чтобы не менять его."
                  : "Открывает все приложения аккаунта Qabyl, поэтому хранится только на сервере и никогда не показывается целиком."}
              </p>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap pt-1">
            <Button onClick={onSave} disabled={saving} size="sm">
              {saving ? "Сохранение…" : "Сохранить"}
            </Button>
            <Button variant="outline" size="sm" onClick={onTest} disabled={testing || !hasCreds}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${testing ? "animate-spin" : ""}`} />
              Проверить связь
            </Button>
          </div>
        </Step>

        <Step n={2} state={stepCoex} title="Подключение номера — вручную у Meta">
          <p>
            Владелец салона проходит Coexistence в кабинете Gupshup: <em>Begin Go Live</em> → вход в
            Facebook → выбор бизнес-портфолио → номер → QR-код с телефона → передача истории.
            Приложение WhatsApp Business на телефоне при этом остаётся рабочим.
          </p>
          <p className="text-amber-700">
            Этот шаг автоматизировать нельзя: окно принадлежит Meta. Два места, где чаще всего
            спотыкаются — портфолио подставляется само и может оказаться ограниченным, а передачу
            истории предлагают ровно один раз и в течение суток после подключения.
          </p>
          <a
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            href="https://apps.gupshup.io/whatsapp/dashboard"
            target="_blank"
            rel="noreferrer noopener"
          >
            Открыть кабинет Gupshup <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Step>

        <Step n={3} state={stepSubs} title="Подписки на события — одной кнопкой">
          <p>
            Без подписки салон подключён и молчит: Gupshup принимает сообщения клиентов и никому не
            сообщает. Кнопка заводит обе нужные подписки и чинит их, если адрес разъехался.
          </p>
          <div className="pt-1">
            <CopyRow
              label="Адрес вебхука этого салона"
              value={cfg?.webhook_url ?? ""}
              hint="Пригодится, только если будете сверять настройку в кабинете Gupshup руками."
            />
          </div>
          <div className="pt-1">
            <Button variant="outline" size="sm" onClick={onSync} disabled={syncing || !hasCreds}>
              {syncing ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1.5" />
              )}
              Настроить подписки
            </Button>
          </div>
        </Step>

        <Step n={4} state={stepLive} title="Проверка живым сообщением">
          <p>
            Напишите салону с любого другого номера. Если ассистент ответил — канал работает
            целиком.
          </p>
          {diag && (
            <div className="rounded-md border p-3 space-y-1 text-xs">
              <div className="flex items-center gap-1.5">
                {gotEvent ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                Событий от Gupshup: {gotEvent ? whenLabel(diag.lastEventAt) : "не было"}
                {diag.lastEventType ? ` · ${diag.lastEventType}` : ""}
              </div>
              <div>Сообщений от клиентов: {whenLabel(diag.lastInboundAt)}</div>
              <div>Ответов ассистента: {whenLabel(diag.lastOutboundAt)}</div>
              <div>Диалогов на этом канале: {diag.conversationCount}</div>
              {diag.lastIssue && (
                <div className="text-amber-700 pt-1">
                  Последняя отклонённая доставка: {diag.lastIssue} ({whenLabel(diag.lastIssueAt)})
                </div>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={refreshDiagnostics} className="px-2">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Обновить
          </Button>
        </Step>
      </Card>
    </div>
  );
}
