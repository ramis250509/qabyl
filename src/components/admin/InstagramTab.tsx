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
  startInstagramLogin,
  testInstagramConnection,
  upsertCommentTrigger,
  upsertInstagramConfig,
} from "@/lib/instagram.functions";
import { Textarea } from "@/components/ui/textarea";
import { adminLocale, useAdminLang, type AdminLang, type Tr } from "@/lib/admin-lang";

type Diagnostics = Awaited<ReturnType<typeof getInstagramDiagnostics>>;

function whenLabel(iso: string | null, tr: Tr, lang: AdminLang): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return tr("только что", "just now");
  if (mins < 60) return tr(`${mins} мин назад`, `${mins} min ago`);
  if (mins < 24 * 60)
    return tr(`${Math.round(mins / 60)} ч назад`, `${Math.round(mins / 60)} h ago`);
  return d.toLocaleString(adminLocale(lang));
}

/**
 * Turn the raw traces into the sentence the salon actually needs. The ordering matters: a webhook
 * that never arrived is a Meta-side problem and no amount of fiddling on our side will fix it, so
 * that case must not be buried under "everything looks configured".
 */
function diagnose(d: Diagnostics, enabled: boolean, tr: Tr, lang: AdminLang) {
  const issueAt = d.lastWebhookIssueAt ? new Date(d.lastWebhookIssueAt).getTime() : 0;
  const outAt = d.lastOutboundAt ? new Date(d.lastOutboundAt).getTime() : 0;

  // A recorded problem that is NEWER than the last successful reply outranks everything else: it
  // is, by definition, what went wrong most recently. Meta's own wording is passed straight
  // through — "code=190 …" says "the token expired", and nothing we could paraphrase says it better.
  if (issueAt && issueAt > outAt) {
    return {
      tone: "warn" as const,
      title: tr("Последняя ошибка", "Latest error"),
      body: `${d.lastWebhookIssue ?? tr("причина не записана", "no reason recorded")} (${whenLabel(d.lastWebhookIssueAt, tr, lang)}).`,
    };
  }
  if (d.lastInboundAt && d.lastOutboundAt) {
    return {
      tone: "ok" as const,
      title: tr("Всё работает", "Everything works"),
      body: tr(
        `Последнее сообщение от клиента — ${whenLabel(d.lastInboundAt, tr, lang)}, последний ответ ассистента — ${whenLabel(d.lastOutboundAt, tr, lang)}.`,
        `Last message from a client: ${whenLabel(d.lastInboundAt, tr, lang)}. Last reply sent: ${whenLabel(d.lastOutboundAt, tr, lang)}.`,
      ),
    };
  }
  if (d.lastInboundAt) {
    return {
      tone: "warn" as const,
      title: tr(
        "Сообщения приходят, но ответа не было",
        "Messages arrive, but nothing was sent back",
      ),
      body: enabled
        ? tr(
            "Webhook работает — значит дело уже на нашей стороне. Напишите ещё раз и обновите: причина появится здесь же.",
            "Instagram delivers messages to Qabyl, so the issue is on our side. Send another message and refresh — the reason will appear here.",
          )
        : tr(
            "Канал выключен переключателем вверху — включите его.",
            "The channel is switched off at the top — turn it on.",
          ),
    };
  }
  return {
    tone: "warn" as const,
    title: tr(
      "От Meta не пришло ни одного сообщения",
      "No messages have arrived from Instagram yet",
    ),
    body: tr(
      "Значит дело в настройке на стороне Meta, а не у нас. Проверьте по порядку: приложение опубликовано (в режиме Development Meta шлёт события только от аккаунтов с ролью в приложении — добавьте пишущий аккаунт как Instagram Tester и примите приглашение в самом Instagram); в разделе webhooks подписано поле messages; Callback URL и Verify Token совпадают с указанными выше.",
      "Send a Direct message to the salon's account from another Instagram account, wait 10–15 seconds and press Refresh. If it still does not show up, the issue is in the Meta setup: the app must be live, and the webhook must be subscribed to the messages field.",
    ),
  };
}

/** Коды возврата из /api/public/ig-oauth/callback. */
function igLoginResult(code: string, tr: Tr): { ok: boolean; text: string } | undefined {
  const results: Record<string, { ok: boolean; text: string }> = {
    ok: {
      ok: true,
      text: tr(
        "Instagram подключён. Осталось включить канал переключателем вверху.",
        "Instagram is connected. Now turn the channel on with the switch at the top.",
      ),
    },
    nosub: {
      ok: false,
      text: tr(
        "Instagram подключён, но Meta не подписала аккаунт на сообщения. Нажмите «Переподключить Instagram» ещё раз.",
        "Instagram is connected, but Meta did not subscribe the account to messages. Press “Reconnect Instagram” once more.",
      ),
    },
    scopes: {
      ok: false,
      text: tr(
        "Без разрешения на сообщения ассистент не сможет отвечать. Переподключите и оставьте все галочки включёнными.",
        "Without the messages permission Qabyl cannot reply. Reconnect and keep all permissions checked.",
      ),
    },
    cancelled: { ok: false, text: tr("Подключение отменено.", "Connection cancelled.") },
    taken: {
      ok: false,
      text: tr(
        "Этот Instagram-аккаунт уже подключён к другому салону в Qabyl.",
        "This Instagram account is already connected to another salon in Qabyl.",
      ),
    },
    forbidden: { ok: false, text: tr("Нет доступа к этому салону.", "No access to this salon.") },
    failed: {
      ok: false,
      text: tr(
        "Не удалось подключить Instagram. Проверьте, что аккаунт профессиональный, и попробуйте ещё раз.",
        "Could not connect Instagram. Make sure the account is a professional one and try again.",
      ),
    },
  };
  return results[code];
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
  const { tr } = useAdminLang();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(
        tr(
          "Не удалось скопировать — выделите и скопируйте вручную",
          "Could not copy — select the text and copy it manually",
        ),
      );
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
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={copy}
          title={tr("Скопировать", "Copy")}
        >
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
  const { tr, lang } = useAdminLang();
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
      toast.error(
        tr("Кодовое слово — минимум 2 символа", "The keyword needs at least 2 characters"),
      );
      return;
    }
    if (!draft.replyText.trim()) {
      toast.error(
        tr("Напишите сообщение, которое уйдёт в директ", "Write the message to send in Direct"),
      );
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
      toast.success(tr("Сохранено", "Saved"));
    } catch (e: any) {
      toast.error(humanError(e, tr("Не удалось сохранить", "Could not save")));
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
      toast.error(humanError(e, tr("Не удалось изменить", "Could not update")));
      await reload();
    }
  }

  return (
    <Card className="p-4 sm:p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">
          {tr(
            "Кодовое слово в комментариях → сообщение в директ",
            "Comment keyword → private message in Direct",
          )}
        </h2>
        {lang === "en" ? (
          <>
            <p className="text-sm text-muted-foreground">
              A follower comments a keyword such as “WANT” under your post — Qabyl replies under the
              comment and sends them one private message in Direct. After they answer, the assistant
              continues the conversation. This uses Instagram's official Private Replies feature.
            </p>
            <p className="text-xs text-muted-foreground">
              Instagram allows <b>only one</b> private message to such a person until they reply, so
              end it with a question. Two more Meta rules: the comment must be less than 7 days old,
              and each comment can be answered only once.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Клиент пишет под постом, например, «ХОЧУ» — и сразу получает от вас личное сообщение.
              Дальше разговор ведёт ассистент. Работает по официальному механизму Instagram, ничего
              обходить не нужно.
            </p>
            <p className="text-xs text-muted-foreground">
              Instagram разрешает отправить такому человеку <b>только одно</b> сообщение, пока он не
              ответит. Поэтому закончите его вопросом — так у клиента будет причина написать в
              ответ. Ещё два ограничения Meta: ответить можно на комментарий не старше 7 дней и
              только один раз на каждый комментарий.
            </p>
            <p className="text-xs text-muted-foreground">
              Чтобы это заработало, в настройках вашего приложения Meta нужно подписать вебхук на
              поле <code>comments</code> (там же, где уже подписано <code>messages</code>) и выдать
              разрешение <code>instagram_business_manage_comments</code>.
            </p>
          </>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{tr("Загрузка…", "Loading…")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tr("Пока ни одного кодового слова.", "No keywords yet.")}
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-md border p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">
                    {tr(`«${r.keyword}»`, `“${r.keyword}”`)}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {r.match_mode === "exact"
                      ? tr("точное совпадение", "exact match")
                      : tr("содержится в тексте", "contained in the comment")}
                    {r.media_id
                      ? tr(" · один пост", " · one post")
                      : tr(" · любой пост", " · any post")}
                    {r.sent_count > 0
                      ? tr(` · сработало ${r.sent_count}`, ` · triggered ${r.sent_count}`)
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(v) => toggle(r, v)}
                    aria-label={tr("Кодовое слово включено", "Keyword enabled")}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await remove({ data: { salonId, id: r.id } });
                      await reload();
                    }}
                  >
                    {tr("Удалить", "Delete")}
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
            <Label>{tr("Кодовое слово", "Keyword")}</Label>
            <Input
              value={draft.keyword}
              placeholder={tr("ХОЧУ", "WANT")}
              onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tr("Как искать", "How to match")}</Label>
            <div className="flex gap-2">
              {(
                [
                  { code: "contains", label: tr("Есть в комментарии", "Anywhere in the comment") },
                  { code: "exact", label: tr("Только это слово", "Only this word") },
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
          <Label>{tr("Сообщение в директ", "Private message in Direct")}</Label>
          <Textarea
            rows={3}
            value={draft.replyText}
            placeholder={tr(
              "Здравствуйте! Вижу ваш комментарий 🙂 Расскажу про кератин и цены — подскажите, какая у вас длина волос?",
              "Hi! Saw your comment 🙂 Happy to tell you about keratin and prices — how long is your hair?",
            )}
            onChange={(e) => setDraft({ ...draft, replyText: e.target.value })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>
              {tr("Ответ под постом (необязательно)", "Public reply under the comment (optional)")}
            </Label>
            <Input
              value={draft.publicReply}
              placeholder={tr("Ответила вам в директ 💌", "Sent you a DM 💌")}
              onChange={(e) => setDraft({ ...draft, publicReply: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tr("ID поста (необязательно)", "Post ID (optional)")}</Label>
            <Input
              value={draft.mediaId}
              placeholder={tr("пусто = любой пост", "empty = any post")}
              onChange={(e) => setDraft({ ...draft, mediaId: e.target.value })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>
            {tr(
              "Что ассистенту знать об этом посте (необязательно)",
              "What the assistant should know about this post (optional)",
            )}
          </Label>
          <Input
            value={draft.aiContext}
            placeholder={tr(
              "Клиент пришёл с поста про кератин со скидкой",
              "The client came from the post about discounted keratin",
            )}
            onChange={(e) => setDraft({ ...draft, aiContext: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {tr(
              "Ассистент увидит это в начале разговора и не будет здороваться так, будто ничего не было.",
              "The assistant sees this at the start of the conversation and continues from it instead of greeting the person from scratch.",
            )}
          </p>
        </div>

        <Button onClick={saveDraft} disabled={busy}>
          {busy
            ? tr("Сохранение…", "Saving…")
            : draft.id
              ? tr("Сохранить", "Save")
              : tr("Добавить кодовое слово", "Add keyword")}
        </Button>
      </div>
    </Card>
  );
}

export function InstagramTab({ salonId, salonName }: { salonId: string; salonName?: string }) {
  const { tr, lang } = useAdminLang();
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
  const startLogin = useServerFn(startInstagramLogin);
  const [connectedVia, setConnectedVia] = useState<"manual" | "platform" | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function onConnect() {
    setConnecting(true);
    try {
      const { url } = await startLogin({ data: { salonId } });
      window.location.href = url;
    } catch (e: any) {
      toast.error(
        humanError(e, tr("Не удалось начать подключение", "Could not start the connection")),
      );
      setConnecting(false);
    }
  }

  // Возврат с instagram.com: результат приходит кодом в ?ig=…. Показываем и убираем из адреса,
  // чтобы обновление страницы не повторяло сообщение.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("ig");
    if (!code) return;
    const msg = igLoginResult(code, tr);
    if (msg) {
      if (msg.ok) toast.success(msg.text, { duration: 10000 });
      else toast.error(msg.text, { duration: 15000 });
    }
    params.delete("ig");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
    if (code === "ok" || code === "nosub") void onTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshDiagnostics() {
    setDiagBusy(true);
    try {
      setDiag(await loadDiag({ data: { salonId } }));
    } catch (e: any) {
      toast.error(
        humanError(e, tr("Не удалось получить диагностику", "Could not load diagnostics")),
      );
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
        setConnectedVia(cfg.connected_via ?? null);
        setExpiresAt(cfg.token_expires_at ?? null);
        // Load the diagnostics with the config: whoever opens this tab after setting it up is
        // usually here precisely because a message went unanswered.
        try {
          const d = await loadDiag({ data: { salonId } });
          if (!cancelled) setDiag(d);
        } catch {
          /* diagnostics are advisory — never block the settings form on them */
        }
      } catch (e: any) {
        if (!cancelled) {
          toast.error(
            humanError(
              e,
              tr(
                "Не удалось загрузить настройки Instagram",
                "Could not load the Instagram settings",
              ),
            ),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  // Какой именно аккаунт подключён, видно сразу, без нажатия «Проверить связь». Ради этого вкладку
  // и открывают — и владелец, и проверяющий Meta, которому App Review велит показать выбранный
  // аккаунт. При возврате с instagram.com проверка уже запущена эффектом выше — второй раз не зовём.
  useEffect(() => {
    if (loading || connectedVia !== "platform" || !userId) return;
    if (testState.kind !== "idle") return;
    void onTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, connectedVia, userId]);

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
    // Only when the owner typed a token by hand. A salon connected with the button has an empty
    // token field on screen (the token never reaches the browser), and saving the form from here
    // wiped the real token and replaced the account id with the app-scoped one.
    if (!userId.trim() && token.trim() && res.accountId) {
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
      toast.success(tr("Сохранено", "Saved"));
    } catch (e: any) {
      toast.error(humanError(e, tr("Не удалось сохранить", "Could not save")));
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
      setTestState({
        kind: "error",
        message: e.message ?? tr("Проверка не удалась", "The check failed"),
      });
    }
  }

  async function onToggle(next: boolean) {
    setTogglingEnabled(true);
    const prev = enabled;
    setEnabledState(next);
    try {
      await setEnabled({ data: { salonId, enabled: next } });
      toast.success(
        next
          ? tr("Ассистент отвечает в Instagram", "The assistant now replies on Instagram")
          : tr("В Instagram теперь отвечаете вы", "You now reply on Instagram yourself"),
      );
    } catch (e: any) {
      setEnabledState(prev);
      toast.error(humanError(e, tr("Не удалось переключить", "Could not switch")));
    } finally {
      setTogglingEnabled(false);
    }
  }

  const testResult = (
    <>
      {testState.kind === "ok" && (
        <div className="flex items-start gap-2 text-sm text-green-700 bg-green-50 rounded-md p-3">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            {tr("Связь с Instagram установлена", "Connected to Instagram")}
            {testState.username ? (
              <>
                {" "}
                — {tr("аккаунт", "account")} <b>@{testState.username}</b>
              </>
            ) : null}
            {testState.accountType ? ` (${testState.accountType})` : null}.
            {testState.autofilledId &&
              tr(
                " Instagram account ID подставлен автоматически.",
                " The Instagram account ID was filled in automatically.",
              )}
            {testState.idMismatch && testState.accountId && connectedVia !== "platform" && (
              <>
                {" "}
                {tr(
                  `Указанный вами ID отличается от ${testState.accountId} — это нормально, у аккаунта два разных ID, на работу не влияет.`,
                  `The ID you entered differs from ${testState.accountId} — that is fine, an account has two different IDs and it does not affect anything.`,
                )}
              </>
            )}
            {!enabled &&
              connectedVia !== "platform" &&
              tr(
                " Осталось включить канал переключателем вверху.",
                " Now turn the channel on with the switch at the top.",
              )}
          </div>
        </div>
      )}
      {testState.kind === "error" && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-md p-3">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>{testState.message}</div>
        </div>
      )}
    </>
  );

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {/* Заголовок и формулировка — те же, что у переключателя WhatsApp в ChannelsTab.
                Это один и тот же по смыслу выключатель в двух каналах, и называться он обязан
                одинаково: разные слова для одного действия читаются как разные действия. */}
            <h2 className="font-semibold flex items-center gap-2">
              <Instagram className="h-4 w-4" />
              {tr("Ассистент отвечает в Instagram", "AI assistant replies on Instagram")}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tr(
                "Тот же ассистент, что и в WhatsApp: консультирует, показывает свободные окна и записывает прямо в переписке. Настройки (услуги, тон, база знаний) общие — настраивать отдельно не нужно. Выключите, если в Instagram хотите отвечать сами.",
                "The same assistant as in WhatsApp: it answers questions, offers free time slots and books clients right in the chat. Its settings (services, tone, knowledge base) are shared. Switch it off if you prefer to reply on Instagram yourself.",
              )}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {tr(
                "Переписка Instagram через официальный API Meta — бесплатна. Платить нужно только за ответы ассистента — так же, как в WhatsApp.",
                "Instagram messaging runs on Meta's official API and is free. You only pay for the assistant's replies, the same as in WhatsApp.",
              )}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={loading || togglingEnabled}
            aria-label={tr("Ассистент отвечает в Instagram", "AI assistant replies on Instagram")}
          />
        </div>
        {!loading && !enabled && (
          <p className="text-xs text-amber-700">
            {tr(
              "Сейчас в Instagram отвечаете вы: ассистент сообщения из директа не читает. Включите после того, как заполните данные ниже и проверка связи пройдёт успешно.",
              "Right now you reply on Instagram yourself: the assistant does not read Direct messages. Turn it on once Instagram is connected below.",
            )}
          </p>
        )}
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <div>
          <h2 className="font-semibold">
            {tr("Шаг 1. Подготовьте аккаунт", "Step 1. Prepare the account")}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {tr(
              `Instagram-аккаунт${salonName ? ` салона «${salonName}»` : ""} должен быть профессиональным: в приложении Instagram — «Настройки» → «Тип аккаунта и инструменты» → «Переключиться на профессиональный аккаунт» (Бизнес или Автор). В личном аккаунте API переписки не работает.`,
              `The Instagram account${salonName ? ` of “${salonName}”` : ""} must be a professional account: in the Instagram app go to Settings → Account type and tools → Switch to professional account (Business or Creator). Messaging does not work with personal accounts.`,
            )}
          </p>
        </div>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold">
          {tr("Шаг 2. Подключите Instagram", "Step 2. Connect Instagram")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {tr(
            "Нажмите кнопку, войдите в Instagram-аккаунт салона и разрешите доступ к сообщениям и комментариям. Больше ничего настраивать не нужно — ни приложения Meta, ни токенов.",
            "Press the button, log in to the salon's Instagram account and allow access. Nothing else to set up — no Meta apps, no tokens.",
          )}
        </p>
        {/* Что именно Qabyl попросит у Instagram и зачем. Владельцу — чтобы не пугал экран
            разрешений; проверяющему Meta — потому что App Review требует объяснять в интерфейсе,
            для чего каждое разрешение. */}
        <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
          <li>
            {tr(
              "Профиль (имя аккаунта) — чтобы показать здесь, какой аккаунт подключён.",
              "Profile (username) — to show here which account is connected.",
            )}
          </li>
          <li>
            {tr(
              "Сообщения — чтобы сообщения клиентов из Direct приходили в «Переписки», а ваши ответы и ответы ассистента уходили клиенту в Instagram.",
              "Messages — so client messages from Direct appear in Chats, and replies from you or the assistant are delivered to the client on Instagram.",
            )}
          </li>
          <li>
            {tr(
              "Комментарии — чтобы на комментарий с кодовым словом ответить под постом и написать человеку в Direct.",
              "Comments — to answer a comment containing your keyword under the post and message that person in Direct.",
            )}
          </li>
        </ul>
        {connectedVia === "platform" && userId && (
          <div className="flex items-start gap-2 text-sm text-green-700 bg-green-50 rounded-md p-3">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              {tr(
                "Instagram подключён. Доступ продлевается автоматически",
                "Instagram is connected. Access renews automatically",
              )}
              {expiresAt
                ? tr(
                    ` (текущий действует до ${new Date(expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })})`,
                    ` (current access valid until ${new Date(expiresAt).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })})`,
                  )
                : ""}
              .
              {!enabled &&
                tr(
                  " Осталось включить канал переключателем вверху.",
                  " Now turn the channel on with the switch at the top.",
                )}
            </div>
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          <Button onClick={onConnect} disabled={connecting || loading}>
            <Instagram className="h-4 w-4 mr-2" />
            {connecting
              ? tr("Открываем Instagram…", "Opening Instagram…")
              : connectedVia === "platform" && userId
                ? tr("Переподключить Instagram", "Reconnect Instagram")
                : tr("Подключить Instagram", "Connect Instagram")}
          </Button>
          {connectedVia === "platform" && userId && (
            <Button
              variant="outline"
              onClick={onTest}
              disabled={loading || testState.kind === "running"}
            >
              {testState.kind === "running"
                ? tr("Проверяем...", "Checking...")
                : tr("Проверить связь", "Check connection")}
            </Button>
          )}
        </div>
        {connectedVia === "platform" && testResult}
        <p className="text-xs text-muted-foreground">
          {tr(
            "Instagram попросит войти заново, даже если в браузере уже открыт аккаунт. Входите именно в аккаунт салона, а не в личный.",
            "Instagram asks you to log in again even if an account is already open in this browser. Log in to the salon's account, not a personal one.",
          )}
        </p>
      </Card>

      {/* Ручной путь остаётся: салоны, подключённые раньше, и те, у кого своё приложение Meta. */}
      <details
        className="rounded-md border bg-card"
        open={connectedVia === "manual" || (!connectedVia && Boolean(appSecret))}
      >
        <summary className="cursor-pointer px-4 py-3 text-sm text-muted-foreground">
          {tr(
            "Другой способ: своё приложение Meta и токен вручную",
            "Advanced: your own Meta app and a manual token",
          )}
        </summary>
        <div className="space-y-4 p-2 sm:p-4 pt-0">
          <Card className="p-4 sm:p-6 space-y-4">
            <div>
              <h2 className="font-semibold">{tr("Получите доступ к API", "Get API access")}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {tr(
                  "Два способа. Первый не имеет ограничений по числу салонов и живёт постоянно — берите его, если у владельца есть аккаунт Facebook. Второй быстрее и Facebook не требует, но его выдаёт Qabyl вручную, и число таких подключений ограничено.",
                  "Two options. The first has no limits and is permanent — use it if the owner has a Facebook account. The second is quicker and needs no Facebook, but Qabyl grants it manually and the number of such connections is limited.",
                )}
              </p>
            </div>

            {/* Вариант А. Салон — владелец своего приложения, поэтому его аккаунт имеет в нём роль,
            и Standard Access покрывает переписку без App Review. Потолка нет: ограничение
            «до 50/500» относится к ролям в ЧУЖОМ приложении, а здесь приложение своё. */}
            <div className="rounded-md border p-4 space-y-2">
              <div className="font-medium text-sm">
                {tr("Вариант А. Своё приложение салона", "Option A. The salon's own Meta app")}
              </div>
              <p className="text-sm text-muted-foreground">
                {tr("Откройте", "Open")}{" "}
                <a
                  className="underline inline-flex items-center gap-1"
                  href="https://developers.facebook.com/apps/create/"
                  target="_blank"
                  rel="noreferrer"
                >
                  developers.facebook.com/apps/create
                  <ExternalLink className="h-3 w-3" />
                </a>{" "}
                {tr("→ «Создать приложение» → продукт", "→ Create app → product")} <b>Instagram</b>{" "}
                → <b>API setup with Instagram login</b>{" "}
                {tr(
                  "(именно этот пункт, не «with Facebook login»). Там подключите Instagram-аккаунт салона и сгенерируйте токен доступа с правами",
                  "(this one, not “with Facebook login”). Add the salon's Instagram account there and generate an access token with",
                )}{" "}
                <code className="text-xs">instagram_business_basic</code> {tr("и", "and")}{" "}
                <code className="text-xs">instagram_business_manage_messages</code>.
              </p>
              <p className="text-xs text-muted-foreground">
                {tr(
                  "Владельцу нужен аккаунт Facebook — только чтобы создать приложение. Ни страница Facebook, ни привязка к ней не требуются. App Review при этом не нужен никогда: аккаунт салона имеет роль в своём же приложении.",
                  "The owner needs a Facebook account only to create the app. No Facebook Page is required.",
                )}
              </p>
            </div>

            {/* Вариант Б. Аккаунт салона добавляется тестировщиком в приложение Qabyl. Салону не
            нужен ни Facebook, ни приложение — но это режим разработки, и роли конечны. */}
            <div className="rounded-md border p-4 space-y-2">
              <div className="font-medium text-sm">
                {tr(
                  "Вариант Б. Тестировщик в приложении Qabyl",
                  "Option B. Tester in the Qabyl app",
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {tr(
                  "Салону не нужен ни Facebook, ни своё приложение — только принять приглашение. Напишите нам имя Instagram-аккаунта, мы добавим его в роли и пришлём токен для полей ниже.",
                  "No Facebook and no app of your own — only accept an invitation. Send us the Instagram username, we add it to the app roles and send you a token for the fields below.",
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {tr(
                  "Владелец принимает приглашение в приложении Instagram: «Настройки» → «Для профессионалов» → «Приложения и сайты» → «Приглашения тестировщиков» → «Принять».",
                  "The owner accepts the invitation in the Instagram app: Settings → For professionals → Apps and websites → Tester invites → Accept.",
                )}
              </p>
              <p className="text-xs text-amber-700">
                {tr(
                  "Этот способ Meta предназначает для разработки и тестирования, и число ролей конечно. Для постоянной работы салона лучше вариант А.",
                  "Meta intends this option for development and testing, and the number of roles is limited. Option A is better for everyday use.",
                )}
              </p>
            </div>
          </Card>

          <Card className="p-4 sm:p-6 space-y-4">
            <div>
              <h2 className="font-semibold">
                {tr("Шаг 3. Пропишите webhook в Meta", "Step 3. Set up the webhook in Meta")}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {tr(
                  "В приложении Meta: Instagram → «Configure webhooks». Скопируйте туда эти два значения и подпишитесь на поле",
                  "In your Meta app: Instagram → Configure webhooks. Paste these two values there and subscribe to the field",
                )}{" "}
                <code className="text-xs">messages</code>.
              </p>
            </div>
            <CopyField
              label="Callback URL"
              value={webhookUrl}
              hint={tr("Вставьте в поле «Callback URL».", "Paste into the Callback URL field.")}
            />
            <CopyField
              label="Verify Token"
              value={verifyToken}
              hint={tr(
                "Вставьте в поле «Verify token». Это значение придумано нами — в Meta его нужно просто скопировать.",
                "Paste into the Verify token field. Qabyl generated this value — just copy it into Meta.",
              )}
            />
          </Card>

          <Card className="p-4 sm:p-6 space-y-4">
            <div>
              <h2 className="font-semibold">
                {tr("Шаг 4. Введите данные приложения", "Step 4. Enter the app credentials")}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {tr(
                  "Эти три значения берутся из того же приложения Meta. Они хранятся только на сервере и никогда не показываются клиентам.",
                  "These three values come from the same Meta app. They are stored only on the server and never shown to clients.",
                )}
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
                {tr(
                  "Можно не заполнять: введите токен и нажмите «Сохранить и проверить» — ID подставится сам. Вручную его видно в Meta → Instagram → API setup with Instagram login, под названием аккаунта. У аккаунта бывает два разных ID (начинается на 178… и на другую цифру) — подойдёт любой, на работу ассистента это не влияет.",
                  "Optional: enter the token and press “Save and check” — the ID fills in by itself. It is also shown in Meta → Instagram → API setup with Instagram login, under the account name. An account can have two different IDs; either one works.",
                )}
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
                {tr(
                  "Meta → Instagram → API setup with Instagram login → блок «Generate access tokens» → кнопка «Generate token» напротив вашего аккаунта. Действует 60 дней — после этого сгенерируйте заново и вставьте сюда, иначе ассистент перестанет отвечать в Instagram.",
                  "Meta → Instagram → API setup with Instagram login → Generate access tokens → Generate token next to your account. It is valid for 60 days — then generate a new one and paste it here, otherwise the assistant stops replying on Instagram.",
                )}
              </p>
              <p className="text-xs text-amber-700 mt-1">
                {tr(
                  "Не подходит токен из «API setup with Facebook login» — это другой тип токена, с ним переписка работать не будет.",
                  "A token from “API setup with Facebook login” will not work — it is a different kind of token.",
                )}
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
                {tr(
                  "Meta → «Настройки приложения» → «Основное» → «Секрет приложения». Нужен, чтобы никто посторонний не мог отправлять поддельные сообщения на ваш webhook.",
                  "Meta → App settings → Basic → App secret. It ensures nobody else can send fake messages to your webhook.",
                )}
              </p>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button onClick={onSave} disabled={saving || loading}>
                {saving ? "..." : tr("Сохранить и проверить", "Save and check")}
              </Button>
              <Button
                variant="outline"
                onClick={onTest}
                disabled={loading || testState.kind === "running"}
              >
                {testState.kind === "running"
                  ? tr("Проверяем...", "Checking...")
                  : tr("Проверить связь", "Check connection")}
              </Button>
            </div>

            {connectedVia !== "platform" && testResult}
          </Card>
        </div>
      </details>

      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">{tr("Диагностика", "Diagnostics")}</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshDiagnostics}
            disabled={diagBusy || loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${diagBusy ? "animate-spin" : ""}`} />
            {tr("Обновить", "Refresh")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {tr(
            "Если клиент написал, а ассистент не ответил — начните отсюда. Напишите в Direct салона, подождите 10–15 секунд и нажмите «Обновить».",
            "If a client wrote and got no reply, start here. Send a Direct message to the salon, wait 10–15 seconds and press Refresh.",
          )}
        </p>
        {diag ? (
          (() => {
            const v = diagnose(diag, enabled, tr, lang);
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
                  <dt>{tr("Диалогов в Instagram:", "Instagram conversations:")}</dt>
                  <dd>{diag.conversationCount}</dd>
                  <dt>{tr("Последнее сообщение от клиента:", "Last message from a client:")}</dt>
                  <dd>
                    {whenLabel(diag.lastInboundAt, tr, lang)}
                    {diag.lastInboundText ? ` — «${diag.lastInboundText.slice(0, 60)}»` : ""}
                  </dd>
                  <dt>{tr("Последний ответ ассистента:", "Last reply sent:")}</dt>
                  <dd>{whenLabel(diag.lastOutboundAt, tr, lang)}</dd>
                  {diag.lastWebhookIssueAt && (
                    <>
                      <dt>{tr("Последняя ошибка:", "Latest error:")}</dt>
                      <dd>
                        {whenLabel(diag.lastWebhookIssueAt, tr, lang)} — {diag.lastWebhookIssue}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            );
          })()
        ) : (
          <p className="text-sm text-muted-foreground">{tr("Загрузка…", "Loading…")}</p>
        )}
      </Card>

      <CommentTriggersCard salonId={salonId} />

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold">
          {tr("Как это работает у клиента", "How it works for your clients")}
        </h2>
        <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-4">
          <li>
            {tr(
              "Клиент пишет в Direct — ассистент отвечает сам, на языке клиента.",
              "A client writes to your Direct — the assistant replies on its own, in the client's language.",
            )}
          </li>
          <li>
            {tr(
              "В Instagram нет номера телефона, поэтому перед оформлением записи ассистент один раз попросит номер — он нужен мастеру для связи и напоминания.",
              "Instagram does not share phone numbers, so before booking the assistant asks for one once — the master needs it for reminders.",
            )}
          </li>
          <li>
            {tr(
              "Вы можете ответить сами — во вкладке «Переписки» или в приложении Instagram. Пока вы отвечаете, ассистент молчит 5 минут, чтобы не перебивать вас.",
              "You can reply yourself — in the Chats tab or in the Instagram app. While you reply, the assistant stays silent for 5 minutes so it does not interrupt you.",
            )}
          </li>
          <li>
            {tr(
              "Когда ассистент не может помочь, он передаёт диалог вам и присылает уведомление — туда же, куда приходят уведомления по WhatsApp.",
              "When the assistant cannot help, it hands the conversation to you and sends a notification — the same way as for WhatsApp.",
            )}
          </li>
        </ul>
      </Card>
    </div>
  );
}
