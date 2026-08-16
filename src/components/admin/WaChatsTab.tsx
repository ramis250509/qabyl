import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { sendManualChatMessage } from "@/lib/wa-chats.functions";
import { MessageCircle, Search, ImageIcon, SendHorizonal } from "lucide-react";
import { format } from "date-fns";

type Conversation = {
  id: string;
  salon_id: string;
  client_phone: string;
  client_name: string | null;
  status: "active" | "booked" | "closed";
  last_message_at: string;
  last_message_preview: string | null;
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
  // `manual` marks a reply an admin typed here, as opposed to the assistant's own bookkeeping
  // notes — both are stored as kind "system" so the agent picks them up as handoff context.
  meta: { manual?: boolean } | null;
};

// A human answer is drawn as a real outgoing bubble; anything else stored as "system" stays a
// quiet centred note (that is the assistant's own bookkeeping, not something the client sees here).
const isManualReply = (m: Message) => m.kind === "system" && m.meta?.manual === true;

function statusBadge(s: Conversation["status"]) {
  if (s === "booked") return <Badge>Записан</Badge>;
  if (s === "closed") return <Badge variant="outline">Закрыт</Badge>;
  return <Badge variant="secondary">Активный</Badge>;
}

// The assistant gave up after repeated confusion and flagged the chat for a live admin.
const needsHuman = (c: Conversation) => c.state_data?.needs_human === true;

export function WaChatsTab({ salonId }: { salonId: string }) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Switching chats must not carry a half-typed answer into someone else's conversation.
  useEffect(() => {
    setDraft("");
    setSendError(null);
  }, [activeId]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendManualChatMessage({ data: { conversationId: activeId, text } });
      // The sent message arrives through the realtime subscription like any other, so nothing is
      // appended here — doing both would show it twice.
      setDraft("");
    } catch (e: any) {
      // The server deliberately refuses to store a message the provider rejected, so this is the
      // only place the admin learns it did not go out. Showing the provider's own wording matters:
      // "outside the 24-hour window" and "token expired" need completely different fixes.
      setSendError(e?.message ?? "Не удалось отправить сообщение");
    } finally {
      setSending(false);
    }
  }

  // load conversations + subscribe
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
      if (data?.length && !activeId) setActiveId(data[0].id);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`wa-conv-${salonId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "wa_conversations", filter: `salon_id=eq.${salonId}` },
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

  // load messages for active conversation + subscribe
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
        { event: "INSERT", schema: "public", table: "wa_messages", filter: `conversation_id=eq.${activeId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight, behavior: "smooth" });
          });
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [activeId]);

  // sign URLs for image messages
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return convs;
    return convs.filter(
      (c) =>
        (c.client_name ?? "").toLowerCase().includes(q) ||
        c.client_phone.toLowerCase().includes(q),
    );
  }, [convs, search]);

  const activeConv = convs.find((c) => c.id === activeId) ?? null;

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] h-[70vh] min-h-[500px]">
        {/* Sidebar */}
        <div className="border-r flex flex-col min-h-0">
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                placeholder="Поиск по имени или номеру"
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">Загрузка...</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground text-center">
                Пока нет диалогов. Когда клиент напишет салону в WhatsApp, чат появится здесь.
              </div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={`w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition ${
                    activeId === c.id ? "bg-muted" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate text-sm">
                      {c.client_name || c.client_phone}
                    </div>
                    {needsHuman(c) ? <Badge variant="destructive">Нужен ответ</Badge> : statusBadge(c.status)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                    {c.last_message_preview || c.client_phone}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                    {format(new Date(c.last_message_at), "dd.MM HH:mm")}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Chat */}
        <div className="flex flex-col min-h-0 bg-muted/20">
          {!activeConv ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm flex-col gap-2 p-6">
              <MessageCircle className="h-8 w-8 opacity-40" />
              Выберите диалог слева
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b bg-background flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    {activeConv.client_name || activeConv.client_phone}
                  </div>
                  <div className="text-xs text-muted-foreground">{activeConv.client_phone}</div>
                </div>
                {needsHuman(activeConv) ? (
                  <Badge variant="destructive">Нужен ответ администратора</Badge>
                ) : (
                  statusBadge(activeConv.status)
                )}
              </div>
              <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-2">
                {messages.map((m) => {
                  const mine = m.direction === "out";
                  const manual = isManualReply(m);
                  if (m.kind === "system" && !manual) {
                    return (
                      <div key={m.id} className="text-center text-xs text-muted-foreground py-1">
                        {m.text_body}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={m.id}
                      className={`flex ${mine ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                          mine
                            ? "bg-primary text-primary-foreground rounded-br-sm"
                            : "bg-background border rounded-bl-sm"
                        }`}
                      >
                        {manual ? (
                          <div className="text-[10px] font-medium opacity-80 mb-0.5">
                            Администратор
                          </div>
                        ) : null}
                        {m.kind === "image" && m.media_path ? (
                          mediaUrls[m.media_path] ? (
                            <a href={mediaUrls[m.media_path]} target="_blank" rel="noreferrer">
                              <img
                                src={mediaUrls[m.media_path]}
                                alt="фото"
                                className="rounded-lg max-h-72 object-cover"
                              />
                            </a>
                          ) : (
                            <div className="flex items-center gap-2 opacity-70">
                              <ImageIcon className="h-4 w-4" />
                              <span>загрузка фото...</span>
                            </div>
                          )
                        ) : null}
                        {m.text_body ? (
                          <div className={m.kind === "image" ? "mt-1.5" : ""}>{m.text_body}</div>
                        ) : null}
                        <div
                          className={`text-[10px] mt-1 ${
                            mine ? "text-primary-foreground/70" : "text-muted-foreground"
                          } text-right`}
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
                  <div className="mb-2 text-xs text-destructive">{sendError}</div>
                ) : null}
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    // Enter sends, Shift+Enter makes a new line — the habit every messenger has
                    // trained. An admin answering a waiting client should not have to reach for
                    // the mouse.
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder="Напишите ответ клиенту..."
                    rows={2}
                    className="resize-none min-h-[44px] max-h-32"
                    disabled={sending}
                  />
                  <Button
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim()}
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label="Отправить"
                  >
                    <SendHorizonal className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  Пока вы отвечаете, ассистент молчит 5 минут, чтобы не перебивать.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
