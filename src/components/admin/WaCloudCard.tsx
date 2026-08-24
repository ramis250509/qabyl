// Admin panel → WhatsApp tab → the official Cloud API section.
//
// Deliberately NOT a separate top-level tab: WhatsApp is one channel with two possible transports,
// and splitting them across two tabs would let an owner configure Cloud API while never noticing the
// salon is still on Green-API (or the reverse). The provider switch is therefore the first thing on
// this screen, and everything below it describes the transport that switch selects.
//
// Like the Instagram tab, this is written for a salon owner rather than a developer: copy buttons on
// the two values that must be pasted into Meta, and a "check connection" button that calls Meta for
// real — without it the only way to discover a bad token is to notice clients being ignored.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, CheckCircle2, Copy, RefreshCw, ShieldCheck } from "lucide-react";
import {
  getWaCloudConfig,
  getWaCloudDiagnostics,
  setWaCloudTemplatesReady,
  setWaProvider,
  testWaCloudConnection,
  upsertWaCloudConfig,
} from "@/lib/wa-cloud.functions";

type Diagnostics = Awaited<ReturnType<typeof getWaCloudDiagnostics>>;
type TemplateMap = Record<string, { name?: string; lang?: string } | undefined>;

const KIND_LABELS: Record<string, string> = {
  confirmation: "Подтверждение записи",
  reminder: "Напоминание за 2 часа",
  reschedule: "Перенос записи",
  cancellation: "Отмена записи",
  owner_alert: "Уведомление владельцу",
};

// The placeholder contract from docs/WA-CLOUD-MIGRATION.md. Shown next to each field because the
// count must match the approved template EXACTLY — Meta answers 132000 otherwise, and the owner has
// no other way to know what we will send.
// Каждый вид получает СВОЙ список — они не взаимозаменяемы, и число плейсхолдеров у трёх из пяти
// разное. Напоминанию достаточно голого времени («сегодня в 19:30»), остальным нужна дата.
const KIND_PLACEHOLDERS: Record<string, string> = {
  confirmation: "{{1}} имя · {{2}} мастер · {{3}} услуга · {{4}} дата и время · {{5}} токен ссылки",
  reminder: "{{1}} имя · {{2}} время · {{3}} мастер · {{4}} токен ссылки",
  reschedule: "{{1}} имя · {{2}} новые дата и время · {{3}} мастер · {{4}} токен ссылки",
  cancellation: "{{1}} имя · {{2}} дата и время",
  owner_alert: "{{1}} клиент · {{2}} услуга · {{3}} мастер · {{4}} дата и время · {{5}} телефон",
};

function whenLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} ч назад`;
  return d.toLocaleString("ru-RU");
}

function diagnose(d: Diagnostics, isCloud: boolean) {
  if (!isCloud) {
    return {
      tone: "info" as const,
      title: "Салон работает через Green-API",
      body: "Cloud API можно настроить и проверить заранее — переключатель наверху ничего не меняет, пока вы его не тронете.",
    };
  }
  const issueAt = d.lastWebhookIssueAt ? new Date(d.lastWebhookIssueAt).getTime() : 0;
  const outAt = d.lastOutboundAt ? new Date(d.lastOutboundAt).getTime() : 0;

  // A recorded problem NEWER than the last successful reply outranks everything else: it is, by
  // definition, what went wrong most recently.
  if (issueAt && issueAt > outAt) {
    return {
      tone: "warn" as const,
      title: "Последняя ошибка",
      body: `${d.lastWebhookIssue ?? "причина не записана"} (${whenLabel(d.lastWebhookIssueAt)}).`,
    };
  }
  if (d.lastInboundAt && d.lastOutboundAt) {
    return {
      tone: "ok" as const,
      title: "Всё работает",
      body: `Последнее сообщение от клиента — ${whenLabel(d.lastInboundAt)}, последний ответ ассистента — ${whenLabel(d.lastOutboundAt)}.`,
    };
  }
  if (d.lastInboundAt) {
    return {
      tone: "warn" as const,
      title: "Сообщения приходят, но ответа не было",
      body: "Webhook работает — значит дело уже на нашей стороне. Напишите ещё раз и обновите: причина появится здесь же.",
    };
  }
  return {
    tone: "warn" as const,
    title: "От Meta не пришло ни одного сообщения",
    body: "Значит дело в настройке на стороне Meta, а не у нас. Проверьте: в разделе WhatsApp → Configuration подписано поле messages (и smb_message_echoes, если номер остаётся в приложении WhatsApp Business); Callback URL и Verify Token совпадают с указанными ниже; номер добавлен в приложение.",
  };
}

function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
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
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2 mt-1">
        <Input
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" size="icon" onClick={copy} title="Скопировать">
          {copied ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

export function WaCloudCard({ salonId }: { salonId: string }) {
  const loadConfig = useServerFn(getWaCloudConfig);
  const saveConfig = useServerFn(upsertWaCloudConfig);
  const switchProvider = useServerFn(setWaProvider);
  const setTemplatesReady = useServerFn(setWaCloudTemplatesReady);
  const testConnection = useServerFn(testWaCloudConnection);
  const loadDiagnostics = useServerFn(getWaCloudDiagnostics);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const [provider, setProvider] = useState<"green_api" | "cloud">("green_api");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [templates, setTemplates] = useState<TemplateMap>({});
  const [templatesReady, setTemplatesReadyState] = useState(false);
  const [hasGreenApi, setHasGreenApi] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [diag, setDiag] = useState<Diagnostics | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadConfig({ data: { salonId } });
        if (cancelled) return;
        setProvider(cfg.provider);
        setPhoneNumberId(cfg.phone_number_id);
        setToken(cfg.token);
        setAppSecret(cfg.app_secret);
        setWabaId(cfg.waba_id);
        setTemplates(cfg.templates ?? {});
        setTemplatesReadyState(cfg.templates_ready);
        setHasGreenApi(cfg.has_green_api);
        setKinds(cfg.template_kinds ?? []);
        setWebhookUrl(cfg.webhook_url);
        setVerifyToken(cfg.verify_token);
      } catch (e: any) {
        if (!cancelled) toast.error(e?.message ?? "Не удалось загрузить настройки Cloud API");
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
      setDiag(await loadDiagnostics({ data: { salonId } }));
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось загрузить диагностику");
    }
  }

  useEffect(() => {
    if (!loading) void refreshDiagnostics();
  }, [loading, provider]);

  async function onSave() {
    setSaving(true);
    try {
      await saveConfig({
        data: {
          salonId,
          phone_number_id: phoneNumberId || null,
          token: token || null,
          app_secret: appSecret || null,
          waba_id: wabaId || null,
          templates: templates as any,
        },
      });
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function onSwitchProvider(toCloud: boolean) {
    const next = toCloud ? "cloud" : "green_api";
    setBusy(true);
    const prev = provider;
    setProvider(next);
    try {
      const res = await switchProvider({ data: { salonId, provider: next } });
      toast.success(
        next === "cloud"
          ? "Салон переключён на официальный Cloud API"
          : "Салон возвращён на Green-API",
      );
      for (const w of res.warnings ?? []) toast.warning(w, { duration: 12000 });
    } catch (e: any) {
      setProvider(prev);
      toast.error(e?.message ?? "Не удалось переключить провайдера");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleTemplatesReady(next: boolean) {
    setBusy(true);
    const prev = templatesReady;
    setTemplatesReadyState(next);
    try {
      await setTemplatesReady({ data: { salonId, ready: next } });
      toast.success(
        next
          ? "Шаблоны отмечены как одобренные — сообщения вне окна 24 ч пойдут через них"
          : "Сообщения вне окна 24 ч снова пойдут через Green-API",
      );
    } catch (e: any) {
      setTemplatesReadyState(prev);
      toast.error(e?.message ?? "Не удалось изменить настройку");
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setTesting(true);
    try {
      const res = await testConnection({ data: { salonId } });
      if (res.ok) {
        toast.success(
          `Подключение работает: ${res.phone ?? "номер"}${res.name ? ` (${res.name})` : ""}${
            res.quality ? ` · качество ${res.quality}` : ""
          }`,
          { duration: 10000 },
        );
      } else {
        toast.error(res.error, { duration: 12000 });
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Проверка не удалась");
    } finally {
      setTesting(false);
    }
  }

  function setTemplate(kind: string, patch: { name?: string; lang?: string }) {
    setTemplates((t) => ({ ...t, [kind]: { ...(t[kind] ?? {}), ...patch } }));
  }

  if (loading) {
    return <Card className="p-6 text-sm text-muted-foreground">Загрузка настроек Cloud API…</Card>;
  }

  const isCloud = provider === "cloud";
  const d = diag ? diagnose(diag, isCloud) : null;

  return (
    <div className="space-y-4">
      {/* ---- The switch itself. First, because everything below depends on it. */}
      <Card className="p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Официальный WhatsApp Cloud API
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isCloud
                ? "Салон принимает и отправляет сообщения через официальный API Meta."
                : "Салон работает через Green-API. Настройте поля ниже, проверьте подключение — и только потом переключайте."}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Green-API остаётся подключённым и служит путём отката: вернуть переключатель обратно
              можно в любой момент, без потери истории диалогов.
            </p>
          </div>
          <Switch checked={isCloud} onCheckedChange={onSwitchProvider} disabled={busy} />
        </div>

        {isCloud && !hasGreenApi && !templatesReady && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Green-API отключён, а шаблоны Meta ещё не одобрены. Напоминания, перенос и отмена не
            дойдут до клиентов, которые писали больше 24 часов назад.
          </div>
        )}
      </Card>

      {/* ---- Credentials. */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-semibold">Учётные данные</h3>
          <p className="text-sm text-muted-foreground">
            Meta Business Settings → WhatsApp Accounts. Токен нужен постоянный, от системного
            пользователя, с правом whatsapp_business_messaging.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Phone Number ID</Label>
            <Input
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="106540352242922"
              className="font-mono text-xs mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Это <b>идентификатор</b> номера из панели Meta, а не сам номер телефона.
            </p>
          </div>
          <div>
            <Label>WhatsApp Business Account ID</Label>
            <Input
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
              placeholder="необязательно"
              className="font-mono text-xs mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Для отправки не нужен — пригодится для шаблонов и обращений в поддержку.
            </p>
          </div>
        </div>

        <div>
          <Label>Access Token</Label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAG…"
            className="font-mono text-xs mt-1"
          />
        </div>

        <div>
          <Label>App Secret</Label>
          <Input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="Meta App → Settings → Basic → App Secret"
            className="font-mono text-xs mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Обязателен. Подпись по нему — единственная защита входящего вебхука; без него все
            сообщения от Meta отклоняются.
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
          <Button variant="outline" onClick={onTest} disabled={testing}>
            {testing ? "Проверяем…" : "Проверить подключение"}
          </Button>
        </div>
      </Card>

      {/* ---- What must be pasted into Meta. */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-semibold">Настройка вебхука в Meta</h3>
          <p className="text-sm text-muted-foreground">
            Meta App → WhatsApp → Configuration. Подпишите поле <b>messages</b>. Если номер остаётся
            рабочим и в приложении WhatsApp Business, подпишите также <b>smb_message_echoes</b> — по
            нему ассистент понимает, что вы ответили клиенту сами, и замолкает.
          </p>
        </div>
        <CopyField label="Callback URL" value={webhookUrl} hint="Вставьте в поле «Callback URL»." />
        <CopyField
          label="Verify Token"
          value={verifyToken}
          hint="Вставьте в поле «Verify token». Сгенерирован автоматически, менять не нужно."
        />
      </Card>

      {/* ---- Templates. */}
      <Card className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Шаблоны для сообщений вне окна 24 часов</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Meta разрешает свободный текст только 24 часа с последнего сообщения клиента. Дальше —
              только одобренный шаблон. Пока переключатель выключен, такие сообщения продолжают
              уходить через Green-API.
            </p>
          </div>
          <Switch
            checked={templatesReady}
            onCheckedChange={onToggleTemplatesReady}
            disabled={busy}
          />
        </div>

        <div className="space-y-3">
          {kinds.map((kind) => (
            <div key={kind} className="grid gap-2 sm:grid-cols-[1fr_6rem] sm:items-end">
              <div>
                <Label className="text-sm">{KIND_LABELS[kind] ?? kind}</Label>
                <Input
                  value={templates[kind]?.name ?? ""}
                  onChange={(e) => setTemplate(kind, { name: e.target.value })}
                  placeholder="имя одобренного шаблона"
                  className="font-mono text-xs mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1 font-mono">
                  {KIND_PLACEHOLDERS[kind]}
                </p>
              </div>
              <div>
                <Label className="text-xs">Язык</Label>
                <Input
                  value={templates[kind]?.lang ?? ""}
                  onChange={(e) => setTemplate(kind, { lang: e.target.value })}
                  placeholder="ru"
                  className="font-mono text-xs mt-1"
                />
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Число плейсхолдеров в одобренном шаблоне должно совпадать с указанным под каждым полем —
          иначе Meta отклонит отправку с кодом 132000.
        </p>
        {/* Тот же onSave, что и в карточке учётных данных: он сохраняет и креды, и шаблоны одним
            запросом. Кнопка продублирована здесь потому, что владелец заполняет пять полей и ищет
            «Сохранить» под ними, а не парой экранов выше — переключатель при этом требует уже
            сохранённые имена и без сохранения отказывает. */}
        <div>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить шаблоны"}
          </Button>
        </div>
      </Card>

      {/* ---- Diagnostics. */}
      <Card className="p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">Диагностика</h3>
          <Button variant="outline" size="sm" onClick={refreshDiagnostics}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Обновить
          </Button>
        </div>
        {d && (
          <div
            className={`rounded-md border p-3 text-sm ${
              d.tone === "ok"
                ? "border-green-300 bg-green-50 text-green-900"
                : d.tone === "warn"
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-border bg-muted/40"
            }`}
          >
            <p className="font-medium">{d.title}</p>
            <p className="mt-1">{d.body}</p>
          </div>
        )}
        {diag && (
          <p className="text-xs text-muted-foreground">
            Диалогов на Cloud API: {diag.conversationCount}
          </p>
        )}
      </Card>
    </div>
  );
}
