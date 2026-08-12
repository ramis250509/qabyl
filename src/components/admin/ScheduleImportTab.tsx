// Operator screen for importing a salon's existing spreadsheet calendar.
//
// The screen is deliberately built around REVIEW rather than around a button. A hand-kept
// schedule contains cells no parser can resolve — a booking for two people, an amount that
// could be a deposit or the full fee — so the flow is: fetch → show every row with what we
// understood next to what was actually written → the operator unticks what looks wrong →
// commit → keep the batch so it can be undone in one click.
//
// Super-admin only, and further gated server-side by SCHEDULE_IMPORT_SALON_IDS.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  commitScheduleImport,
  listImportBatches,
  previewScheduleImport,
  rollbackScheduleImport,
} from "@/lib/schedule-import.functions";

type Plan = Awaited<ReturnType<typeof previewScheduleImport>>;
type Batch = Awaited<ReturnType<typeof listImportBatches>>[number];

const VISIT_KINDS = [
  { key: "consultation", label: "Первичная консультация" },
  { key: "repeat", label: "Повторный приём" },
  { key: "program", label: "Программа / проект" },
  { key: "injection", label: "Укол / процедура" },
  { key: "unknown", label: "Не определено" },
] as const;

const VERDICT_META: Record<string, { label: string; tone: string }> = {
  new: { label: "импортируем", tone: "bg-emerald-100 text-emerald-900" },
  duplicate: { label: "уже есть", tone: "bg-slate-100 text-slate-700" },
  conflict: { label: "время занято", tone: "bg-amber-100 text-amber-900" },
  needs_review: { label: "проверьте", tone: "bg-amber-100 text-amber-900" },
  unmappable: { label: "нет услуги", tone: "bg-rose-100 text-rose-900" },
};

export function ScheduleImportTab({ salonId }: { salonId: string }) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [visitMap, setVisitMap] = useState<Record<string, string | null>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [batches, setBatches] = useState<Batch[]>([]);
  const [busy, setBusy] = useState<null | "preview" | "commit" | "rollback">(null);

  async function refreshBatches() {
    try {
      setBatches(await listImportBatches({ data: { salonId } }));
    } catch {
      // A failure here is cosmetic — never let it mask the import result itself.
    }
  }

  async function onPreview() {
    setBusy("preview");
    try {
      const p = await previewScheduleImport({ data: { salonId, sourceUrl, visitMap } });
      setPlan(p);
      // Pre-tick exactly the rows we would write. Everything doubtful stays off by default:
      // the operator opts INTO a questionable row, never has to notice and opt out of it.
      setAccepted(new Set(p.rows.filter((r) => r.verdict === "new").map((r) => r.importKey)));
      await refreshBatches();
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось прочитать таблицу");
    } finally {
      setBusy(null);
    }
  }

  async function onCommit() {
    if (!plan || accepted.size === 0) return;
    setBusy("commit");
    try {
      const res = await commitScheduleImport({
        data: { salonId, sourceUrl, visitMap, acceptKeys: [...accepted] },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const failed = res.failures.length;
      toast.success(
        `Импортировано ${res.inserted} из ${res.requested}` +
          (failed ? `. Не удалось: ${failed}` : ""),
      );
      if (failed) {
        // Never swallow a partial failure behind a green toast — name the rows.
        console.error("[schedule-import] failures", res.failures);
      }
      await onPreview();
    } catch (e: any) {
      toast.error(e?.message ?? "Импорт не выполнен");
    } finally {
      setBusy(null);
    }
  }

  async function onRollback(batchId: string) {
    if (!confirm("Удалить все записи этого импорта? Действие затронет только их.")) return;
    setBusy("rollback");
    try {
      const res = await rollbackScheduleImport({ data: { salonId, batchId } });
      toast.success(`Удалено записей: ${res.deleted}`);
      await refreshBatches();
      if (plan) await onPreview();
    } catch (e: any) {
      toast.error(e?.message ?? "Откат не выполнен");
    } finally {
      setBusy(null);
    }
  }

  function toggle(key: string) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const canCommit = plan && accepted.size > 0 && plan.unmappedKinds.length === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Импорт расписания из Google Таблицы</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Ссылка на таблицу</Label>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
            />
            <p className="text-xs text-muted-foreground">
              У таблицы должен быть доступ «Всем, у кого есть ссылка — Просмотр». Ничего не
              записывается, пока вы не нажмёте «Импортировать» на следующем шаге.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Какая услуга соответствует виду приёма</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {VISIT_KINDS.map((k) => (
                <div key={k.key} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-sm text-muted-foreground">{k.label}</span>
                  <Select
                    value={visitMap[k.key] ?? ""}
                    onValueChange={(v) => setVisitMap({ ...visitMap, [k.key]: v || null })}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue placeholder="— не импортировать —" />
                    </SelectTrigger>
                    <SelectContent>
                      {(plan?.services ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} · {s.price} сом
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {!plan && (
              <p className="text-xs text-muted-foreground">
                Список услуг появится после первого чтения таблицы.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button onClick={onPreview} disabled={!sourceUrl || busy !== null}>
              {busy === "preview" ? "Читаю…" : "Прочитать таблицу"}
            </Button>
            <Button onClick={onCommit} disabled={!canCommit || busy !== null} variant="default">
              {busy === "commit" ? "Импортирую…" : `Импортировать (${accepted.size})`}
            </Button>
          </div>
          {plan && plan.unmappedKinds.length > 0 && (
            <p className="text-sm text-amber-700">
              Выберите услугу для видов приёма: {plan.unmappedKinds.join(", ")} — иначе эти строки
              не импортируются.
            </p>
          )}
        </CardContent>
      </Card>

      {plan && (
        <Card>
          <CardHeader>
            <CardTitle>
              Что нашлось: {plan.rows.length} строк ·{" "}
              {Object.entries(plan.summary)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${VERDICT_META[k]?.label ?? k}: ${n}`)
                .join(" · ")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {plan.parseIssues.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                {plan.parseIssues.map((i, idx) => (
                  <div key={idx}>
                    строка {i.row}: {i.message}
                  </div>
                ))}
              </div>
            )}

            <div className="max-h-[28rem] overflow-auto rounded border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left">
                    <th className="w-8 p-2" />
                    <th className="p-2">Дата и время</th>
                    <th className="p-2">Клиент</th>
                    <th className="p-2">Услуга</th>
                    <th className="p-2">Сумма</th>
                    <th className="p-2">Статус</th>
                    <th className="p-2">В таблице написано</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => {
                    const meta = VERDICT_META[r.verdict] ?? VERDICT_META.new;
                    return (
                      <tr key={r.importKey} className="border-t align-top">
                        <td className="p-2">
                          <Checkbox
                            checked={accepted.has(r.importKey)}
                            disabled={r.verdict !== "new"}
                            onCheckedChange={() => toggle(r.importKey)}
                          />
                        </td>
                        <td className="whitespace-nowrap p-2">
                          {r.booking.date} {r.booking.startTime}–{r.booking.endTime}
                        </td>
                        <td className="p-2">{r.booking.clientName || "—"}</td>
                        <td className="p-2">{r.serviceName ?? "—"}</td>
                        <td className="whitespace-nowrap p-2">
                          {r.booking.paid !== null ? `${r.booking.paid}` : "—"}
                          {r.booking.remainder !== null ? ` (ост. ${r.booking.remainder})` : ""}
                        </td>
                        <td className="p-2">
                          <Badge className={meta.tone} variant="secondary">
                            {meta.label}
                          </Badge>
                          {r.status === "completed" && (
                            <div className="mt-1 text-xs text-muted-foreground">завершено</div>
                          )}
                          {r.reason && (
                            <div className="mt-1 text-xs text-muted-foreground">{r.reason}</div>
                          )}
                        </td>
                        {/* The source cell, verbatim. This column is the whole reason the
                            operator can trust the ones above it. */}
                        <td className="p-2 text-xs text-muted-foreground">{r.booking.raw}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {batches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Прошлые импорты</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {batches.map((b: any) => (
              <div key={b.id} className="flex items-center justify-between gap-3 border-b py-2">
                <div className="min-w-0 text-sm">
                  <div>{new Date(b.created_at).toLocaleString("ru-RU")}</div>
                  <div className="text-xs text-muted-foreground">
                    записей сейчас: {b.liveCount}
                    {b.rolled_back_at ? " · откачен" : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || b.liveCount === 0}
                  onClick={() => onRollback(b.id)}
                >
                  Откатить
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
