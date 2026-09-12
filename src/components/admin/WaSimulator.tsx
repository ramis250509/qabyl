import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Bot, ImagePlus, RotateCcw, Send, X } from "lucide-react";
import { simulateWaMessage } from "@/lib/wa-config.functions";

type WaState =
  | "idle" | "awaiting_branch" | "collecting" | "awaiting_service" | "awaiting_photo"
  | "awaiting_price_confirm" | "awaiting_date_choice" | "awaiting_part_of_day"
  | "awaiting_slot_choice" | "awaiting_master_choice" | "awaiting_name"
  | "awaiting_final_confirm" | "done";

type HistoryMsg = {
  id: string;
  direction: "in" | "out";
  kind: "text" | "image";
  text_body: string | null;
  media_signed_url?: string | null;
  media_mime?: string | null;
  media_path?: string | null;
  created_at: string;
  selected_id?: string | null;
};

type InteractiveMessage =
  | { kind: "buttons"; text: string; buttons: Array<{ id: string; text: string }> }
  | { kind: "list"; text: string; buttonText: string; sections: Array<{ title?: string; rows: Array<{ rowId: string; title: string; description?: string; fullName?: string }> }> };

type ChatMessage = {
  role: "user" | "bot";
  text?: string;
  imageDataUrl?: string;
  intent?: string;
  state?: string;
  interactive?: InteractiveMessage | null;
};

export function WaSimulator({ salonId }: { salonId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<HistoryMsg[]>([]);
  const [agentState, setAgentState] = useState<WaState>("idle");
  const [agentStateData, setAgentStateData] = useState<Record<string, unknown>>({});
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; base64: string; mime: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Skip the initial mount scroll — otherwise opening the "Ассистент" tab yanks the whole
    // admin page down to the simulator. Only scroll once the user has actually sent something.
    if (messages.length === 0 && !isLoading) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX = 1024;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width >= height) { height = Math.round(height * MAX / width); width = MAX; }
        else { width = Math.round(width * MAX / height); height = MAX; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      setPendingImage({ dataUrl, base64, mime: "image/jpeg" });
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
  }

  async function send(opts?: { text?: string; selectedId?: string }) {
    const text = opts?.text ?? inputText.trim();
    const selectedId = opts?.selectedId ?? null;
    if ((!text && !pendingImage && !selectedId) || isLoading) return;
    if (!opts) setInputText("");

    const userMsg: ChatMessage = { role: "user", text: text || (selectedId ? `[tap: ${selectedId}]` : undefined), imageDataUrl: pendingImage?.dataUrl };
    setMessages((prev) => [...prev, userMsg]);
    const imageToSend = pendingImage;
    setPendingImage(null);
    setIsLoading(true);

    const prevHistory = history;
    try {
      const res = await simulateWaMessage({
        data: {
          salonId,
          messageText: text,
          history: prevHistory,
          state: agentState,
          stateData: agentStateData,
          selectedBranchId,
          selectedId,
          imageBase64: imageToSend?.base64,
          imageMime: imageToSend?.mime,
        },
      });

      const now = new Date().toISOString();
      const inMsg: HistoryMsg = {
        id: crypto.randomUUID(),
        direction: "in",
        kind: imageToSend ? "image" : "text",
        text_body: text || null,
        selected_id: selectedId,
        created_at: now,
      };
      const outMsg: HistoryMsg = {
        id: crypto.randomUUID(),
        direction: "out",
        kind: "text",
        text_body: res.reply,
        created_at: now,
      };

      setHistory([...prevHistory, inMsg, outMsg]);
      setAgentState(res.nextState as WaState);
      setAgentStateData(res.nextStateData as Record<string, unknown>);
      setSelectedBranchId(res.selectedBranchId);
      setMessages((prev) => [
        ...prev,
        {
          role: "bot",
          text: res.reply,
          intent: res.debug.intent ?? undefined,
          state: res.nextState,
          interactive: (res as any).interactiveMessage ?? null,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "bot", text: "❌ Ошибка: " + (e?.message ?? String(e)) },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setHistory([]);
    setAgentState("idle");
    setAgentStateData({});
    setSelectedBranchId(null);
    setInputText("");
    setPendingImage(null);
  }

  return (
    <Card className="p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h3 className="font-semibold">Симулятор чата</h3>
          <Badge variant="outline" className="text-xs">без WhatsApp</Badge>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={reset} className="gap-1.5 text-muted-foreground">
          <RotateCcw className="h-3.5 w-3.5" />
          Сбросить
        </Button>
      </div>

      <div className="h-80 overflow-y-auto border rounded-lg bg-muted/20 p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground mt-10">
            Напишите «Здравствуйте» — и бот ответит так же, как в реальном WhatsApp
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
            <div
              className={`max-w-[82%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words space-y-1 ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background border shadow-sm"
              }`}
            >
              {m.imageDataUrl && (
                <img src={m.imageDataUrl} alt="фото" className="rounded max-h-40 w-auto" />
              )}
              {m.text && <span>{m.text}</span>}
            </div>

            {/* Interactive message: render buttons or list rows */}
            {m.role === "bot" && m.interactive && (
              <div className="max-w-[82%] mt-1.5 space-y-1.5">
                {m.interactive.kind === "buttons" && (
                  <div className="flex gap-2 flex-wrap">
                    {m.interactive.buttons.map((btn) => (
                      <button
                        key={btn.id}
                        disabled={isLoading}
                        onClick={() => send({ text: btn.text, selectedId: btn.id })}
                        className="text-xs px-3 py-1.5 rounded-full border border-primary text-primary bg-background hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {btn.text}
                      </button>
                    ))}
                  </div>
                )}
                {m.interactive.kind === "list" && (
                  <div className="border rounded-lg bg-background shadow-sm overflow-hidden w-72">
                    {m.interactive.sections.map((sec, si) => (
                      <div key={si} className={si > 0 ? "border-t-4 border-muted" : ""}>
                        {sec.title && (
                          <div className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-primary bg-primary/10">
                            {sec.title}
                          </div>
                        )}
                        {sec.rows.map((row) => (
                          <button
                            key={row.rowId}
                            disabled={isLoading}
                            onClick={() => send({ text: row.fullName ?? row.title, selectedId: row.rowId })}
                            className="w-full text-left px-3 py-2 border-t first:border-t-0 hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            <div className="text-sm font-medium leading-snug break-words">{row.fullName ?? row.title}</div>
                            {row.description && (
                              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">{row.description}</div>
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {m.role === "bot" && (m.intent || m.state) && (
              <p className="text-[10px] text-muted-foreground mt-0.5 px-1">
                {[
                  m.intent ? `intent: ${m.intent}` : null,
                  m.state ? `state: ${m.state}` : null,
                ]
                  .filter(Boolean)
                  .join(" | ")}
              </p>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-start">
            <div className="bg-background border shadow-sm rounded-xl px-3 py-2 text-sm text-muted-foreground animate-pulse">
              печатает...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {pendingImage && (
        <div className="flex items-center gap-2 px-1">
          <div className="relative inline-block">
            <img src={pendingImage.dataUrl} alt="preview" className="h-14 w-14 rounded object-cover border" />
            <button
              type="button"
              onClick={() => setPendingImage(null)}
              className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <span className="text-xs text-muted-foreground">Фото будет отправлено вместе с сообщением</span>
        </div>
      )}

      <div className="flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          title="Прикрепить фото"
          disabled={isLoading}
        >
          <ImagePlus className="h-4 w-4" />
        </Button>
        <Input
          placeholder="Напишите сообщение клиента..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={isLoading}
        />
        <Button
          type="button"
          onClick={() => send()}
          disabled={isLoading || (!inputText.trim() && !pendingImage)}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}
