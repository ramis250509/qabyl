// Admin panel → Instagram tab: connect the salon's Instagram Direct to the AI admin.
//
// The whole point of this screen is that a salon owner — not a developer — has to complete a Meta
// app setup. So it is written as a numbered walkthrough with copy buttons on the two values that
// must be pasted into Meta (webhook URL and verify token), and a "check connection" button that
// calls Meta for real. Without that last button the only way to discover a bad token is to notice
// that clients are being ignored.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Copy, CheckCircle2, AlertCircle, Instagram, ExternalLink } from "lucide-react";
import {
  getInstagramConfig,
  setInstagramEnabled,
  testInstagramConnection,
  upsertInstagramConfig,
} from "@/lib/instagram.functions";

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "ok";
      username: string | null;
      accountId: string | null;
      accountType: string | null;
      // The account ID was read back from Meta and saved for the owner, rather than typed in.
      autofilledId?: boolean;
    }
  | { kind: "error"; message: string };

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
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" size="icon" onClick={copy} title="Скопировать">
          {copied ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

export function InstagramTab({ salonId, salonName }: { salonId: string; salonName?: string }) {
  const load = useServerFn(getInstagramConfig);
  const save = useServerFn(upsertInstagramConfig);
  const setEnabled = useServerFn(setInstagramEnabled);
  const test = useServerFn(testInstagramConnection);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [userId, setUserId] = useState("");
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await load({ data: { salonId } });
        if (cancelled) return;
        setUserId(cfg.instagram_user_id ?? "");
        setToken(cfg.instagram_token ?? "");
        setAppSecret(cfg.instagram_app_secret ?? "");
        setWebhookUrl(cfg.webhook_url);
        setVerifyToken(cfg.verify_token);
        setEnabledState(cfg.enabled);
      } catch (e: any) {
        if (!cancelled) toast.error(e.message ?? "Не удалось загрузить настройки Instagram");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  /**
   * Turn a connection-check result into UI state — and, when the check succeeded while the account
   * ID field is still empty, fill it in and persist it.
   *
   * Meta shows the Instagram account ID in a different place from the token, so making the owner
   * hunt for it is a pointless extra step: the token itself already identifies the account, and the
   * check reads it back from /me. Saving it here is what lets the channel be switched on, since
   * enabling requires all three credentials.
   */
  async function applyTestResult(res: Awaited<ReturnType<typeof test>>) {
    if (!res.ok) {
      setTestState({ kind: "error", message: res.error });
      return;
    }
    let autofilled = false;
    if (!userId.trim() && res.accountId) {
      setUserId(res.accountId);
      autofilled = true;
      try {
        await save({
          data: {
            salonId,
            instagram_user_id: res.accountId,
            instagram_token: token.trim() || null,
            instagram_app_secret: appSecret.trim() || null,
          },
        });
      } catch {
        // Non-fatal: the field is filled on screen, the owner can still press "Сохранить".
        autofilled = false;
      }
    }
    setTestState({
      kind: "ok",
      username: res.username ?? null,
      accountId: res.accountId ?? null,
      accountType: res.accountType ?? null,
      autofilledId: autofilled,
    });
  }

  async function onSave() {
    setSaving(true);
    try {
      await save({
        data: {
          salonId,
          instagram_user_id: userId.trim() || null,
          instagram_token: token.trim() || null,
          instagram_app_secret: appSecret.trim() || null,
        },
      });
      // A saved token is almost always followed by "did it work?" — answer it without a second click.
      setTestState({ kind: "running" });
      await applyTestResult(await test({ data: { salonId } }));
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(e.message ?? "Не удалось сохранить");
      setTestState({ kind: "idle" });
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTestState({ kind: "running" });
    try {
      await applyTestResult(await test({ data: { salonId } }));
    } catch (e: any) {
      setTestState({ kind: "error", message: e.message ?? "Проверка не удалась" });
    }
  }

  async function onToggle(next: boolean) {
    setTogglingEnabled(true);
    const prev = enabled;
    setEnabledState(next);
    try {
      await setEnabled({ data: { salonId, enabled: next } });
      toast.success(next ? "ИИ-Админ отвечает в Instagram Direct" : "Instagram отключён");
    } catch (e: any) {
      setEnabledState(prev);
      toast.error(e.message ?? "Не удалось переключить");
    } finally {
      setTogglingEnabled(false);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold flex items-center gap-2">
              <Instagram className="h-4 w-4" />
              ИИ-Админ в Instagram Direct
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Тот же ассистент, что отвечает в WhatsApp: консультирует, показывает свободные окна и
              записывает клиентов прямо в переписке Instagram. Настройки ассистента (услуги, тон,
              база знаний) — общие, отдельно настраивать не нужно.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Переписка Instagram через официальный API Meta — бесплатна. Платить нужно только за
              работу самого ИИ, как и в WhatsApp.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={loading || togglingEnabled}
          />
        </div>
        {!loading && !enabled && (
          <p className="text-xs text-amber-700">
            Канал выключен — сообщения из Instagram не обрабатываются. Включите после того, как
            заполните данные ниже и проверка связи пройдёт успешно.
          </p>
        )}
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-semibold">Шаг 1. Подготовьте аккаунт</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Instagram-аккаунт{salonName ? ` салона «${salonName}»` : ""} должен быть
            профессиональным: в приложении Instagram — «Настройки» → «Тип аккаунта и инструменты» →
            «Переключиться на профессиональный аккаунт» (Бизнес или Автор). В личном аккаунте API
            переписки не работает.
          </p>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-semibold">Шаг 2. Создайте приложение в Meta</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Откройте{" "}
            <a
              className="underline inline-flex items-center gap-1"
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              developers.facebook.com/apps
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            → «Создать приложение» → продукт <b>Instagram</b> → <b>«API setup with Instagram
            login»</b> (именно этот пункт, не «with Facebook login»). Там подключите свой
            Instagram-аккаунт и сгенерируйте токен доступа с правами{" "}
            <code className="text-xs">instagram_business_basic</code> и{" "}
            <code className="text-xs">instagram_business_manage_messages</code>.
          </p>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-semibold">Шаг 3. Пропишите webhook в Meta</h2>
          <p className="text-sm text-muted-foreground mt-1">
            В приложении Meta: Instagram → «Configure webhooks». Скопируйте туда эти два значения и
            подпишитесь на поле <code className="text-xs">messages</code>.
          </p>
        </div>
        <CopyField label="Callback URL" value={webhookUrl} hint="Вставьте в поле «Callback URL»." />
        <CopyField
          label="Verify Token"
          value={verifyToken}
          hint="Вставьте в поле «Verify token». Это значение придумано нами — в Meta его нужно просто скопировать."
        />
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-semibold">Шаг 4. Введите данные приложения</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Эти три значения берутся из того же приложения Meta. Они хранятся только на сервере и
            никогда не показываются клиентам.
          </p>
        </div>

        <div>
          <Label>Instagram account ID</Label>
          <Input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="17841400000000000"
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Можно не заполнять: заполните токен и нажмите «Сохранить и проверить» — ID подставится
            сам. Вручную его можно взять в Meta → Instagram → API setup with Instagram login, в
            строке подключённого аккаунта.
          </p>
        </div>

        <div>
          <Label>Access Token</Label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="IGAAxxxxxxxx..."
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Meta → Instagram → <b>API setup with Instagram login</b> → блок «Generate access
            tokens» → кнопка «Generate token» напротив вашего аккаунта. Действует 60 дней — после
            этого сгенерируйте заново и вставьте сюда, иначе ассистент перестанет отвечать в
            Instagram.
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Не подходит токен из «API setup with <b>Facebook</b> login» — это другой тип токена, с
            ним переписка работать не будет.
          </p>
        </div>

        <div>
          <Label>App Secret</Label>
          <Input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="••••••••••••••••"
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Meta → «Настройки приложения» → «Основное» → «Секрет приложения». Нужен, чтобы никто
            посторонний не мог отправлять поддельные сообщения на ваш webhook.
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button onClick={onSave} disabled={saving || loading}>
            {saving ? "..." : "Сохранить и проверить"}
          </Button>
          <Button variant="outline" onClick={onTest} disabled={loading || testState.kind === "running"}>
            {testState.kind === "running" ? "Проверяем..." : "Проверить связь"}
          </Button>
        </div>

        {testState.kind === "ok" && (
          <div className="flex items-start gap-2 text-sm text-green-700 bg-green-50 rounded-md p-3">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              Связь с Instagram установлена
              {testState.username ? (
                <>
                  {" "}
                  — аккаунт <b>@{testState.username}</b>
                </>
              ) : null}
              {testState.accountType ? ` (${testState.accountType})` : null}.
              {testState.autofilledId && " Instagram account ID подставлен автоматически."}
              {!enabled && " Осталось включить канал переключателем вверху."}
            </div>
          </div>
        )}
        {testState.kind === "error" && (
          <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-md p-3">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>{testState.message}</div>
          </div>
        )}
      </Card>

      <Card className="p-6 space-y-2">
        <h2 className="font-semibold">Как это работает у клиента</h2>
        <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-4">
          <li>Клиент пишет в Direct — ассистент отвечает сам, на языке клиента.</li>
          <li>
            В Instagram нет номера телефона, поэтому перед оформлением записи ассистент один раз
            попросит номер — он нужен мастеру для связи и напоминания.
          </li>
          <li>
            Если вы отвечаете клиенту вручную из приложения Instagram, ассистент замолкает на 5
            минут, чтобы не перебивать вас.
          </li>
          <li>
            Когда ассистент не может помочь, он передаёт диалог вам и присылает уведомление —
            туда же, куда приходят уведомления по WhatsApp.
          </li>
        </ul>
      </Card>
    </div>
  );
}
