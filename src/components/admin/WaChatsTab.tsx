// Переписки: все разговоры с клиентами в одном месте.
//
// ПОЧЕМУ ОДНА ВКЛАДКА, А НЕ ДВЕ. Клиент — один человек, и владельцу неважно, через что он написал.
// Разводить WhatsApp и Instagram по разным экранам значит заставлять проверять два места и
// гарантированно пропускать сообщения в том, куда заходят реже. Канал здесь — это фильтр и
// значок у строки, а не отдельный продукт.
//
// НЕПРОЧИТАННОЕ ХРАНИТСЯ В БРАУЗЕРЕ. В базе отметки «прочитано» нет, и заводить её ради этого
// экрана — миграция, триггеры и новый источник рассинхронизации. Отметка о последнем просмотре
// лежит в localStorage: она своя на каждом устройстве, и это честно — «я это видела» относится к
// человеку за конкретным экраном, а не к салону целиком.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { sendManualChatMessage } from "@/lib/wa-chats.functions";
import { testInstagramConnection } from "@/lib/instagram.functions";
import { useAdminLang, type Tr } from "@/lib/admin-lang";
import { StatusBadge, EmptyState, SkeletonBlock, type Tone } from "@/components/ui/status";
import {
  MessageCircle,
  Search,
  ImageIcon,
  SendHorizonal,
  Instagram,
  ArrowLeft,
  Sparkles,
  UserRound,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";

type Channel = "whatsapp" | "instagram";
type Filter = "all" | Channel;

type Conversation = {
  id: string;
  salon_id: string;
  channel: string;
  client_phone: string;
  client_name: string | null;
  status: "active" | "booked" | "closed";
  last_message_at: string;
  last_message_preview: string | null;
  ai_paused: boolean;
  state_data: { needs_human?: boolean } | null;
};

type Message = {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  kind: "text" | "image" | "system";
  text_body: string | null;
  media_path: string | null;
  created_at: string;
  // `manual` отмечает ответ, который администратор напечатал здесь, — в отличие от служебных
  // заметок самого ассистента: и то и другое хранится как kind "system".
  // `commentTrigger` / `commentText` — личное сообщение, отправленное в ответ на комментарий
  // с кодовым словом (вебхук Instagram, handleCommentTrigger).
  meta: { manual?: boolean; commentTrigger?: string; commentText?: string } | null;
};

const isManualReply = (m: Message) => m.kind === "system" && m.meta?.manual === true;
const needsHuman = (c: Conversation) => c.state_data?.needs_human === true;
const channelOf = (c: Conversation): Channel =>
  c.channel === "instagram" ? "instagram" : "whatsapp";

/** Instagram-переписки хранят в client_phone строку `ig:<id>` — показывать её человеку нельзя. */
function displayContact(c: Conversation): string {
  if (channelOf(c) === "instagram") return "Instagram Direct";
  return c.client_phone;
}

function displayName(c: Conversation, tr: Tr): string {
  if (c.client_name) return c.client_name;
  if (channelOf(c) === "instagram") return tr("Клиент из Instagram", "Instagram client");
  return c.client_phone;
}

/** Сегодня — только время, вчера — слово, раньше — дата. Как в любом мессенджере. */
function shortTime(iso: string, tr: Tr): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return tr("вчера", "yesterday");
  return format(d, "dd.MM");
}

function statusTone(c: Conversation, tr: Tr): { tone: Tone; text: string } {
  if (needsHuman(c)) return { tone: "error", text: tr("ждёт вас", "needs you") };
  if (c.status === "booked") return { tone: "ok", text: tr("записан", "booked") };
  if (c.status === "closed") return { tone: "idle", text: tr("закрыт", "closed") };
  return { tone: "warn", text: tr("в разговоре", "in progress") };
}

// ── Отметки о прочтении ─────────────────────────────────────────────────────
const SEEN_KEY = "qb_chats_seen";

function readSeen(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeSeen(next: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // Приватный режим или переполненное хранилище. Непрочитанные просто не запомнятся —
    // ломать из-за этого экран незачем.
  }
}

export function WaChatsTab({ salonId }: { salonId: string }) {
  const { tr } = useAdminLang();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSeen(readSeen()), []);

  // Смена чата не должна уносить недописанный ответ в чужую переписку.
  useEffect(() => {
    setDraft("");
    setSendError(null);
  }, [activeId]);

  const markSeen = useCallback((id: string, at: string) => {
    setSeen((prev) => {
      if (prev[id] === at) return prev;
      const next = { ...prev, [id]: at };
      writeSeen(next);
      return next;
    });
  }, []);

  async function handleSend() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendManualChatMessage({ data: { conversationId: activeId, text } });
      // Отправленное придёт через realtime как любое другое — дописывать вручную значит
      // показать его дважды.
      setDraft("");
    } catch (e: any) {
      // Сервер намеренно не сохраняет сообщение, которое провайдер отверг, — это единственное
      // место, где администратор узнаёт, что оно не ушло. Формулировка провайдера важна:
      // «вне 24-часового окна» и «истёк токен» чинятся совершенно по-разному.
      setSendError(
        e?.message ?? tr("Не удалось отправить сообщение", "Could not send the message"),
      );
    } finally {
      setSending(false);
    }
  }

  // Список переписок + подписка на изменения.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("wa_conversations")
        .select("*")
        .eq("salon_id", salonId)
        .order("last_message_at", { ascending: false })
        .limit(200);
      if (cancelled) return;
      setConvs((data ?? []) as Conversation[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`wa-conv-${salonId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "wa_conversations",
          filter: `salon_id=eq.${salonId}`,
        },
        (payload) => {
          setConvs((prev) => {
            const next = [...prev];
            const row = payload.new as Conversation;
            if (payload.eventType === "DELETE") {
              return next.filter((c) => c.id !== (payload.old as any).id);
            }
            const idx = next.findIndex((c) => c.id === row.id);
            if (idx >= 0) next[idx] = row;
            else next.unshift(row);
            return next.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
          });
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [salonId]);

  // Сообщения открытого чата + подписка.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("wa_messages")
        .select("*")
        .eq("conversation_id", activeId)
        .order("created_at", { ascending: true })
        .limit(500);
      if (cancelled) return;
      setMessages((data ?? []) as Message[]);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    })();
    const channel = supabase
      .channel(`wa-msg-${activeId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "wa_messages",
          filter: `conversation_id=eq.${activeId}`,
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({
              top: scrollRef.current!.scrollHeight,
              behavior: "smooth",
            });
          });
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [activeId]);

  // Открытый чат считается прочитанным — в том числе когда в него прилетает новое сообщение.
  useEffect(() => {
    if (!activeId) return;
    const c = convs.find((x) => x.id === activeId);
    if (c) markSeen(c.id, c.last_message_at);
  }, [activeId, convs, markSeen]);

  // Подписанные ссылки на картинки.
  useEffect(() => {
    const missing = messages
      .filter((m) => m.kind === "image" && m.media_path && !mediaUrls[m.media_path])
      .map((m) => m.media_path!) as string[];
    if (!missing.length) return;
    (async () => {
      const updates: Record<string, string> = {};
      for (const path of missing) {
        const { data } = await supabase.storage.from("wa-media").createSignedUrl(path, 600);
        if (data?.signedUrl) updates[path] = data.signedUrl;
      }
      if (Object.keys(updates).length) setMediaUrls((prev) => ({ ...prev, ...updates }));
    })();
  }, [messages, mediaUrls]);

  const counts = useMemo(
    () => ({
      all: convs.length,
      whatsapp: convs.filter((c) => channelOf(c) === "whatsapp").length,
      instagram: convs.filter((c) => channelOf(c) === "instagram").length,
    }),
    [convs],
  );

  const isUnread = useCallback(
    (c: Conversation) => {
      const mark = seen[c.id];
      return !mark || mark < c.last_message_at;
    },
    [seen],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return convs.filter((c) => {
      if (filter !== "all" && channelOf(c) !== filter) return false;
      if (!q) return true;
      return (
        (c.client_name ?? "").toLowerCase().includes(q) ||
        c.client_phone.toLowerCase().includes(q) ||
        (c.last_message_preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [convs, search, filter]);

  // Первая переписка открывается сама — но только на широком экране. На телефоне список и чат
  // занимают один и тот же экран, и автооткрытие означало бы, что человек попадает сразу в чужой
  // разговор, минуя список.
  useEffect(() => {
    if (activeId || loading || filtered.length === 0) return;
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) return;
    setActiveId(filtered[0].id);
  }, [activeId, loading, filtered]);

  const activeConv = convs.find((c) => c.id === activeId) ?? null;
  const activeIsInstagram = activeConv ? channelOf(activeConv) === "instagram" : false;

  // Под каким аккаунтом уйдёт ответ в Instagram. У владельца часто два аккаунта — личный и
  // салона, — и подпись у поля ввода снимает вопрос «от кого клиент это получит» до отправки.
  // Она же показывает проверяющему Meta выбранный аккаунт в момент отправки из интерфейса.
  // undefined — ещё не спрашивали, null — узнать не удалось (подпись просто не рисуется).
  const [igAccount, setIgAccount] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!activeIsInstagram || igAccount !== undefined) return;
    let cancelled = false;
    testInstagramConnection({ data: { salonId } })
      .then((r) => {
        if (!cancelled) setIgAccount(r.ok ? (r.username ?? null) : null);
      })
      .catch(() => {
        if (!cancelled) setIgAccount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeIsInstagram, igAccount, salonId]);

  const TABS: { key: Filter; label: string; icon?: typeof MessageCircle }[] = [
    { key: "all", label: tr("Все", "All") },
    { key: "whatsapp", label: "WhatsApp", icon: MessageCircle },
    { key: "instagram", label: "Instagram", icon: Instagram },
  ];

  return (
    <Card className="overflow-hidden p-0">
      <div className="grid h-[70vh] min-h-[520px] grid-cols-1 md:grid-cols-[340px_1fr]">
        {/* Список. На телефоне прячется, когда открыт чат. */}
        <div className={`flex min-h-0 flex-col border-r ${activeConv ? "hidden md:flex" : "flex"}`}>
          <div className="space-y-2.5 border-b p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={tr("Имя, номер или текст сообщения", "Name, number or message text")}
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {/* Переключатель каналов. Кнопки, а не выпадающий список: выбор из трёх должен быть
                виден целиком, иначе владелец не узнает, что Instagram тут вообще есть. */}
            <div
              role="tablist"
              aria-label={tr("Канал", "Channel")}
              className="flex gap-1 rounded-lg bg-muted p-1"
            >
              {TABS.map((t) => {
                const active = filter === t.key;
                const n = counts[t.key];
                return (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(t.key)}
                    className={`qb-press flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium ${
                      active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.icon && <t.icon className="h-3.5 w-3.5" />}
                    <span>{t.label}</span>
                    {n > 0 && <span className="tabular-nums opacity-60">{n}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="space-y-2 p-3">
                <SkeletonBlock className="h-14" />
                <SkeletonBlock className="h-14" />
                <SkeletonBlock className="h-14" />
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={filter === "instagram" ? Instagram : MessageCircle}
                title={
                  search
                    ? tr("Ничего не нашлось", "Nothing found")
                    : tr("Переписок пока нет", "No chats yet")
                }
                body={
                  search
                    ? tr(
                        "Попробуйте другое имя, номер или слово из сообщения.",
                        "Try another name, number or a word from a message.",
                      )
                    : filter === "instagram"
                      ? tr(
                          "Когда клиент напишет в Instagram Direct, разговор появится здесь.",
                          "When a client writes to your Instagram Direct, the conversation appears here.",
                        )
                      : tr(
                          "Когда клиент напишет салону, разговор появится здесь — вместе с ответами ассистента.",
                          "When a client messages the salon, the conversation appears here, together with the assistant's replies.",
                        )
                }
              />
            ) : (
              <ul className="divide-y">
                {filtered.map((c) => {
                  const unread = isUnread(c);
                  const s = statusTone(c, tr);
                  const Icon = channelOf(c) === "instagram" ? Instagram : MessageCircle;
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => setActiveId(c.id)}
                        className={`qb-press flex w-full items-start gap-2.5 px-3 py-3 text-left hover:bg-muted/50 ${
                          activeId === c.id ? "bg-muted" : ""
                        }`}
                      >
                        <Icon
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            channelOf(c) === "instagram" ? "text-info" : "text-success"
                          }`}
                          aria-label={channelOf(c) === "instagram" ? "Instagram" : "WhatsApp"}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span
                              className={`truncate text-sm ${unread ? "font-semibold" : "font-medium"}`}
                            >
                              {displayName(c, tr)}
                            </span>
                            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              {shortTime(c.last_message_at, tr)}
                            </span>
                          </span>
                          <span className="mt-0.5 flex items-center gap-2">
                            <span
                              className={`min-w-0 flex-1 truncate text-xs ${
                                unread ? "text-foreground" : "text-muted-foreground"
                              }`}
                            >
                              {c.last_message_preview || displayContact(c)}
                            </span>
                            {unread && (
                              <span
                                className="h-2 w-2 shrink-0 rounded-full bg-primary"
                                aria-label={tr("Непрочитанное", "Unread")}
                              />
                            )}
                          </span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <StatusBadge tone={s.tone}>{s.text}</StatusBadge>
                            {c.ai_paused && !needsHuman(c) && (
                              <StatusBadge tone="idle">
                                {tr("отвечаете вы", "you reply")}
                              </StatusBadge>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Разговор */}
        <div
          className={`flex min-h-0 flex-col bg-muted/20 ${activeConv ? "flex" : "hidden md:flex"}`}
        >
          {!activeConv ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={MessageCircle}
                title={tr("Выберите разговор", "Select a conversation")}
                body={tr(
                  "Слева — все клиенты, которые вам писали. Ассистент отвечает сам, но вы можете вмешаться в любой момент.",
                  "On the left are all the clients who wrote to you. The assistant replies on its own, but you can step in at any time.",
                )}
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b bg-background px-3 py-2.5 sm:px-4">
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  onClick={() => setActiveId(null)}
                  aria-label={tr("Назад к списку", "Back to the list")}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {channelOf(activeConv) === "instagram" ? (
                      <Instagram className="h-3.5 w-3.5 shrink-0 text-info" />
                    ) : (
                      <MessageCircle className="h-3.5 w-3.5 shrink-0 text-success" />
                    )}
                    <span className="truncate font-medium">{displayName(activeConv, tr)}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {displayContact(activeConv)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Кто сейчас за клавиатурой. Единственное, что администратору нужно знать
                      перед тем, как начать печатать. */}
                  {activeConv.ai_paused || needsHuman(activeConv) ? (
                    <StatusBadge tone={needsHuman(activeConv) ? "error" : "idle"}>
                      <UserRound className="h-3 w-3" />
                      {needsHuman(activeConv)
                        ? tr("ждёт вас", "needs you")
                        : tr("отвечаете вы", "you reply")}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="ok">
                      <Sparkles className="h-3 w-3" />
                      {tr("отвечает ассистент", "assistant replies")}
                    </StatusBadge>
                  )}
                </div>
              </div>

              <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
                {messages.map((m) => {
                  const mine = m.direction === "out";
                  const manual = isManualReply(m);
                  if (m.kind === "system" && !manual) {
                    return (
                      <div key={m.id} className="py-1 text-center text-xs text-muted-foreground">
                        {m.text_body}
                      </div>
                    );
                  }
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`qb-rise max-w-[78%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                          mine
                            ? "rounded-br-sm bg-primary text-primary-foreground"
                            : "rounded-bl-sm border bg-background"
                        }`}
                      >
                        {manual ? (
                          <div className="mb-0.5 text-[10px] font-medium opacity-80">
                            {tr("Вы ответили вручную", "Sent by you from Qabyl")}
                          </div>
                        ) : null}
                        {/* Сообщение, ушедшее в ответ на комментарий с кодовым словом: без подписи
                            непонятно, почему разговор начал салон, а не клиент. */}
                        {m.meta?.commentTrigger ? (
                          <div className="mb-0.5 text-[10px] font-medium opacity-80">
                            {tr(
                              `Ответ на комментарий «${m.meta.commentText ?? m.meta.commentTrigger}»`,
                              `Reply to the comment “${m.meta.commentText ?? m.meta.commentTrigger}”`,
                            )}
                          </div>
                        ) : null}
                        {m.kind === "image" && m.media_path ? (
                          mediaUrls[m.media_path] ? (
                            <a href={mediaUrls[m.media_path]} target="_blank" rel="noreferrer">
                              <img
                                src={mediaUrls[m.media_path]}
                                alt={tr("фото от клиента", "photo from the client")}
                                className="max-h-72 rounded-lg object-cover"
                              />
                            </a>
                          ) : (
                            <div className="flex items-center gap-2 opacity-70">
                              <ImageIcon className="h-4 w-4" />
                              <span>{tr("загружаем фото…", "loading photo…")}</span>
                            </div>
                          )
                        ) : null}
                        {m.text_body ? (
                          <div className={m.kind === "image" ? "mt-1.5" : ""}>{m.text_body}</div>
                        ) : null}
                        <div
                          className={`mt-1 text-right text-[10px] ${
                            mine ? "text-primary-foreground/70" : "text-muted-foreground"
                          }`}
                        >
                          {format(new Date(m.created_at), "HH:mm")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t bg-background p-3">
                {sendError ? (
                  <div className="qb-shake mb-2 text-xs text-danger">{sendError}</div>
                ) : null}
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    // Enter отправляет, Shift+Enter — новая строка: привычка, которой научил
                    // любой мессенджер. Администратор, отвечающий ждущему клиенту, не должен
                    // тянуться к мыши.
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder={tr("Напишите ответ клиенту…", "Write a reply to the client…")}
                    rows={2}
                    className="max-h-32 min-h-[44px] resize-none"
                    disabled={sending}
                  />
                  {/* Подпись рядом со стрелкой — на широком экране. Кнопка отправки клиенту должна
                      читаться без догадок; на телефоне хватает привычной стрелки. */}
                  <Button
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim()}
                    className="h-11 w-11 shrink-0 px-0 sm:w-auto sm:px-4"
                    aria-label={tr("Отправить", "Send")}
                  >
                    <SendHorizonal className="h-4 w-4" />
                    <span className="hidden sm:inline">{tr("Отправить", "Send")}</span>
                  </Button>
                </div>
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  {activeIsInstagram && igAccount ? (
                    <>
                      {tr(
                        "Ответ уйдёт в Instagram Direct от",
                        "Your reply is sent in Instagram Direct as",
                      )}{" "}
                      <b>@{igAccount}</b>.{" "}
                    </>
                  ) : null}
                  {tr(
                    "Пока вы отвечаете, ассистент молчит 5 минут, чтобы не перебивать.",
                    "While you reply, the assistant stays silent for 5 minutes so it does not interrupt.",
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
