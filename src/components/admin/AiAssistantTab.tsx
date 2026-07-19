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
import {
  INDUSTRIES_META,
  INDUSTRY_ORDER,
  INDUSTRY_PRICING,
  DEFAULT_INDUSTRY,
  normalizeIndustry,
  type IndustryKey,
} from "@/lib/industries";

// Every industry's default "how to price" text, used to detect whether the owner has customised
// the field. If the current text equals one of these, switching industry safely replaces it with
// the new industry's text; a custom text is left untouched.
const PRICING_DEFAULTS = new Set(
  Object.values(INDUSTRY_PRICING).map((p) => p.default),
);
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
  client_addressing: string | null;
  industry: IndustryKey;
  knowledge_answers: Record<string, string>;
  sales_mode: boolean;
};

const DEFAULT_GREETING =
  "Здравствуйте! 👋 Я помощник салона. Подскажу по услугам, ценам и помогу записаться на удобное время.";
const DEFAULT_TONE =
  "Общайся вежливо, дружелюбно и по делу. Отвечай на русском или кыргызском — на том языке, на котором написал клиент. Если клиент пишет на другом языке, отвечай на русском. Не используй сложных терминов.";

export function AiAssistantTab({ salonId, salonName, onOpenWhatsAppTab }: { salonId: string; salonName: string; onOpenWhatsAppTab?: () => void }) {
  const { isSuperAdmin } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [premiumEnabled, setPremiumEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);
  // Knowledge book: show only the essential questions first; the rest expand on demand.
  const [showAllKnowledge, setShowAllKnowledge] = useState(false);
  const [data, setData] = useState<Assistant>({
    salon_id: salonId,
    enabled: false,
    whatsapp_phone: "",
    greeting: DEFAULT_GREETING,
    tone_instructions: DEFAULT_TONE,
    pricing_rules: INDUSTRY_PRICING[DEFAULT_INDUSTRY].default,
    languages: ["ru", "ky"],
    manage_cutoff_hours: 0,
    engine: "v3",
    knowledge_base: "",
    client_addressing: "",
    industry: DEFAULT_INDUSTRY,
    knowledge_answers: {},
    sales_mode: false,
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
          pricing_rules:
            row.pricing_rules ?? INDUSTRY_PRICING[normalizeIndustry((row as any).industry)].default,
          languages: row.languages?.length ? row.languages : ["ru", "ky"],
          manage_cutoff_hours: (row as any).manage_cutoff_hours ?? 0,
          engine: (row as any).engine === "v4" ? "v4" : "v3",
          knowledge_base: (row as any).knowledge_base ?? "",
          client_addressing: (row as any).client_addressing ?? "",
          industry: normalizeIndustry((row as any).industry),
          knowledge_answers: ((row as any).knowledge_answers as Record<string, string>) ?? {},
          sales_mode: !!(row as any).sales_mode,
        });
      }
      setLoading(false);
      // Load webhook config in background (super-admin only)
      if (isSuperAdmin) {
        try {
          const res = await getWaWebhookConfig({ data: { salonId } });
          if (!cancelled) {
            setWebhookUrl(res.webhook_url);
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
        client_addressing: data.client_addressing || null,
        industry: data.industry,
        knowledge_answers: data.knowledge_answers ?? {},
        sales_mode: data.sales_mode,
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

  const setAnswer = (id: string, val: string) =>
    setData((d) => ({ ...d, knowledge_answers: { ...d.knowledge_answers, [id]: val } }));

  // One-click starter: fill every still-empty knowledge field with an editable draft derived from
  // its example placeholder, so the owner edits instead of facing a wall of blanks. Never
  // overwrites what they've already typed.
  const fillKnowledgeExamples = () => {
    const qs = INDUSTRIES_META[data.industry].questions;
    setData((d) => {
      const next = { ...d.knowledge_answers };
      for (const q of qs) {
        if (!(next[q.id] ?? "").trim() && q.placeholder) {
          next[q.id] = q.placeholder.replace(/^Например:\s*/i, "").trim();
        }
      }
      return { ...d, knowledge_answers: next };
    });
    toast.success("Поля заполнены примерами — отредактируйте под свой салон");
  };

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
          <Label>Тип бизнеса (ИИ-администратор)</Label>
          <div className="flex flex-wrap gap-2">
            {INDUSTRY_ORDER.map((key) => {
              const m = INDUSTRIES_META[key];
              return (
                <Button
                  key={key}
                  type="button"
                  variant={data.industry === key ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setData((d) => ({
                      ...d,
                      industry: key,
                      // Swap in the new industry's pricing guidance, but only if the owner hasn't
                      // written their own (current text is empty or is one of the presets).
                      pricing_rules:
                        !d.pricing_rules || PRICING_DEFAULTS.has(d.pricing_rules)
                          ? INDUSTRY_PRICING[key].default
                          : d.pricing_rules,
                    }))
                  }
                >
                  <span className="mr-1">{m.emoji}</span>
                  {m.label}
                </Button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Определяет экспертизу, терминологию и сценарии консультаций ассистента.{" "}
            {INDUSTRIES_META[data.industry].tagline}.
          </p>
          {data.engine === "v3" && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Отраслевая экспертиза и книга знаний работают в режиме «Живой диалог». В
              «Классическом» режиме ассистент ведёт запись по меню без развёрнутых консультаций.
            </p>
          )}
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
          <div className="flex items-center gap-3">
            <Switch
              checked={data.sales_mode}
              onCheckedChange={(v) => setData({ ...data, sales_mode: v })}
            />
            <Label className="text-sm">Режим активных продаж</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Ассистент активнее ведёт клиента к записи: сам предлагает удобное время, мягко
            отрабатывает возражения («дорого», «подумаю») и доводит до записи — культурно, без
            навязчивости. Работает в режиме «Живой диалог». Медицинские ограничения всегда важнее
            продажи.
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
          <Label>{INDUSTRY_PRICING[data.industry].label}</Label>
          <Textarea
            rows={5}
            value={data.pricing_rules ?? ""}
            onChange={(e) => setData({ ...data, pricing_rules: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Профессиональная подсказка для вашей ниши подставлена автоматически — отредактируйте
            под свой салон или оставьте как есть.
            {!INDUSTRY_PRICING[data.industry].photoPricing &&
              " В вашей сфере оценка по фото не применяется — ассистент ведёт клиента к консультации/осмотру."}
          </p>
        </div>

        {data.engine === "v4" &&
          (() => {
            const kqs = INDUSTRIES_META[data.industry].questions;
            const essential = kqs.slice(0, 4);
            const rest = kqs.slice(4);
            const filled = kqs.filter((q) => (data.knowledge_answers[q.id] ?? "").trim()).length;
            const renderQ = (q: (typeof kqs)[number]) => (
              <div key={q.id} className="space-y-1.5">
                <Label className="text-sm">{q.label}</Label>
                {q.long ? (
                  <Textarea
                    rows={2}
                    placeholder={q.placeholder}
                    value={data.knowledge_answers[q.id] ?? ""}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                  />
                ) : (
                  <Input
                    placeholder={q.placeholder}
                    value={data.knowledge_answers[q.id] ?? ""}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                  />
                )}
                {q.help ? <p className="text-xs text-muted-foreground">{q.help}</p> : null}
              </div>
            );
            return (
              <div className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="font-medium text-sm">
                      Книга знаний · {INDUSTRIES_META[data.industry].label}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Пара минут — и ассистент консультирует как опытный администратор вашей сферы.
                      Услуги, цены и мастеров он уже знает из системы. Любой вопрос можно пропустить.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                      <span className="rounded-full bg-muted px-2 py-0.5">≈ 2–3 минуты</span>
                      <span className="text-muted-foreground">
                        Заполнено {filled} из {kqs.length}
                      </span>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={fillKnowledgeExamples}>
                    <Sparkles className="h-4 w-4 mr-1.5" /> Заполнить примером
                  </Button>
                </div>

                {essential.map(renderQ)}

                {rest.length > 0 && !showAllKnowledge && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowAllKnowledge(true)}
                  >
                    Показать ещё {rest.length} вопросов (необязательно)
                  </Button>
                )}
                {showAllKnowledge && rest.map(renderQ)}
                {showAllKnowledge && rest.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowAllKnowledge(false)}
                  >
                    Свернуть
                  </Button>
                )}

                <div className="space-y-1.5">
                  <Label className="text-sm">Дополнительно (прочие факты)</Label>
                  <Textarea
                    rows={3}
                    placeholder="Например: парковка бесплатная во дворе, оплата картой и QR, работаем без выходных."
                    value={data.knowledge_base ?? ""}
                    onChange={(e) => setData({ ...data, knowledge_base: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Любые факты о бизнесе, не вошедшие в вопросы выше.
                  </p>
                </div>
              </div>
            );
          })()}

        {data.engine === "v4" && (
          <div className="space-y-2">
            <Label>Обращения клиентов</Label>
            <Textarea
              rows={3}
              placeholder={"Айка\nАйжан\nЭже\nСестра\nДевочки\nАдмин"}
              value={data.client_addressing ?? ""}
              onChange={(e) => setData({ ...data, client_addressing: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Как постоянные клиенты обычно обращаются к администратору (по одному в строке или
              через запятую). Ассистент поймёт, что такие слова — обращение к нему, и не будет
              переспрашивать «к кому вы обращаетесь?». В своих ответах эти слова использовать не
              обязан — поле нужно только для понимания.
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
