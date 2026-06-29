import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Bot, ImagePlus, RotateCcw, Send, X } from "lucide-react";
import { simulateWaMessage } from "@/lib/wa-config.functions";

type WaState =
  | "idle" | "awaiting_branch" | "collecting" | "awaiting_photo"
  | "awaiting_price_confirm" | "awaiting_part_of_day" | "awaiting_slot_choice"
  | "awaiting_master_choice" | "awaiting_name" | "awaiting_final_confirm" | "done";

type HistoryMsg = {
  id: string;
  direction: "in" | "out";
  kind: "text" | "image";
  text_body: string | null;
  media_signed_url?: string | null;
  media_mime?: string | null;
  media_path?: string | null;
  created_at: string;
};

type ChatMessage = {
  role: "user" | "bot";
  text?: string;
  imageDataUrl?: string;
  intent?: string;
  state?: string;
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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    // Resize to max 1024px and compress to JPEG 80% — keeps base64 under ~300KB
    // so the server function body stays well within size limits.
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
      const comma = dataUrl.indexOf(",");
      const base64 = dataUrl.slice(comma + 1);
      setPendingImage({ dataUrl, base64, mime: "image/jpeg" });
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
  }

  async function send() {
    const text = inputText.trim();
    if ((!text && !pendingImage) || isLoading) return;
    setInputText("");

    const userMsg: ChatMessage = { role: "user", text: text || undefined, imageDataUrl: pendingImage?.dataUrl };
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
        { role: "bot", text: res.reply, intent: res.debug.intent ?? undefined, state: res.nextState },
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
    <Card className="p-5 space-y-4">
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
          onClick={send}
          disabled={isLoading || (!inputText.trim() && !pendingImage)}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}
