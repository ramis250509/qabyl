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
import { humanError } from "@/lib/human-error";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Copy, CheckCircle2, AlertCircle, Instagram, ExternalLink, RefreshCw } from "lucide-react";
import {
  deleteCommentTrigger,
  getInstagramConfig,
  getInstagramDiagnostics,
  listCommentTriggers,
  setInstagramEnabled,
  testInstagramConnection,
  upsertCommentTrigger,
  upsertInstagramConfig,
} from "@/lib/instagram.functions";
import { Textarea } from "@/components/ui/textarea";

type Diagnostics = Awaited<ReturnType<typeof getInstagramDiagnostics>>;

function whenLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} ч назад`;
  return d.toLocaleString("ru-RU");
}

/**
 * Turn the raw traces into the sentence the salon actually needs. The ordering matters: a webhook
 * that never arrived is a Meta-side problem and no amount of fiddling on our side will fix it, so
 * that case must not be buried under "everything looks configured".
 */
function diagnose(d: Diagnostics, enabled: boolean) {
  const issueAt = d.lastWebhookIssueAt ? new Date(d.lastWebhookIssueAt).getTime() : 0;
  const outAt = d.lastOutboundAt ? new Date(d.lastOutboundAt).getTime() : 0;

  // A recorded problem that is NEWER than the last successful reply outranks everything else: it
  // is, by definition, what went wrong most recently. Meta's own wording is passed straight
  // through — "code=190 …" says "the token expired", and nothing we could paraphrase says it better.
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
      body: enabled
        ? "Webhook работает — значит дело уже на нашей стороне. Напишите ещё раз и обновите: причина появится здесь же."
        : "Канал выключен переключателем вверху — включите его.",
    };
  }
  return {
    tone: "warn" as const,
    title: "От Meta не пришло ни одного сообщения",
    body: "Значит дело в настройке на стороне Meta, а не у нас. Проверьте по порядку: приложение опубликовано (в режиме Development Meta шлёт события только от аккаунтов с ролью в приложении — добавьте пишущий аккаунт как Instagram Tester и примите приглашение в самом Instagram); в разделе webhooks подписано поле messages; Callback URL и Verify Token совпадают с указанными выше.",
  };
}

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
      // The stored ID differs from what /me returned. Harmless — the same account has two ids —
      // but worth surfacing so a genuinely wrong ID is still noticeable.
      idMismatch?: boolean;
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

type TriggerRow = {
  id: string;
  keyword: string;
  match_mode: "exact" | "contains";
  media_id: string | null;
  reply_text: string;
  public_reply: string | null;
  ai_context: string | null;
  enabled: boolean;
  sent_count: number;
};

const NEW_TRIGGER = {
  id: null as string | null,
  keyword: "",
  matchMode: "contains" as "exact" | "contains",
  mediaId: "",
  replyText: "",
  publicReply: "",
  aiContext: "",
  enabled: true,
};

/**
 * "Напиши ХОЧУ в комментариях" — Meta's Private Replies, exposed to the owner.
 *
 * The one API rule the UI has to make visible, because it shapes what the owner should write:
 * Instagram allows exactly ONE message per commenter until that person answers. So the text
 * below is not an opener in a sequence — it is the whole first contact, and it has to end with
 * something the person can reply to. The assistant takes over from their reply onward.
 */
function CommentTriggersCard({ salonId }: { salonId: string }) {
  const list = useServerFn(listCommentTriggers);
  const upsert = useServerFn(upsertCommentTrigger);
  const remove = useServerFn(deleteCommentTrigger);

  const [rows, setRows] = useState<TriggerRow[]>([]);
  const [draft, setDraft] = useState({ ...NEW_TRIGGER });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function reload() {
    try {
      const data = (await list({ data: { salonId } })) as TriggerRow[];
      setRows(data ?? []);
    } catch (e: any) {
      // A salon on a database without the migration should see the rest of the tab work.
      console.warn("comment triggers load failed", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salonId]);

  async function saveDraft() {
    if (draft.keyword.trim().length < 2) {
      toast.error("Кодовое слово — минимум 2 символа");
      return;
    }
    if (!draft.replyText.trim()) {
      toast.error("Напишите сообщение, которое уйдёт в директ");
      return;
    }
    setBusy(true);
    try {
      await upsert({
        data: {
          salonId,
          id: draft.id,
          keyword: draft.keyword.trim(),
          matchMode: draft.matchMode,
          mediaId: draft.mediaId.trim() || null,
          replyText: draft.replyText.trim(),
          publicReply: draft.publicReply.trim() || null,
          aiContext: draft.aiContext.trim() || null,
          enabled: draft.enabled,
        },
      });
      setDraft({ ...NEW_TRIGGER });
      await reload();
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: TriggerRow, enabled: boolean) {
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      await upsert({
        data: {
          salonId,
          id: row.id,
          keyword: row.keyword,
          matchMode: row.match_mode,
          mediaId: row.media_id,
          replyText: row.reply_text,
          publicReply: row.public_reply,
          aiContext: row.ai_context,
          enabled,
        },
      });
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось изменить"));
      await reload();
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">Кодовое слово в комментариях → сообщение в директ</h2>
        <p className="text-sm text-muted-foreground">
          Клиент пишет под постом, например, «ХОЧУ» — и сразу получает от вас личное сообщение.
          Дальше разговор ведёт ассистент. Работает по официальному механизму Instagram, ничего
          обходить не нужно.
        </p>
        <p className="text-xs text-muted-foreground">
          Instagram разрешает отправить такому человеку <b>только одно</b> сообщение, пока он не
          ответит. Поэтому закончите его вопросом — так у клиента будет причина написать в ответ.
          Ещё два ограничения Meta: ответить можно на комментарий не старше 7 дней и только один раз
          на каждый комментарий.
        </p>
        <p className="text-xs text-muted-foreground">
          Чтобы это заработало, в настройках вашего приложения Meta нужно подписать вебхук на поле{" "}
          <code>comments</code> (там же, где уже подписано <code>messages</code>) и выдать
          разрешение <code>instagram_business_manage_comments</code>.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Пока ни одного кодового слова.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-md border p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">«{r.keyword}»</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {r.match_mode === "exact" ? "точное совпадение" : "содержится в тексте"}
                    {r.media_id ? " · один пост" : " · любой пост"}
                    {r.sent_count > 0 ? ` · сработало ${r.sent_count}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={r.enabled} onCheckedChange={(v) => toggle(r, v)} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await remove({ data: { salonId, id: r.id } });
                      await reload();
                    }}
                  >
                    Удалить
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{r.reply_text}</p>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-dashed p-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Кодовое слово</Label>
            <Input
              value={draft.keyword}
              placeholder="ХОЧУ"
              onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Как искать</Label>
            <div className="flex gap-2">
              {(
                [
                  { code: "contains", label: "Есть в комментарии" },
                  { code: "exact", label: "Только это слово" },
                ] as const
              ).map((m) => (
                <Button
                  key={m.code}
                  type="button"
                  size="sm"
                  variant={draft.matchMode === m.code ? "default" : "outline"}
                  onClick={() => setDraft({ ...draft, matchMode: m.code })}
                >
                  {m.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Сообщение в директ</Label>
          <Textarea
            rows={3}
            value={draft.replyText}
            placeholder="Здравствуйте! Вижу ваш комментарий 🙂 Расскажу про кератин и цены — подскажите, какая у вас длина волос?"
            onChange={(e) => setDraft({ ...draft, replyText: e.target.value })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Ответ под постом (необязательно)</Label>
            <Input
              value={draft.publicReply}
              placeholder="Ответила вам в директ 💌"
              onChange={(e) => setDraft({ ...draft, publicReply: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>ID поста (необязательно)</Label>
            <Input
              value={draft.mediaId}
              placeholder="пусто = любой пост"
              onChange={(e) => setDraft({ ...draft, mediaId: e.target.value })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Что ассистенту знать об этом посте (необязательно)</Label>
          <Input
            value={draft.aiContext}
            placeholder="Клиент пришёл с поста про кератин со скидкой"
            onChange={(e) => setDraft({ ...draft, aiContext: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Ассистент увидит это в начале разговора и не будет здороваться так, будто ничего не
            было.
          </p>
        </div>

        <Button onClick={saveDraft} disabled={busy}>
          {busy ? "Сохранение…" : draft.id ? "Сохранить" : "Добавить кодовое слово"}
        </Button>
      </div>
    </Card>
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
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const loadDiag = useServerFn(getInstagramDiagnostics);

  async function refreshDiagnostics() {
    setDiagBusy(true);
    try {
      setDiag(await loadDiag({ data: { salonId } }));
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось получить диагностику"));
    } finally {
      setDiagBusy(false);
    }
  }

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
        // Load the diagnostics with the config: whoever opens this tab after setting it up is
        // usually here precisely because a message went unanswered.
        try {
          const d = await loadDiag({ data: { salonId } });
          if (!cancelled) setDiag(d);
        } catch {
          /* diagnostics are advisory — never block the settings form on them */
        }
      } catch (e: any) {
        if (!cancelled) toast.error(humanError(e, "Не удалось загрузить настройки Instagram"));
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
      idMismatch: Boolean(res.idMismatch),
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
      toast.error(humanError(e, "Не удалось сохранить"));
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
      toast.success(next ? "Ассистент отвечает в Instagram" : "В Instagram теперь отвечаете вы");
    } catch (e: any) {
      setEnabledState(prev);
      toast.error(humanError(e, "Не удалось переключить"));
    } finally {
      setTogglingEnabled(false);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {/* Заголовок и формулировка — те же, что у переключателя WhatsApp в ChannelsTab.
                Это один и тот же по смыслу выключатель в двух каналах, и называться он обязан
                одинаково: разные слова для одного действия читаются как разные действия. */}
            <h2 className="font-semibold flex items-center gap-2">
              <Instagram className="h-4 w-4" />
              Ассистент отвечает в Instagram
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Тот же ассистент, что и в WhatsApp: консультирует, показывает свободные окна и
              записывает прямо в переписке. Настройки (услуги, тон, база знаний) общие — настраивать
              отдельно не нужно. Выключите, если в Instagram хотите отвечать сами.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Переписка Instagram через официальный API Meta — бесплатна. Платить нужно только за
              ответы ассистента — так же, как в WhatsApp.
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
            Сейчас в Instagram отвечаете вы: ассистент сообщения из директа не читает. Включите
            после того, как заполните данные ниже и проверка связи пройдёт успешно.
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
          <h2 className="font-semibold">Шаг 2. Получите доступ к API</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Два способа. Первый не имеет ограничений по числу салонов и живёт постоянно — берите
            его, если у владельца есть аккаунт Facebook. Второй быстрее и Facebook не требует, но
            его выдаёт Qabyl вручную, и число таких подключений ограничено.
          </p>
        </div>

        {/* Вариант А. Салон — владелец своего приложения, поэтому его аккаунт имеет в нём роль,
            и Standard Access покрывает переписку без App Review. Потолка нет: ограничение
            «до 50/500» относится к ролям в ЧУЖОМ приложении, а здесь приложение своё. */}
        <div className="rounded-md border p-4 space-y-2">
          <div className="font-medium text-sm">Вариант А. Своё приложение салона</div>
          <p className="text-sm text-muted-foreground">
            Откройте{" "}
            <a
              className="underline inline-flex items-center gap-1"
              href="https://developers.facebook.com/apps/create/"
              target="_blank"
              rel="noreferrer"
            >
              developers.facebook.com/apps/create
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            → «Создать приложение» → продукт <b>Instagram</b> →{" "}
            <b>«API setup with Instagram login»</b> (именно этот пункт, не «with Facebook login»).
            Там подключите Instagram-аккаунт салона и сгенерируйте токен доступа с правами{" "}
            <code className="text-xs">instagram_business_basic</code> и{" "}
            <code className="text-xs">instagram_business_manage_messages</code>.
          </p>
          <p className="text-xs text-muted-foreground">
            Владельцу нужен аккаунт Facebook — только чтобы создать приложение. Ни страница
            Facebook, ни привязка к ней не требуются. App Review при этом не нужен никогда: аккаунт
            салона имеет роль в своём же приложении.
          </p>
        </div>

        {/* Вариант Б. Аккаунт салона добавляется тестировщиком в приложение Qabyl. Салону не
            нужен ни Facebook, ни приложение — но это режим разработки, и роли конечны. */}
        <div className="rounded-md border p-4 space-y-2">
          <div className="font-medium text-sm">Вариант Б. Тестировщик в приложении Qabyl</div>
          <p className="text-sm text-muted-foreground">
            Салону не нужен ни Facebook, ни своё приложение — только принять приглашение. Напишите
            нам имя Instagram-аккаунта, мы добавим его в роли и пришлём токен для полей ниже.
          </p>
          <p className="text-sm text-muted-foreground">
            Владелец принимает приглашение в приложении Instagram: «Настройки» → «Для
            профессионалов» → «Приложения и сайты» → «Приглашения тестировщиков» → «Принять».
          </p>
          <p className="text-xs text-amber-700">
            Этот способ Meta предназначает для разработки и тестирования, и число ролей конечно. Для
            постоянной работы салона лучше вариант А.
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
            Можно не заполнять: введите токен и нажмите «Сохранить и проверить» — ID подставится
            сам. Вручную его видно в Meta → Instagram → API setup with Instagram login, под
            названием аккаунта. У аккаунта бывает два разных ID (начинается на 178… и на другую
            цифру) — подойдёт любой, на работу ассистента это не влияет.
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
            Meta → Instagram → <b>API setup with Instagram login</b> → блок «Generate access tokens»
            → кнопка «Generate token» напротив вашего аккаунта. Действует 60 дней — после этого
            сгенерируйте заново и вставьте сюда, иначе ассистент перестанет отвечать в Instagram.
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
          <Button
            variant="outline"
            onClick={onTest}
            disabled={loading || testState.kind === "running"}
          >
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
              {testState.idMismatch && testState.accountId && (
                <>
                  {" "}
                  Указанный вами ID отличается от {testState.accountId} — это нормально, у аккаунта
                  два разных ID, на работу не влияет.
                </>
              )}
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

      <Card className="p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Диагностика</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshDiagnostics}
            disabled={diagBusy || loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${diagBusy ? "animate-spin" : ""}`} />
            Обновить
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Если клиент написал, а ассистент не ответил — начните отсюда. Напишите в Direct салона,
          подождите 10–15 секунд и нажмите «Обновить».
        </p>
        {diag ? (
          (() => {
            const v = diagnose(diag, enabled);
            const cls =
              v.tone === "ok" ? "text-green-700 bg-green-50" : "text-amber-800 bg-amber-50";
            const Icon = v.tone === "ok" ? CheckCircle2 : AlertCircle;
            return (
              <>
                <div className={`flex items-start gap-2 text-sm rounded-md p-3 ${cls}`}>
                  <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">{v.title}</p>
                    <p className="mt-0.5">{v.body}</p>
                  </div>
                </div>
                <dl className="text-xs text-muted-foreground grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                  <dt>Диалогов в Instagram:</dt>
                  <dd>{diag.conversationCount}</dd>
                  <dt>Последнее сообщение от клиента:</dt>
                  <dd>
                    {whenLabel(diag.lastInboundAt)}
                    {diag.lastInboundText ? ` — «${diag.lastInboundText.slice(0, 60)}»` : ""}
                  </dd>
                  <dt>Последний ответ ассистента:</dt>
                  <dd>{whenLabel(diag.lastOutboundAt)}</dd>
                  {diag.lastWebhookIssueAt && (
                    <>
                      <dt>Последняя ошибка:</dt>
                      <dd>
                        {whenLabel(diag.lastWebhookIssueAt)} — {diag.lastWebhookIssue}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            );
          })()
        ) : (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        )}
      </Card>

      <CommentTriggersCard salonId={salonId} />

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
            Когда ассистент не может помочь, он передаёт диалог вам и присылает уведомление — туда
            же, куда приходят уведомления по WhatsApp.
          </li>
        </ul>
      </Card>
    </div>
  );
}
