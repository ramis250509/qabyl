// Admin panel → WhatsApp tab → the official Cloud API section.
//
// Транспорт теперь один: Green-API удалён, переключателя провайдера больше нет. Экран отвечает на
// два вопроса владельца — подключён ли WhatsApp и почему ассистент молчит, если подключён.
//
// Написан для владельца салона, а не разработчика: «проверить подключение» реально ходит в Meta,
// потому что иначе о протухшем токене узнают по молчанию ассистента.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  getWaCloudConfig,
  getWaCloudDiagnostics,
  setWaCloudTemplatesReady,
  testWaCloudConnection,
  upsertWaCloudConfig,
} from "@/lib/wa-cloud.functions";
import { createWaTemplates, finishWaOnboarding } from "@/lib/wa-onboarding.functions";
import { WaConnectButton } from "@/components/admin/WaConnectButton";

type Diagnostics = Awaited<ReturnType<typeof getWaCloudDiagnostics>>;
type TemplateMap = Record<string, { name?: string; lang?: string } | undefined>;

const KIND_LABELS: Record<string, string> = {
  confirmation: "Подтверждение записи",
  reminder: "Напоминание за 2 часа",
  reschedule: "Перенос записи",
  cancellation: "Отмена записи",
  owner_alert: "Уведомление владельцу",
  owner_change: "Клиент сам перенёс или отменил",
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
  owner_change: "{{1}} клиент · {{2}} что изменилось · {{3}} услуга · {{4}} мастер",
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

function diagnose(d: Diagnostics, connected: boolean) {
  if (!connected) {
    return {
      tone: "warn" as const,
      title: "WhatsApp не подключён",
      body: "Нажмите «Подключить WhatsApp» выше. Пока канал не подключён, сообщения клиентов не доходят, а подтверждения и напоминания не отправляются.",
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
    body: "Значит Meta до нас не достучалась. Если салон подключали кнопкой выше — попробуйте «Переподключить WhatsApp»: подписка на вебхуки оформляется именно в этот момент, и её мог оборвать закрытый раньше времени попап.",
  };
}

export function WaCloudCard({ salonId }: { salonId: string }) {
  const loadConfig = useServerFn(getWaCloudConfig);
  const saveConfig = useServerFn(upsertWaCloudConfig);
  const setTemplatesReady = useServerFn(setWaCloudTemplatesReady);
  const testConnection = useServerFn(testWaCloudConnection);
  const loadDiagnostics = useServerFn(getWaCloudDiagnostics);
  const onboard = useServerFn(finishWaOnboarding);
  const makeTemplates = useServerFn(createWaTemplates);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [makingTemplates, setMakingTemplates] = useState(false);
  // Имена шаблонов свёрнуты по умолчанию: владелица салона не знает и не должна знать, что такое
  // booking_confirmation. Кнопка заводит их сама и вписывает имена — поля нужны только когда
  // что-то пошло не так и мы разбираемся вместе с ней.
  const [showTemplateNames, setShowTemplateNames] = useState(false);
  // Ручной ввод реквизитов. Кнопка подключения закрывает 99% случаев, но не все: Embedded Signup
  // недоступен тому, чьё портфолио владеет приложением, и салону, подключённому через отдельное
  // приложение Meta. Без этих полей такой салон не подключить вообще ничем, кроме доступа к базе.
  const [showManual, setShowManual] = useState(false);

  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [templates, setTemplates] = useState<TemplateMap>({});
  const [templatesReady, setTemplatesReadyState] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadConfig({ data: { salonId } });
        if (cancelled) return;
        setPhoneNumberId(cfg.phone_number_id);
        setToken(cfg.token);
        setAppSecret(cfg.app_secret);
        setWabaId(cfg.waba_id);
        setTemplates(cfg.templates ?? {});
        setTemplatesReadyState(cfg.templates_ready);
        setKinds(cfg.template_kinds ?? []);
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
  }, [loading]);

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

  // Салон считается подключённым по паре «номер + токен»: именно их требует отправка. WABA ID
  // сам по себе ничего не открывает, поэтому судить по нему было бы враньём.
  const connected = Boolean(phoneNumberId && token);

  async function onConnected(v: { code: string; wabaId: string; phoneNumberId: string }) {
    setBusy(true);
    try {
      const res = await onboard({ data: { salonId, ...v } });
      const failed = res.steps.filter((s) => !s.ok);
      if (failed.length === 0) {
        toast.success("WhatsApp подключён, шаблоны созданы");
      } else {
        // Подключение состоялось — молчать о недоделанном нельзя, но и пугать красным незачем.
        toast.warning(`Подключено, но не всё: ${failed.map((f) => f.detail ?? f.step).join("; ")}`);
      }
      const cfg = await loadConfig({ data: { salonId } });
      setPhoneNumberId(cfg.phone_number_id);
      setToken(cfg.token);
      setAppSecret(cfg.app_secret);
      setWabaId(cfg.waba_id);
      setTemplates(cfg.templates ?? {});
      setTemplatesReadyState(cfg.templates_ready);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось завершить подключение");
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

  // Создать пять шаблонов на уже подключённом салоне. До этой кнопки они заводились ровно один
  // раз — при подключении, — и отклонённый Meta шаблон чинился только переподключением салона.
  async function onCreateTemplates() {
    setMakingTemplates(true);
    try {
      const res = await makeTemplates({ data: { salonId } });
      const failed = res.steps.filter((s) => !s.ok);
      // Считаем отдельно: «создано 6» и «всё уже было» — разные новости, и владелец, нажавший
      // кнопку второй раз, должен видеть вторую, а не подозревать, что шаблоны переписались.
      const created = res.steps.filter((s) => s.ok && !s.existed).length;
      const existed = res.steps.filter((s) => s.ok && s.existed).length;
      if (failed.length === 0) {
        toast.success(
          created === 0
            ? `Все шаблоны уже заведены (${existed}) — создавать нечего`
            : `Создано шаблонов: ${created}${existed ? `, уже было: ${existed}` : ""}. Отправлены на модерацию Meta`,
        );
      } else {
        // Частичный успех — самый частый исход: часть шаблонов уже существует, часть отклонена.
        // Называем именно отказавшие, иначе владельцу нечего показать поддержке.
        toast.warning(
          `Создано не всё: ${failed.map((f) => `${f.step} — ${f.detail ?? "отклонён"}`).join("; ")}`,
          { duration: 12000 },
        );
      }
      // Имена шаблонов пишутся на сервере, поэтому форму перечитываем, а не правим на месте.
      const cfg = await loadConfig({ data: { salonId } });
      setTemplates(cfg.templates ?? {});
      setTemplatesReadyState(cfg.templates_ready);
      setKinds(cfg.template_kinds ?? []);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось создать шаблоны", { duration: 10000 });
    } finally {
      setMakingTemplates(false);
    }
  }

  function setTemplate(kind: string, patch: { name?: string; lang?: string }) {
    setTemplates((t) => ({ ...t, [kind]: { ...(t[kind] ?? {}), ...patch } }));
  }

  if (loading) {
    return <Card className="p-6 text-sm text-muted-foreground">Загрузка настроек Cloud API…</Card>;
  }

  const d = diag ? diagnose(diag, connected) : null;

  return (
    <div className="space-y-4">
      {/* ---- Состояние канала. Первым, потому что от него зависит всё остальное. */}
      <Card className="p-6 space-y-3">
        <div className="min-w-0">
          <h2 className="font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Официальный WhatsApp Cloud API
          </h2>
          {/* Переключателя провайдера здесь больше нет: Green-API удалён, выбирать не из чего.
              Салон либо подключён официально, либо не подключён вовсе — и второе надо говорить
              прямо, а не прятать за «настройте поля ниже». */}
          <p className="text-sm text-muted-foreground mt-0.5">
            {connected
              ? "Салон принимает и отправляет сообщения через официальный API Meta."
              : "WhatsApp не подключён. Клиенты, которые пишут салону, остаются без ответа, а подтверждения и напоминания не отправляются."}
          </p>
        </div>

        {connected && !templatesReady && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Шаблоны Meta ещё не одобрены. Внутри 24 часов после сообщения клиента ассистент отвечает
            свободно, но напоминания, перенос и отмена не дойдут до тех, кто писал давно.
          </div>
        )}
      </Card>

      {/* ---- Credentials. */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="font-semibold">Подключение</h3>
          <p className="text-sm text-muted-foreground">
            Одна кнопка вместо кабинета Meta: владелец входит в свой Facebook, подтверждает номер, и
            всё остальное — токен, подписка на вебхуки, пять шаблонов уведомлений — настраивается
            само. Приложение WhatsApp Business на телефоне при этом остаётся рабочим.
          </p>
        </div>

        {connected ? (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <div className="font-medium">WhatsApp подключён</div>
            <div className="text-muted-foreground font-mono text-xs">
              Номер: {phoneNumberId || "—"}
            </div>
            <div className="text-muted-foreground font-mono text-xs">Аккаунт: {wabaId || "—"}</div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Пока не подключён. Клиенты пишут через прежний транспорт.
          </p>
        )}

        <div className="flex gap-2 flex-wrap items-center">
          <WaConnectButton connected={connected} onConnected={onConnected} />
          <Button variant="outline" onClick={onTest} disabled={testing}>
            {testing ? "Проверяем…" : "Проверить подключение"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowManual((v) => !v)}
            className="text-muted-foreground"
          >
            {showManual ? "Скрыть ручной ввод" : "Подключить вручную"}
          </Button>
        </div>

        {showManual && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">
              Запасной путь для случаев, когда кнопка выше не подходит: номер заведён через
              отдельное приложение Meta или окно подключения недоступно. Значения берутся в панели
              приложения Meta, раздел WhatsApp → API Setup.
            </p>
            <div>
              <Label className="text-sm">ID номера (Phone Number ID)</Label>
              <Input
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="1152652971275812"
                className="font-mono text-xs mt-1"
              />
            </div>
            <div>
              <Label className="text-sm">ID аккаунта WhatsApp (WABA ID)</Label>
              <Input
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="1032772542716543"
                className="font-mono text-xs mt-1"
              />
            </div>
            <div>
              <Label className="text-sm">Токен доступа</Label>
              {/* type=password: токен даёт полный доступ к переписке салона, и он остаётся на
                  экране, пока владелец ходит по вкладкам. */}
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="EAAG…"
                className="font-mono text-xs mt-1"
              />
            </div>
            <div>
              <Label className="text-sm">App Secret приложения</Label>
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="оставьте пустым"
                className="font-mono text-xs mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Нужен, только если салон подключён через СВОЁ приложение Meta. При подключении через
                Qabyl оставьте пустым — подпись вебхука проверяется общим секретом платформы.
              </p>
            </div>
            <Button onClick={onSave} disabled={saving}>
              {saving ? "Сохранение…" : "Сохранить реквизиты"}
            </Button>
          </div>
        )}
      </Card>

      {/* ---- Templates. */}
      <Card className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Шаблоны для сообщений вне окна 24 часов</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Meta разрешает свободный текст только 24 часа с последнего сообщения клиента. Дальше
              проходят лишь заранее одобренные шаблоны: подтверждение записи, напоминание, перенос,
              отмена и уведомления вам. Нажмите кнопку ниже, и мы заведём их сами.
            </p>
          </div>
          <Switch
            checked={templatesReady}
            onCheckedChange={onToggleTemplatesReady}
            disabled={busy}
          />
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <Button
            onClick={onCreateTemplates}
            disabled={makingTemplates || !connected}
            title={
              connected
                ? undefined
                : "Сначала подключите WhatsApp — шаблоны создаются на аккаунте салона"
            }
          >
            {makingTemplates ? "Создаём…" : "Создать шаблоны"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTemplateNames((v) => !v)}
            className="text-muted-foreground"
          >
            {showTemplateNames ? "Скрыть имена шаблонов" : "Дополнительно: имена шаблонов"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Уже существующие шаблоны пропускаются, так что нажимать повторно безопасно. Модерация у
          Meta обычно занимает несколько минут.
        </p>

        {/* Свёрнуто по умолчанию. Владелица салона не знает, что такое booking_confirmation, и
            заставлять её на это смотреть — значит показывать поле, в которое она может только
            вписать ошибку. Кнопка выше заполняет эти имена сама. */}
        {showTemplateNames && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">
              Здесь видно, какими именами мы отправляем каждое уведомление. Менять их нужно, только
              если шаблоны заводились вручную в кабинете Meta под другими названиями. Кнопка
              «Создать шаблоны» перезапишет эти поля своими именами.
            </p>
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
            <p className="text-xs text-muted-foreground">
              Число плейсхолдеров в одобренном шаблоне должно совпадать с указанным под каждым полем
              — иначе Meta отклонит отправку с кодом 132000.
            </p>
            {/* Тот же onSave, что и в карточке учётных данных: он сохраняет и креды, и шаблоны одним
              запросом. Кнопка продублирована здесь потому, что владелец правит поля тут, а не
              парой экранов выше — переключатель при этом требует уже сохранённые имена. */}
            <div>
              <Button onClick={onSave} disabled={saving}>
                {saving ? "Сохранение…" : "Сохранить имена"}
              </Button>
            </div>
          </div>
        )}
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
