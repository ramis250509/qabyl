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
  manage_cutoff_hours: number;
  engine: "v3" | "v4";
  knowledge_base: string | null;
};

const DEFAULT_GREETING =
  "Здравствуйте! 👋 Я помощник салона. Подскажу по услугам, ценам и помогу записаться на удобное время.";
const DEFAULT_TONE =
  "Общайся вежливо, дружелюбно и по делу. Отвечай на русском или кыргызском — на том языке, на котором написал клиент. Если клиент пишет на другом языке, отвечай на русском. Не используй сложных терминов.";
const DEFAULT_PRICING =
  "Оценивай стоимость по фото как мастер с 20-летним опытом, а не выбирай середину диапазона. Учитывай длину волос (чем длиннее — тем дороже), густоту и объём, степень повреждения и пористость, следы прошлых окрашиваний и осветлений, сложность работы, расход состава и время мастера. Короткие или тонкие волосы — ближе к нижней границе, длинные/густые/повреждённые — ближе к верхней. Назови узкий диапазон примерно в 200–500 сом (например «по фото где-то 3200–3500 сом» или «ийинден болсо 3200–3700 эсептесеңиз болот, эже»), а не всю вилку, и обязательно добавь, что точную цену мастер подтвердит на месте.";

export function AiAssistantTab({ salonId, salonName, onOpenWhatsAppTab }: { salonId: string; salonName: string; onOpenWhatsAppTab?: () => void }) {
  const { isSuperAdmin } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [premiumEnabled, setPremiumEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [cloudWebhookUrl, setCloudWebhookUrl] = useState<string | null>(null);
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [data, setData] = useState<Assistant>({
    salon_id: salonId,
    enabled: false,
    whatsapp_phone: "",
    greeting: DEFAULT_GREETING,
    tone_instructions: DEFAULT_TONE,
    pricing_rules: DEFAULT_PRICING,
    languages: ["ru", "ky"],
    manage_cutoff_hours: 0,
    engine: "v3",
    knowledge_base: "",
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
          manage_cutoff_hours: (row as any).manage_cutoff_hours ?? 0,
          engine: (row as any).engine === "v4" ? "v4" : "v3",
          knowledge_base: (row as any).knowledge_base ?? "",
        });
      }
      setLoading(false);
      // Load webhook config in background (super-admin only)
      if (isSuperAdmin) {
        try {
          const res = await getWaWebhookConfig({ data: { salonId } });
          if (!cancelled) {
            setWebhookUrl(res.webhook_url);
            setCloudWebhookUrl(res.cloud_webhook_url ?? null);
            setVerifyToken(res.verify_token ?? null);
          }
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
      setCloudWebhookUrl(res.cloud_webhook_url ?? null);
      setVerifyToken(res.verify_token ?? null);
      toast.success("Новый Webhook URL сгенерирован");
    } catch (e: any) {
      toast.error("Не удалось сгенерировать: " + (e?.message ?? e));
    } finally {
      setWebhookBusy(false);
    }
  }

  async function copyText(value: string | null) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
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
        manage_cutoff_hours: data.manage_cutoff_hours,
        engine: data.engine,
        knowledge_base: data.knowledge_base || null,
      } as any,
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
              <Button type="button" variant="outline" size="icon" onClick={() => copyText(webhookUrl)}>
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

      {isSuperAdmin && (
        <Card className={`p-5 space-y-3 ${!premiumEnabled ? "opacity-60 pointer-events-none select-none" : ""}`}>
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Webhook className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold">Webhook для Cloud API (Dualhook) <Badge variant="outline" className="ml-2">Только супер-админ</Badge></h3>
              <p className="text-sm text-muted-foreground mt-1">
                Для официального WhatsApp Cloud API через Dualhook. Вставьте <b>Webhook URL</b> и
                <b> Verify Token</b> в форму подключения Dualhook. Кликабельные списки услуг
                работают на этом провайдере нативно.
              </p>
            </div>
          </div>
          {cloudWebhookUrl ? (
            <div className="space-y-2">
              <div>
                <Label className="text-xs text-muted-foreground">Webhook URL</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={cloudWebhookUrl} readOnly className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={() => copyText(cloudWebhookUrl)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Verify Token</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={verifyToken ?? ""} readOnly className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={() => copyText(verifyToken)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Сначала сгенерируйте Webhook URL в блоке выше — токен общий для обоих провайдеров.
            </p>
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
          <Label>Режим работы ассистента</Label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { code: "v3", label: "Классический (пошаговое меню)" },
                { code: "v4", label: "Живой диалог (бета)" },
              ] as const
            ).map((m) => (
              <Button
                key={m.code}
                type="button"
                variant={data.engine === m.code ? "default" : "outline"}
                size="sm"
                onClick={() => setData({ ...data, engine: m.code })}
              >
                {m.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            «Живой диалог» — ассистент общается свободным текстом, как человек: понимает
            голосовые сообщения, отвечает на вопросы о салоне и записывает без нумерованных
            меню. Переключение действует сразу, откат — в один клик.
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

        {data.engine === "v4" && (
          <div className="space-y-2">
            <Label>Знания о салоне</Label>
            <Textarea
              rows={5}
              placeholder={
                "Например: Парковка бесплатная во дворе. Оплата наличными, картой и QR. По вторникам скидка 10% на маникюр. Работаем на материалах CND и OPI."
              }
              value={data.knowledge_base ?? ""}
              onChange={(e) => setData({ ...data, knowledge_base: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Только факты о вашем салоне: парковка, оплата, акции, бренды, особенности.
              Общие знания о процедурах (кератин, ботокс, окрашивание, противопоказания,
              уход) у ассистента уже встроены — их сюда добавлять не нужно.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label>Ограничение на отмену и перенос</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={168}
              className="w-24"
              value={data.manage_cutoff_hours}
              onChange={(e) =>
                setData({
                  ...data,
                  manage_cutoff_hours: Math.max(0, Math.min(168, Math.floor(Number(e.target.value) || 0))),
                })
              }
            />
            <span className="text-sm text-muted-foreground">часов до визита</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Если до визита осталось меньше указанного времени, ассистент не будет отменять
            или переносить запись сам, а попросит клиента позвонить в салон. 0 — без ограничений.
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
