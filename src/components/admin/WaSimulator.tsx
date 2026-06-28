import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Bot, RotateCcw, Send } from "lucide-react";
import { simulateWaMessage } from "@/lib/wa-config.functions";

type WaState =
  | "idle" | "awaiting_branch" | "collecting" | "awaiting_photo"
  | "awaiting_price_confirm" | "awaiting_part_of_day" | "awaiting_slot_choice"
  | "awaiting_master_choice" | "awaiting_name" | "awaiting_final_confirm" | "done";

type HistoryMsg = {
  id: string;
  direction: "in" | "out";
  kind: "text";
  text_body: string | null;
  created_at: string;
};

type ChatMessage = {
  role: "user" | "bot";
  text: string;
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
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function send() {
    const text = inputText.trim();
    if (!text || isLoading) return;
    setInputText("");
    setMessages((prev) => [...prev, { role: "user", text }]);
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
        },
      });

      const now = new Date().toISOString();
      const userMsg: HistoryMsg = { id: crypto.randomUUID(), direction: "in", kind: "text", text_body: text, created_at: now };
      const botMsg: HistoryMsg = { id: crypto.randomUUID(), direction: "out", kind: "text", text_body: res.reply, created_at: now };

      setHistory([...prevHistory, userMsg, botMsg]);
      setAgentState(res.nextState as WaState);
      setAgentStateData(res.nextStateData as Record<string, unknown>);
      setSelectedBranchId(res.selectedBranchId);
      setMessages((prev) => [
        ...prev,
        { role: "bot", text: res.reply, intent: res.debug.intent, state: res.nextState },
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
              className={`max-w-[82%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background border shadow-sm"
              }`}
            >
              {m.text}
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

      <div className="flex gap-2">
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
        <Button type="button" onClick={send} disabled={isLoading || !inputText.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}
