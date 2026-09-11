// «Найти чаты, где ассистент не нужен» — внутри карточки «Контакты без Админа».
//
// Qabyl просматривает переписки и предлагает кандидатов с объяснением. Решает владелец: молча
// выключать ассистента по догадке нельзя — промах стоит салону клиента. «Это клиент» запоминается
// в этом браузере, чтобы тот же номер не предлагался при каждом поиске.
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Search, UserX } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatNumber, plural } from "@/lib/billing-logic";
import {
  findExcludedCandidates,
  type ExcludedCandidate,
} from "@/lib/excluded-suggestions.functions";

const storageKey = (salonId: string) => `qabyl:not-excluded:${salonId}`;

function readDismissed(salonId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey(salonId)) ?? "[]"));
  } catch {
    return new Set();
  }
}

function rememberDismissed(salonId: string, phone: string) {
  try {
    const set = readDismissed(salonId);
    set.add(phone);
    localStorage.setItem(storageKey(salonId), JSON.stringify([...set]));
  } catch {
    /* без памяти номер просто предложится снова */
  }
}

export function ExcludedSuggestions({
  salonId,
  onAdded,
}: {
  salonId: string;
  onAdded: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "ready">("idle");
  const [items, setItems] = useState<ExcludedCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanned, setScanned] = useState({ chats: 0, truncated: false });
  const [saving, setSaving] = useState(false);

  async function scan() {
    setPhase("loading");
    try {
      const r = await findExcludedCandidates({ data: { salonId } });
      const dismissed = readDismissed(salonId);
      const list = r.candidates.filter((c) => !dismissed.has(c.phone));
      setItems(list);
      setSelected(new Set(list.filter((c) => c.confidence === "high").map((c) => c.phone)));
      setScanned({ chats: r.scannedChats, truncated: r.truncated });
      setPhase("ready");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось просмотреть переписки");
      setPhase("idle");
    }
  }

  function toggle(phone: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(phone);
      else next.delete(phone);
      return next;
    });
  }

  function markClient(phone: string) {
    rememberDismissed(salonId, phone);
    setItems((prev) => prev.filter((c) => c.phone !== phone));
    toggle(phone, false);
  }

  async function addSelected() {
    const chosen = items.filter((c) => selected.has(c.phone));
    if (chosen.length === 0) return;
    setSaving(true);
    const { error } = await (supabase as any).from("excluded_contacts").upsert(
      chosen.map((c) => ({
        salon_id: salonId,
        phone: c.phone,
        label: c.name ? `${c.name} · найден автоматически` : "Найден автоматически",
      })),
      { onConflict: "salon_id,phone", ignoreDuplicates: true },
    );
    setSaving(false);
    if (error) {
      toast.error("Не удалось добавить: " + error.message);
      return;
    }
    toast.success(
      `${chosen.length} ${plural(chosen.length, "контакт добавлен", "контакта добавлено", "контактов добавлено")} — ассистент им больше не отвечает`,
    );
    setItems((prev) => prev.filter((c) => !selected.has(c.phone)));
    setSelected(new Set());
    onAdded();
  }

  if (phase === "idle") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center">
        <div className="flex-1 text-sm">
          <p className="font-medium">Найти чаты, где ассистент не нужен</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Qabyl просмотрит переписки за 2 месяца и предложит личные чаты и номера салона. Каждый
            ответ ассистента расходует сообщения тарифа — вы решаете, кого убрать.
          </p>
        </div>
        <Button variant="outline" onClick={scan} className="shrink-0">
          <Search className="mr-2 h-4 w-4" aria-hidden />
          Найти
        </Button>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border p-4 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Просматриваем переписки…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4 text-sm sm:flex-row sm:items-center animate-in fade-in-0">
        <p className="flex-1 text-muted-foreground">
          Среди {formatNumber(scanned.chats)} переписок не нашлось похожих на личные.
        </p>
        <Button variant="ghost" size="sm" onClick={scan}>
          Искать снова
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border animate-in fade-in-0 slide-in-from-top-1 duration-300">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 p-3">
        <p className="text-sm">
          <span className="font-medium">Похоже, ассистент здесь не нужен: {items.length}</span>
          <span className="text-muted-foreground">
            {" "}
            · из {formatNumber(scanned.chats)} переписок{scanned.truncated ? " (самые свежие)" : ""}
          </span>
        </p>
        <Button size="sm" onClick={addSelected} disabled={saving || selected.size === 0}>
          {saving ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <UserX className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          Не отвечать выбранным ({selected.size})
        </Button>
      </div>
      <ul className="max-h-[28rem] divide-y overflow-y-auto">
        {items.map((c) => (
          <li key={c.phone} className="flex gap-3 p-3">
            <Checkbox
              className="mt-1"
              checked={selected.has(c.phone)}
              onCheckedChange={(v) => toggle(c.phone, v === true)}
              aria-label={`Выбрать ${c.name ?? "+" + c.phone}`}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium">{c.name || "Без имени"}</span>
                <span className="font-mono text-xs text-muted-foreground">+{c.phone}</span>
                {c.confidence === "high" && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                    почти точно
                  </span>
                )}
              </div>
              <ul className="list-disc pl-4 text-xs text-muted-foreground">
                {c.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {c.preview && (
                <p className="truncate text-xs italic text-muted-foreground">«{c.preview}»</p>
              )}
              {c.aiReplies > 0 && (
                <p className="text-xs text-muted-foreground">
                  Ассистент ответил {formatNumber(c.aiReplies)}{" "}
                  {plural(c.aiReplies, "раз", "раза", "раз")}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              onClick={() => markClient(c.phone)}
            >
              Это клиент
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
