// Admin panel → Prepayment tab: turn on "hold the slot until the client pays".
//
// Prepayment is off for every salon until someone deliberately switches it on here, so this screen
// is the only thing standing between the feature and the rest of the product. Two consequences
// shape the layout:
//
//   * The switch is the first control and everything else is disabled while it is off — a
//     half-filled form must never be mistaken for a live configuration.
//   * The requisites are the one field that cannot be wrong. If the receipt verifier has no phone
//     or card to compare against, it cannot tell a real payment from a screenshot of someone
//     else's, so it degrades to "send everything to manual review". The form says so out loud
//     instead of letting the salon discover it a week later.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { SkeletonBlock } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, Wallet } from "lucide-react";
import { getPrepaymentSettings, upsertPrepaymentSettings } from "@/lib/prepayment.functions";
import { Link } from "@tanstack/react-router";
import { usePlanFeatures } from "@/hooks/use-plan-features";
import { supabase } from "@/integrations/supabase/client";

type AmountType = "fixed" | "percent";
type VerifyMode = "auto" | "auto_under_amount" | "manual_after_verify" | "manual_always";
type Currency = "KGS" | "USD" | "RUB" | "KZT" | "EUR";

type FormState = {
  enabled: boolean;
  amountType: AmountType;
  amountValue: number;
  minAmount: number | null;
  maxAmount: number | null;
  currency: Currency;
  holdMinutes: number;
  verifyMode: VerifyMode;
  autoMaxAmount: number | null;
  recipientName: string;
  bank: string;
  phone: string;
  card: string;
  instructionRu: string;
  qrPath: string | null;
  qrUrl: string | null;
};

const EMPTY: FormState = {
  enabled: false,
  amountType: "fixed",
  amountValue: 0,
  minAmount: null,
  maxAmount: null,
  currency: "KGS",
  holdMinutes: 30,
  verifyMode: "auto",
  autoMaxAmount: null,
  recipientName: "",
  bank: "MBANK",
  phone: "",
  card: "",
  instructionRu: "",
  qrPath: null,
  qrUrl: null,
};

function num(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function PrepaymentTab({ salonId }: { salonId: string }) {
  // Предоплата входит не во все тарифы. Включить её на таком тарифе нельзя; уже включённая
  // продолжает храниться, но ассистент записывает без неё — до перехода на тариф выше.
  const plan = usePlanFeatures(salonId);
  const planAllows = plan.has("prepayment");
  const load = useServerFn(getPrepaymentSettings);
  const save = useServerFn(upsertPrepaymentSettings);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row: any = await load({ data: { salonId } });
        if (cancelled || !row) return;
        const d = row.recipient_details ?? {};
        setForm({
          enabled: Boolean(row.enabled),
          amountType: (row.amount_type ?? "fixed") as AmountType,
          amountValue: Number(row.amount_value ?? 0),
          minAmount: row.min_amount == null ? null : Number(row.min_amount),
          maxAmount: row.max_amount == null ? null : Number(row.max_amount),
          currency: (row.currency ?? "KGS") as Currency,
          holdMinutes: Number(row.hold_minutes ?? 30),
          verifyMode: (row.verify_mode ?? "auto") as VerifyMode,
          autoMaxAmount: row.auto_max_amount == null ? null : Number(row.auto_max_amount),
          recipientName: row.recipient_name ?? "",
          bank: d.bank ?? "MBANK",
          phone: d.phone ?? "",
          card: d.card ?? "",
          instructionRu: row.instruction_ru ?? "",
          qrPath: row.qr_path ?? null,
          qrUrl: row.qr_url ?? null,
        });
      } catch (e: any) {
        if (!cancelled) toast.error(humanError(e, "Не удалось загрузить настройки предоплаты"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId, load]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // ── QR upload ─────────────────────────────────────────────────────────────
  // Straight to storage from the browser rather than base64 through a server function: the
  // bucket's RLS policies already scope writes to <salon_id>/… , and a 2 MB image round-tripped
  // as base64 through a server fn is 33% larger for no benefit.
  const [qrBusy, setQrBusy] = useState(false);
  const MAX_QR_BYTES = 3 * 1024 * 1024;

  async function uploadQr(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("QR должен быть картинкой (PNG, JPG или WEBP)");
      return;
    }
    if (file.size > MAX_QR_BYTES) {
      toast.error("Файл слишком большой — до 3 МБ");
      return;
    }
    setQrBusy(true);
    try {
      const ext = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      // The salon id MUST be the first path segment: it is what both the storage policy and the
      // agent's pre-send check use to prove the QR belongs to this salon.
      const path = `${salonId}/${crypto.randomUUID()}.${ext || "png"}`;
      const { error } = await supabase.storage
        .from("payment-qr")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(error.message);
      const { data: pub } = supabase.storage.from("payment-qr").getPublicUrl(path);
      const oldPath = form.qrPath;
      setForm((f) => ({ ...f, qrPath: path, qrUrl: pub.publicUrl }));
      // Best-effort cleanup of the replaced image; an orphan costs a few KB, a failed delete
      // must not lose the new QR the owner just uploaded.
      if (oldPath) await supabase.storage.from("payment-qr").remove([oldPath]);
      toast.success("QR загружен — не забудьте сохранить настройки");
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось загрузить QR"));
    } finally {
      setQrBusy(false);
    }
  }

  async function removeQr() {
    const path = form.qrPath;
    setForm((f) => ({ ...f, qrPath: null, qrUrl: null }));
    if (path) await supabase.storage.from("payment-qr").remove([path]);
    toast.success("QR удалён — не забудьте сохранить настройки");
  }

  // Enabling with no requisites would produce bookings nobody can pay, so it is refused outright
  // rather than saved and quietly broken.
  const missingRequisites = form.enabled && !form.phone.trim() && !form.card.trim();
  const amountInvalid = form.enabled && !(form.amountValue > 0);
  const percentInvalid = form.enabled && form.amountType === "percent" && form.amountValue > 100;

  async function onSave() {
    if (missingRequisites) {
      toast.error("Укажите номер телефона или карту для перевода — без них чек проверить нельзя");
      return;
    }
    if (amountInvalid) {
      toast.error("Сумма предоплаты должна быть больше нуля");
      return;
    }
    if (percentInvalid) {
      toast.error("Процент не может быть больше 100");
      return;
    }
    setSaving(true);
    try {
      await save({
        data: {
          salonId,
          enabled: form.enabled,
          amountType: form.amountType,
          amountValue: form.amountValue,
          minAmount: form.minAmount,
          maxAmount: form.maxAmount,
          currency: form.currency,
          holdMinutes: form.holdMinutes,
          verifyMode: form.verifyMode,
          autoMaxAmount: form.autoMaxAmount,
          recipientName: form.recipientName.trim() || null,
          recipientDetails: {
            ...(form.bank.trim() ? { bank: form.bank.trim() } : {}),
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
            ...(form.card.trim() ? { card: form.card.trim() } : {}),
          },
          instructionRu: form.instructionRu.trim() || null,
          instructionKy: null,
          instructionEn: null,
          qrPath: form.qrPath,
          qrUrl: form.qrUrl,
        },
      });
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось сохранить"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonBlock className="h-28" />
        <SkeletonBlock className="h-48" />
      </div>
    );
  }

  const off = !form.enabled;

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              <h3 className="text-lg font-medium">Предоплата</h3>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Когда включено, ассистент не подтверждает запись сразу: он удерживает время, называет
              сумму и реквизиты и просит прислать скриншот чека прямо в переписку. Чек проверяется
              автоматически — сумма, получатель, время перевода, повторное использование. Если
              оплаты нет до конца удержания, слот освобождается сам.
            </p>
          </div>
          <Switch
            checked={form.enabled}
            disabled={!planAllows && !form.enabled}
            onCheckedChange={(v) => set("enabled", v)}
            aria-label="Включить предоплату"
          />
        </div>
      </Card>

      {!planAllows && (
        <Card className="flex flex-col gap-3 border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm">
            Предоплата за запись входит в тарифы выше вашего.
            {form.enabled ? " Сейчас ассистент записывает клиентов без предоплаты." : ""}
          </p>
          <Button asChild size="sm">
            <Link to="/admin/billing">Сменить тариф</Link>
          </Button>
        </Card>
      )}

      <Card className={`space-y-6 p-6 ${off ? "pointer-events-none opacity-50" : ""}`}>
        <div className="space-y-4">
          <h4 className="font-medium">Сколько брать</h4>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Тип суммы</Label>
              <Select
                value={form.amountType}
                onValueChange={(v) => set("amountType", v as AmountType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Фиксированная сумма</SelectItem>
                  <SelectItem value="percent">Процент от цены услуги</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{form.amountType === "fixed" ? "Сумма" : "Процент"}</Label>
              <Input
                type="number"
                min={0}
                value={String(form.amountValue)}
                onChange={(e) => set("amountValue", num(e.target.value) ?? 0)}
              />
            </div>
            <div className="space-y-2">
              <Label>Валюта</Label>
              <Select value={form.currency} onValueChange={(v) => set("currency", v as Currency)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["KGS", "KZT", "RUB", "USD", "EUR"] as Currency[]).map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.amountType === "percent" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Не меньше (необязательно)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.minAmount == null ? "" : String(form.minAmount)}
                  onChange={(e) => set("minAmount", num(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Не больше (необязательно)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.maxAmount == null ? "" : String(form.maxAmount)}
                  onChange={(e) => set("maxAmount", num(e.target.value))}
                />
              </div>
            </div>
          )}

          <div className="max-w-xs space-y-2">
            <Label>Сколько держать слот, минут</Label>
            <Input
              type="number"
              min={5}
              max={720}
              value={String(form.holdMinutes)}
              onChange={(e) =>
                set("holdMinutes", Math.min(720, Math.max(5, num(e.target.value) ?? 30)))
              }
            />
            <p className="text-xs text-muted-foreground">
              От 5 до 720. Слишком мало — клиент не успеет дойти до банка; слишком много — время
              простаивает занятым. Обычно хватает 30 минут.
            </p>
          </div>
        </div>

        <div className="space-y-4 border-t pt-6">
          <h4 className="font-medium">Куда переводить</h4>
          {missingRequisites && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>
                Укажите номер телефона или карту. Без них проверка не сможет отличить перевод вам от
                перевода кому-то другому и будет отправлять каждый чек на ручную проверку.
              </span>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Банк</Label>
              <Input value={form.bank} onChange={(e) => set("bank", e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Сейчас автоматически распознаются чеки MBANK. Чеки других банков будут уходить на
                ручную проверку.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Получатель (как в чеке)</Label>
              <Input
                value={form.recipientName}
                onChange={(e) => set("recipientName", e.target.value)}
                placeholder="Айгуль А."
              />
            </div>
            <div className="space-y-2">
              <Label>Номер телефона для перевода</Label>
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="+996 555 112233"
              />
            </div>
            <div className="space-y-2">
              <Label>Карта (необязательно)</Label>
              <Input
                value={form.card}
                onChange={(e) => set("card", e.target.value)}
                placeholder="4169 •••• •••• 1234"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4 border-t pt-6">
          <h4 className="font-medium">Как подтверждать</h4>
          <div className="max-w-md space-y-2">
            <Select
              value={form.verifyMode}
              onValueChange={(v) => set("verifyMode", v as VerifyMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Автоматически, если проверка пройдена</SelectItem>
                <SelectItem value="auto_under_amount">
                  Автоматически до определённой суммы
                </SelectItem>
                <SelectItem value="manual_after_verify">Всегда подтверждаю вручную</SelectItem>
                <SelectItem value="manual_always">Не проверять автоматически вообще</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              В любом режиме сомнительный чек уходит на ручную проверку — автоматически
              подтверждается только то, что прошло все проверки.
            </p>
          </div>
          {form.verifyMode === "auto_under_amount" && (
            <div className="max-w-xs space-y-2">
              <Label>Автоматически до суммы</Label>
              <Input
                type="number"
                min={0}
                value={form.autoMaxAmount == null ? "" : String(form.autoMaxAmount)}
                onChange={(e) => set("autoMaxAmount", num(e.target.value))}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label>Что написать клиенту вместе с реквизитами (необязательно)</Label>
            <Textarea
              rows={3}
              value={form.instructionRu}
              onChange={(e) => set("instructionRu", e.target.value)}
              placeholder="Например: в комментарии к переводу укажите своё имя."
            />
          </div>

          {/* QR. Sent as an image right after the assistant names the amount — a client who can
              scan instead of retyping a card number pays noticeably more often. */}
          <div className="space-y-2">
            <Label>QR-код для оплаты (необязательно)</Label>
            <p className="text-xs text-muted-foreground">
              Скриншот QR из вашего банковского приложения. Ассистент отправит его клиенту сразу
              после того, как назовёт сумму — и в WhatsApp, и в Instagram. Реквизиты текстом всё
              равно останутся: если картинка не дойдёт, клиент сможет перевести по номеру.
            </p>
            {form.qrUrl && (
              <div className="flex items-center gap-3">
                <img
                  src={form.qrUrl}
                  alt="QR для оплаты"
                  className="h-28 w-28 rounded border object-contain"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={removeQr}
                  disabled={qrBusy}
                >
                  Удалить QR
                </Button>
              </div>
            )}
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={qrBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset the input so re-picking the SAME file after a failed upload still fires.
                e.target.value = "";
                if (file) void uploadQr(file);
              }}
            />
            {qrBusy && <p className="text-xs text-muted-foreground">Загрузка…</p>}
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving || loading}>
          {saving ? "Сохранение…" : "Сохранить"}
        </Button>
      </div>
    </div>
  );
}
