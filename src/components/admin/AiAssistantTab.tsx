import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-client";
import { toast } from "sonner";
import { Sparkles, Lock, Copy, RefreshCw, Webhook, MessageCircle } from "lucide-react";
import { getWaWebhookConfig, regenerateWaWebhookToken } from "@/lib/wa-config.functions";
import { WaSimulator } from "./WaSimulator";
import { AiServiceListEditor } from "./AiServiceListEditor";

type Assistant = {
  salon_id: string;
  enabled: boolean;
  whatsapp_phone: string | null;
  greeting: string | null;
  tone_instructions: string | null;
  pricing_rules: string | null;
  languages: string[];
};

const DEFAULT_GREETING =
  "Здравствуйте! 👋 Я помощник салона. Подскажу по услугам, ценам и помогу записаться на удобное время.";
const DEFAULT_TONE =
  "Общайся вежливо, дружелюбно и по делу. Отвечай на русском или кыргызском — на том языке, на котором написал клиент. Если клиент пишет на другом языке, отвечай на русском. Не используй сложных терминов.";
const DEFAULT_PRICING =
  "Если клиент прислал фото волос/ногтей/лица — оцени примерную сложность и назови диапазон цены (от и до), а потом обязательно скажи, что точную цену определит мастер на месте.";

export function AiAssistantTab({ salonId, salonName, onOpenWhatsAppTab }: { salonId: string; salonName: string; onOpenWhatsAppTab?: () => void }) {
  const { isSuperAdmin } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [premiumEnabled, setPremiumEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [data, setData] = useState<Assistant>({
    salon_id: salonId,
    enabled: false,
    whatsapp_phone: "",
    greeting: DEFAULT_GREETING,
    tone_instructions: DEFAULT_TONE,
    pricing_rules: DEFAULT_PRICING,
    languages: ["ru", "ky"],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: salon }, { data: row }] = await Promise.all([
        supabase.from("salons").select("ai_assistant_enabled").eq("id", salonId).maybeSingle(),
        supabase.from("salon_ai_assistant").select("*").eq("salon_id", salonId).maybeSingle(),
      ]);
      if (cancelled) return;
      setPremiumEnabled(!!(salon as any)?.ai_assistant_enabled);
      if (row) {
        setData({
          salon_id: salonId,
          enabled: row.enabled,
          whatsapp_phone: row.whatsapp_phone ?? "",
          greeting: row.greeting ?? DEFAULT_GREETING,
          tone_instructions: row.tone_instructions ?? DEFAULT_TONE,
          pricing_rules: row.pricing_rules ?? DEFAULT_PRICING,
          languages: row.languages?.length ? row.languages : ["ru", "ky"],
        });
      }
      setLoading(false);
      // Load webhook config in background (super-admin only)
      if (isSuperAdmin) {
        try {
          const res = await getWaWebhookConfig({ data: { salonId } });
          if (!cancelled) setWebhookUrl(res.webhook_url);
        } catch (e) {
          console.warn("webhook config load failed", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId, isSuperAdmin]);

  async function refreshWebhook() {
    setWebhookBusy(true);
    try {
      const res = await regenerateWaWebhookToken({ data: { salonId } });
      setWebhookUrl(res.webhook_url);
      toast.success("Новый Webhook URL сгенерирован");
    } catch (e: any) {
      toast.error("Не удалось сгенерировать: " + (e?.message ?? e));
    } finally {
      setWebhookBusy(false);
    }
  }

  async function copyWebhook() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  async function togglePremium(value: boolean) {
    setSaving(true);
    const { error } = await supabase
      .from("salons")
      .update({ ai_assistant_enabled: value })
      .eq("id", salonId);
    setSaving(false);
    if (error) {
      toast.error("Не удалось изменить статус: " + error.message);
      return;
    }
    setPremiumEnabled(value);
    toast.success(value ? "Ассистент подключён к салону" : "Ассистент отключён");
  }

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("salon_ai_assistant").upsert(
      {
        salon_id: salonId,
        enabled: data.enabled,
        whatsapp_phone: data.whatsapp_phone || null,
        greeting: data.greeting || null,
        tone_instructions: data.tone_instructions || null,
        pricing_rules: data.pricing_rules || null,
        languages: data.languages,
      },
      { onConflict: "salon_id" },
    );
    setSaving(false);
    if (error) {
      toast.error("Не удалось сохранить: " + error.message);
      return;
    }
    toast.success("Настройки ассистента сохранены");
  }

  if (loading) return <div className="p-4 text-muted-foreground">Загрузка...</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold">Ассистент в WhatsApp</h3>
              {premiumEnabled ? (
                <Badge variant="default">Подключён</Badge>
              ) : (
                <Badge variant="outline">Не подключён</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Ассистент общается с клиентами от имени салона «{salonName}» в WhatsApp:
              отвечает на вопросы, оценивает услуги по фото, проверяет свободное время
              и сам создаёт запись в расписании.
            </p>
            <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm flex items-start gap-2">
              <MessageCircle className="h-4 w-4 mt-0.5 text-primary shrink-0" />
              <div>
                Учётные данные GreenAPI (<b>Instance ID</b>, <b>API Token</b>, телефон владельца)
                задаются во вкладке{" "}
                <button
                  type="button"
                  onClick={() => onOpenWhatsAppTab?.()}
                  className="font-semibold text-primary underline underline-offset-2 hover:opacity-80"
                >
                  WhatsApp
                </button>
                .
              </div>
            </div>
            {isSuperAdmin ? (
              <div className="mt-4 flex items-center gap-3">
                <Switch checked={premiumEnabled} onCheckedChange={togglePremium} disabled={saving} />
                <Label className="text-sm">Премиум-доступ для салона</Label>
              </div>
            ) : !premiumEnabled ? (
              <div className="mt-3 text-sm text-muted-foreground flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" />
                Чтобы подключить — свяжитесь с поддержкой Qabyl.
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      {isSuperAdmin && (
        <Card className={`p-5 space-y-3 ${!premiumEnabled ? "opacity-60 pointer-events-none select-none" : ""}`}>
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Webhook className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold">Webhook для Green-API <Badge variant="outline" className="ml-2">Только супер-админ</Badge></h3>
              <p className="text-sm text-muted-foreground mt-1">
                Скопируйте этот URL и вставьте в настройках Green-API в поле
                «webhookUrl». Также включите событие <code>incomingMessageReceived</code>.
                Токен зашит в URL — никому не передавайте его.
              </p>
            </div>
          </div>
          {webhookUrl ? (
            <div className="flex gap-2">
              <Input value={webhookUrl} readOnly className="font-mono text-xs" />
              <Button type="button" variant="outline" size="icon" onClick={copyWebhook}>
                <Copy className="h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" size="icon" onClick={refreshWebhook} disabled={webhookBusy} title="Сгенерировать новый">
                <RefreshCw className={`h-4 w-4 ${webhookBusy ? "animate-spin" : ""}`} />
              </Button>
            </div>
          ) : (
            <Button type="button" onClick={refreshWebhook} disabled={webhookBusy}>
              {webhookBusy ? "Генерация..." : "Сгенерировать Webhook URL"}
            </Button>
          )}
        </Card>
      )}

      <Card className={`p-5 space-y-5 ${!premiumEnabled ? "opacity-60 pointer-events-none select-none" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Настройки ассистента</h3>
            <p className="text-sm text-muted-foreground">
              Опишите своими словами — как будто объясняете правила новому сотруднику.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={data.enabled}
              onCheckedChange={(v) => setData({ ...data, enabled: v })}
            />
            <Label className="text-sm whitespace-nowrap">Активен</Label>
          </div>
        </div>

        <div className="space-y-2">
          <Label>WhatsApp-номер салона</Label>
          <Input
            placeholder="+996700000000"
            value={data.whatsapp_phone ?? ""}
            onChange={(e) => setData({ ...data, whatsapp_phone: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Номер, к которому подключён Green-API Instance этого салона. Учётные данные
            Green-API задаются на вкладке «WhatsApp».
          </p>
        </div>

        <div className="space-y-2">
          <Label>Приветствие</Label>
          <Textarea
            rows={3}
            value={data.greeting ?? ""}
            onChange={(e) => setData({ ...data, greeting: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Сообщение, которое ассистент пишет клиенту первым.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Как разговаривать с клиентами</Label>
          <Textarea
            rows={4}
            value={data.tone_instructions ?? ""}
            onChange={(e) => setData({ ...data, tone_instructions: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Управляет тоном и формулировками ассистента: вежливость, обращение на «вы»,
            запрет сленга, фирменные фразы (например — «не использовать сленг», «всегда
            предлагать комбо стрижка+укладка»). Шаги записи (услуга → день → время →
            мастер → подтверждение) выстроены автоматически и всегда соблюдаются.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Как оценивать стоимость по фото</Label>
          <Textarea
            rows={5}
            value={data.pricing_rules ?? ""}
            onChange={(e) => setData({ ...data, pricing_rules: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Например: «Если волосы ниже плеч — это длинные, цена выше. Если на фото
            сложный маникюр с дизайном — добавь +500 сом к базовой стоимости. Точную
            цену всегда подтверждает мастер.»
          </p>
        </div>

        <div className="space-y-2">
          <Label>Языки общения</Label>
          <div className="flex flex-wrap gap-2">
            {[
              { code: "ru", label: "Русский" },
              { code: "ky", label: "Кыргызча" },
              { code: "kk", label: "Қазақша" },
              { code: "en", label: "English" },
            ].map((l) => {
              const active = data.languages.includes(l.code);
              return (
                <Button
                  key={l.code}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setData({
                      ...data,
                      languages: active
                        ? data.languages.filter((c) => c !== l.code)
                        : [...data.languages, l.code],
                    })
                  }
                >
                  {l.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? "Сохранение..." : "Сохранить"}
          </Button>
        </div>
      </Card>

      <div className={!premiumEnabled ? "opacity-60 pointer-events-none select-none" : ""}>
        <AiServiceListEditor salonId={salonId} />
      </div>

      <WaSimulator salonId={salonId} />
    </div>
  );
}
