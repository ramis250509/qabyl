import type React from "react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-client";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import {
  Sparkles,
  Lock,
  Copy,
  RefreshCw,
  Webhook,
  MessageCircle,
  Check,
  Leaf,
  Flame,
  ChevronDown,
  CalendarClock,
  BookOpen,
  ShieldOff,
  PlayCircle,
  Building2,
} from "lucide-react";
import { SkeletonBlock, StatusPanel } from "@/components/ui/status";
import { getWaCloudConfig } from "@/lib/wa-cloud.functions";
import {
  INDUSTRIES_META,
  INDUSTRY_PRICING,
  DEFAULT_INDUSTRY,
  normalizeIndustry,
  type IndustryKey,
} from "@/lib/industries";
import { WaSimulator } from "./WaSimulator";
import { ExcludedSuggestions } from "./ExcludedSuggestions";

type Assistant = {
  salon_id: string;
  enabled: boolean;
  whatsapp_phone: string | null;
  greeting: string | null;
  tone_instructions: string | null;
  pricing_rules: string | null;
  languages: string[];
  manage_cutoff_hours: number;
  reminder_lead_hours: number;
  /** За сколько минут до визита закрывается онлайн-запись. 0 — без ограничения. */
  min_lead_minutes: number;
  engine: "v3" | "v4";
  knowledge_base: string | null;
  ai_rules: string | null;
  /** Разрешить ассистенту списки, переносы строк и эмодзи (иначе — сплошной текст). */
  rich_formatting: boolean;
  client_addressing: string | null;
  industry: IndustryKey;
  knowledge_answers: Record<string, string>;
  /** Как ассистент продаёт: мягкий консультант или активный администратор. */
  sales_style: SalesStyleKey;
  /** Legacy-зеркало sales_style. Пишется вместе с ним, чтобы старые чтения не сломались. */
  sales_mode: boolean;
  /** Language the assistant OPENS in, before the client shows their own. */
  start_language: "ru" | "ky";
  assistant_branch_id: string | null;
  // Sales playbook. Structured rather than free text so the assistant can inject ONLY the
  // objection that actually fired into a given reply — see src/lib/sales-playbook.server.ts.
  sales_usp: string[];
  sales_objections: { trigger: string; answer: string }[];
  sales_promos: { title: string; details: string; until: string }[];
  booking_link_mode: "off" | "auto" | "eager";
  /** Услуга-«первый шаг», на которую ассистент ведёт в переписке. null = вести на то, что спросили. */
  entry_service_id: string | null;
  /** Слова владельца о том, из чего складывается крупная цена. Подставляются дословно. */
  sales_price_framing: string;
  /** Одно догоняющее сообщение тем, кто перестал отвечать. */
  followup_enabled: boolean;
  followup_delay_hours: number;
  followup_text: string;
};

// ── Режимы продаж ────────────────────────────────────────────────────────────
// Два режима вместо одного чекбокса «активные продажи»: тот чекбокс не объяснял
// владельцу ни что включается, ни что происходит, когда он выключен. Карточки
// показывают оба варианта рядом — выбор делается сравнением, а не угадыванием.
type SalesStyleKey = "light" | "active";

const SALES_STYLES: {
  key: SalesStyleKey;
  label: string;
  tagline: string;
  icon: typeof Leaf;
  bullets: string[];
}[] = [
  {
    key: "light",
    label: "Лёгкие продажи",
    tagline: "Спокойный консультант. Помогает разобраться и не давит.",
    icon: Leaf,
    bullets: [
      "Сначала понимает вопрос, потом отвечает по существу",
      "Показывает пользу услуги мягко, без уговоров",
      "Предлагает запись, когда это следует из разговора",
      "Решение оставляет за клиентом",
    ],
  },
  {
    key: "active",
    label: "Активные продажи",
    tagline: "Сильный администратор. Выясняет потребность и доводит до записи.",
    icon: Flame,
    bullets: [
      "Выясняет настоящую потребность, а не только вопрос",
      "Замечает сомнения и снимает их до отказа",
      "Связывает услугу с ситуацией конкретного клиента",
      "Доводит до времени записи и предоплаты, если она есть",
    ],
  },
];

function normalizeSalesStyle(value: unknown, legacyMode?: unknown): SalesStyleKey {
  if (value === "active" || value === "light") return value;
  return legacyMode === true ? "active" : "light";
}

// ── Tolerant readers for the JSONB sales columns ─────────────────────────────
// The columns are `jsonb` and the DB only guarantees "is an array". Everything inside is
// normalised here so the rest of the component can treat the shapes as given.
function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : ((x as any)?.text ?? ""))).filter(Boolean);
}

function toObjectionList(v: unknown): { trigger: string; answer: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => ({
      trigger: String((x as any)?.trigger ?? ""),
      answer: String((x as any)?.answer ?? ""),
    }))
    .filter((o) => o.trigger || o.answer);
}

function toPromoList(v: unknown): { title: string; details: string; until: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => ({
      title: String((x as any)?.title ?? ""),
      details: String((x as any)?.details ?? ""),
      until: String((x as any)?.until ?? ""),
    }))
    .filter((p) => p.title || p.details);
}

const DEFAULT_GREETING =
  "Здравствуйте! 👋 Я помощник салона. Подскажу по услугам, ценам и помогу записаться на удобное время.";
const DEFAULT_TONE =
  "Общайся вежливо, дружелюбно и по делу. Отвечай на русском или кыргызском — на том языке, на котором написал клиент. Если клиент пишет на другом языке, отвечай на русском. Не используй сложных терминов.";

export function AiAssistantTab({
  salonId,
  salonName,
  onOpenChannels,
}: {
  salonId: string;
  salonName: string;
  /** Увести в «Каналы»: подключение и общий выключатель ассистента живут там. */
  onOpenChannels?: () => void;
}) {
  const { isSuperAdmin } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [premiumEnabled, setPremiumEnabled] = useState(false);
  // Подключён ли канал WhatsApp. Ассистент без канала — включённый выключатель, за которым
  // ничего нет: клиент пишет салону и не получает ответа, а владелец уверен, что всё работает.
  const [waConnected, setWaConnected] = useState(true);
  const loadWaCloudConfig = useServerFn(getWaCloudConfig);
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
    reminder_lead_hours: 2,
    min_lead_minutes: 0,
    engine: "v4",
    knowledge_base: "",
    ai_rules: "",
    rich_formatting: false,
    client_addressing: "",
    industry: DEFAULT_INDUSTRY,
    knowledge_answers: {},
    sales_style: "light",
    sales_mode: false,
    start_language: "ru",
    assistant_branch_id: null,
    sales_usp: [],
    sales_objections: [],
    sales_promos: [],
    booking_link_mode: "auto",
    entry_service_id: null,
    sales_price_framing: "",
    followup_enabled: false,
    followup_delay_hours: 3,
    followup_text: "",
  });
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [services, setServices] = useState<{ id: string; name: string; price: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: salon }, { data: row }, { data: branchRows }, { data: serviceRows }] =
        await Promise.all([
          supabase.from("salons").select("ai_assistant_enabled").eq("id", salonId).maybeSingle(),
          supabase.from("salon_ai_assistant").select("*").eq("salon_id", salonId).maybeSingle(),
          supabase
            .from("branches")
            .select("id, name")
            .eq("salon_id", salonId)
            .eq("is_active", true)
            .order("sort_order"),
          supabase
            .from("services")
            .select("id, name, price")
            .eq("salon_id", salonId)
            .eq("is_active", true)
            .order("sort_order"),
        ]);
      if (cancelled) return;
      setPremiumEnabled(!!(salon as any)?.ai_assistant_enabled);
      // Через серверную функцию, а не запросом из браузера: у salon_secrets нет прав на SELECT
      // для роли authenticated, и прямой запрос молча вернул бы пустоту — то есть заблокировал
      // бы ассистента у всех салонов разом.
      try {
        const wa = await loadWaCloudConfig({ data: { salonId } });
        if (!cancelled) setWaConnected(wa.status.connected);
      } catch {
        // Не смогли выяснить — считаем подключённым. Ошибочно разрешить включение мягче, чем
        // ошибочно запретить: во втором случае владелец упирается в стену без объяснений.
      }
      setBranches((branchRows as any) ?? []);
      setServices((serviceRows as any) ?? []);
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
          reminder_lead_hours: (row as any).reminder_lead_hours ?? 2,
          min_lead_minutes: (row as any).min_lead_minutes ?? 0,
          engine: (row as any).engine === "v3" ? "v3" : "v4",
          knowledge_base: (row as any).knowledge_base ?? "",
          ai_rules: (row as any).ai_rules ?? "",
          rich_formatting: !!(row as any).rich_formatting,
          client_addressing: (row as any).client_addressing ?? "",
          industry: normalizeIndustry((row as any).industry),
          knowledge_answers: ((row as any).knowledge_answers as Record<string, string>) ?? {},
          sales_style: normalizeSalesStyle((row as any).sales_style, (row as any).sales_mode),
          sales_mode: !!(row as any).sales_mode,
          start_language: (row as any).start_language === "ky" ? "ky" : "ru",
          assistant_branch_id: (row as any).assistant_branch_id ?? null,
          // Tolerant reads: a salon whose row predates the sales migration has these as
          // undefined, and a hand-edited value could be anything. Never let the settings
          // screen crash on shape — an owner locked out of their assistant config is worse
          // than a lost list.
          sales_usp: toStringList((row as any).sales_usp),
          sales_objections: toObjectionList((row as any).sales_objections),
          sales_promos: toPromoList((row as any).sales_promos),
          booking_link_mode:
            (row as any).booking_link_mode === "off" || (row as any).booking_link_mode === "eager"
              ? (row as any).booking_link_mode
              : "auto",
          entry_service_id: (row as any).entry_service_id ?? null,
          sales_price_framing: (row as any).sales_price_framing ?? "",
          followup_enabled: !!(row as any).followup_enabled,
          followup_delay_hours: (row as any).followup_delay_hours ?? 3,
          followup_text: (row as any).followup_text ?? "",
        });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [salonId, isSuperAdmin]);

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
      toast.error(humanError(error, "Не удалось изменить статус"));
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
        // `enabled` намеренно НЕ пишется отсюда. Выключатель ассистента живёт во вкладке
        // «Каналы», и если сохранять его здесь, то форма, открытая до включения, при следующем
        // «Сохранить» тихо выключит ассистента обратно. Колонку трогает только владелец флага.
        whatsapp_phone: data.whatsapp_phone || null,
        greeting: data.greeting || null,
        tone_instructions: data.tone_instructions || null,
        pricing_rules: data.pricing_rules || null,
        languages: data.languages,
        manage_cutoff_hours: data.manage_cutoff_hours,
        reminder_lead_hours: data.reminder_lead_hours,
        min_lead_minutes: data.min_lead_minutes,
        engine: data.engine,
        knowledge_base: data.knowledge_base || null,
        ai_rules: data.ai_rules || null,
        rich_formatting: data.rich_formatting,
        client_addressing: data.client_addressing || null,
        industry: data.industry,
        knowledge_answers: data.knowledge_answers ?? {},
        sales_style: data.sales_style,
        // Legacy mirror. One source of truth in code (sales_style), but the old column stays
        // truthful for anything reading the table directly.
        sales_mode: data.sales_style === "active",
        start_language: data.start_language,
        assistant_branch_id: data.assistant_branch_id,
        // Blank rows are dropped rather than stored: an empty USP or a trigger with no answer
        // would render as a dangling bullet in the assistant's prompt.
        sales_usp: data.sales_usp.map((s) => s.trim()).filter(Boolean),
        sales_objections: data.sales_objections
          .map((o) => ({ trigger: o.trigger.trim(), answer: o.answer.trim() }))
          .filter((o) => o.trigger && o.answer),
        sales_promos: data.sales_promos
          .map((p) => ({
            title: p.title.trim(),
            details: p.details.trim() || null,
            until: p.until.trim() || null,
          }))
          .filter((p) => p.title),
        booking_link_mode: data.booking_link_mode,
        entry_service_id: data.entry_service_id,
        sales_price_framing: data.sales_price_framing.trim() || null,
        followup_enabled: data.followup_enabled,
        followup_delay_hours: data.followup_delay_hours,
        followup_text: data.followup_text.trim() || null,
      } as any,
      { onConflict: "salon_id" },
    );
    setSaving(false);
    if (error) {
      toast.error(humanError(error, "Не удалось сохранить"));
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

  if (loading) {
    return (
      <div className="max-w-3xl space-y-4">
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-64" />
        <SkeletonBlock className="h-40" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Ассистент</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Как он разговаривает с клиентами салона «{salonName}». Где он отвечает и включён ли он —
            во вкладке «Каналы».
          </p>
        </div>
        <Button onClick={save} disabled={saving} className="shrink-0">
          {saving ? "Сохраняем…" : "Сохранить"}
        </Button>
      </div>

      {/* Единственное, что этому экрану нужно знать про каналы: есть ли куда отвечать.
          Настраивать тон голоса ассистента, который никому не отвечает, — потерянный вечер,
          и узнать об этом человек должен здесь, а не через неделю тишины. */}
      {!premiumEnabled ? (
        <StatusPanel
          tone="idle"
          title="Ассистент выключен"
          body="Настройки ниже сохранятся, но пока клиентам отвечаете вы. Включается одним переключателем во вкладке «Каналы»."
          actions={[{ label: "Открыть «Каналы»", onClick: () => onOpenChannels?.() }]}
        />
      ) : !waConnected ? (
        <StatusPanel
          tone="warn"
          title="Отвечать пока некуда"
          body="Ассистент включён, но ни один канал не подключён — клиенты просто не смогут вам написать. Подключение занимает около минуты."
          actions={[{ label: "Подключить канал", onClick: () => onOpenChannels?.() }]}
        />
      ) : null}

      <Section
        id="talk"
        icon={MessageCircle}
        title="Как разговаривает"
        summary="Приветствие, тон, языки и манера общения"
        defaultOpen
      >
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
            Управляет тоном и формулировками ассистента: вежливость, обращение на «вы», запрет
            сленга, фирменные фразы (например — «не использовать сленг», «всегда предлагать комбо
            стрижка+укладка»). Шаги записи (услуга → день → время → мастер → подтверждение)
            выстроены автоматически и всегда соблюдаются.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Язык первого сообщения</Label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { code: "ru", label: "Русский" },
                { code: "ky", label: "Кыргызча" },
              ] as const
            ).map((l) => (
              <Button
                key={l.code}
                type="button"
                variant={data.start_language === l.code ? "default" : "outline"}
                size="sm"
                onClick={() => setData({ ...data, start_language: l.code })}
              >
                {l.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            На каком языке ассистент здоровается и отвечает, пока клиент не показал свой. Дальше он
            подстраивается сам: клиент написал по-русски — перейдёт на русский, и наоборот. Влияет
            только на первое сообщение.
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
          <Label>Режим работы ассистента</Label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { code: "v3", label: "Классический (пошаговое меню)" },
                { code: "v4", label: "Живой диалог" },
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
            «Живой диалог» — ассистент общается свободным текстом, как человек: понимает голосовые
            сообщения, отвечает на вопросы о салоне и записывает без нумерованных меню. Переключение
            действует сразу, откат — в один клик.
          </p>
        </div>
      </Section>

      <Section
        id="sales"
        icon={Sparkles}
        title="Активные продажи"
        summary="Насколько настойчиво ассистент доводит до записи"
      >
        <div className="space-y-3">
          <div>
            <Label>Режим продаж</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Как Ассистент ведёт разговор. На факты это не влияет: цены, свободное время, гарантии
              и результаты в обоих режимах — только реальные, из вашего прайса и базы знаний.
            </p>
          </div>
          <div role="radiogroup" aria-label="Режим продаж" className="grid gap-3 sm:grid-cols-2">
            {SALES_STYLES.map((style) => {
              const selected = data.sales_style === style.key;
              const Icon = style.icon;
              return (
                <button
                  key={style.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setData({ ...data, sales_style: style.key })}
                  className={`relative rounded-xl border p-4 text-left transition-colors ${
                    selected
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/40 hover:bg-muted/40"
                  }`}
                >
                  {selected && (
                    <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <div className="flex items-center gap-2 pr-6">
                    <Icon
                      className={`h-4 w-4 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <span className="font-medium text-sm">{style.label}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{style.tagline}</p>
                  <ul className="mt-2.5 space-y-1">
                    {style.bullets.map((b) => (
                      <li key={b} className="flex gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden
                          className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current"
                        />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {data.sales_style === "active"
              ? "В активном режиме Ассистент сам предлагает следующий шаг и работает с возражениями. Давление, споры, выдуманная срочность и навязчивые повторы запрещены — стоп-правило от навязчивости работает в обоих режимах, а медицинская безопасность всегда важнее записи."
              : "Лёгкий режим — безопасный выбор по умолчанию. Если записей мало, а вопросов много, попробуйте активный: проверить разницу можно в симуляторе ниже, не переключая клиентов."}
          </p>
        </div>

        <SalesPlaybookSection data={data} setData={setData} services={services} />
      </Section>

      <Section
        id="rules"
        icon={CalendarClock}
        title="Правила записи"
        summary="За сколько можно записаться, перенести и отменить"
      >
        <div className="space-y-2">
          <Label>Закрывать онлайн-запись перед визитом</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={1440}
              className="w-24"
              value={data.min_lead_minutes}
              onChange={(e) =>
                setData({
                  ...data,
                  min_lead_minutes: Math.max(
                    0,
                    Math.min(1440, Math.floor(Number(e.target.value) || 0)),
                  ),
                })
              }
            />
            <span className="text-sm text-muted-foreground">минут до визита</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Ближайшие слоты перестают показываться и на сайте, и у ассистента, чтобы клиент не занял
            время, к которому мастер уже не успеет подготовиться. На ручную запись из календаря не
            влияет — администратор по-прежнему может записать кого угодно и когда угодно. 0 — без
            ограничений.
          </p>
        </div>

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
                  manage_cutoff_hours: Math.max(
                    0,
                    Math.min(168, Math.floor(Number(e.target.value) || 0)),
                  ),
                })
              }
            />
            <span className="text-sm text-muted-foreground">часов до визита</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Если до визита осталось меньше указанного времени, ассистент не будет отменять или
            переносить запись сам, а попросит клиента позвонить в салон. 0 — без ограничений.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Напоминание о записи</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={72}
              className="w-24"
              value={data.reminder_lead_hours}
              onChange={(e) =>
                setData({
                  ...data,
                  reminder_lead_hours: Math.max(
                    1,
                    Math.min(72, Math.floor(Number(e.target.value) || 1)),
                  ),
                })
              }
            />
            <span className="text-sm text-muted-foreground">часов до записи</span>
          </div>
          <p className="text-xs text-muted-foreground">
            За сколько часов до визита клиенту автоматически придёт напоминание в WhatsApp.
            Изменение действует сразу и применяется ко всем новым и уже созданным записям.
          </p>
        </div>
      </Section>

      <Section
        id="knowledge"
        icon={BookOpen}
        title="Знания о салоне"
        summary="Факты, на которые ассистент опирается в ответах"
      >
        <div className="space-y-2">
          <Label>Сфера бизнеса</Label>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 max-w-sm">
            <span>{INDUSTRIES_META[data.industry].emoji}</span>
            <span className="text-sm font-medium">{INDUSTRIES_META[data.industry].label}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Сфера выбирается один раз во вкладке «Салон» и здесь менять нельзя — она определяет
            экспертизу, терминологию и сценарии Ассистента. {INDUSTRIES_META[data.industry].tagline}
            .
          </p>
          {data.engine === "v3" && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Отраслевая экспертиза и книга знаний работают в режиме «Живой диалог». В
              «Классическом» режиме ассистент ведёт запись по меню без развёрнутых консультаций.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label>{INDUSTRY_PRICING[data.industry].label}</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                setData((d) => ({ ...d, pricing_rules: INDUSTRY_PRICING[d.industry].default }))
              }
            >
              Подставить пример
            </Button>
          </div>
          <Textarea
            rows={5}
            value={data.pricing_rules ?? ""}
            onChange={(e) => setData({ ...data, pricing_rules: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Профессиональная подсказка для вашей ниши подставлена автоматически — отредактируйте под
            свой салон или оставьте как есть.
            {INDUSTRY_PRICING[data.industry].photoMode === "consultation" &&
              " Цену по фото ассистент здесь не называет — он разбирает присланное фото (кожа, зубы, симптом), чтобы понять ситуацию клиента и довести до записи; диагноз и точную стоимость оставляет специалисту."}
            {INDUSTRY_PRICING[data.industry].photoMode === "none" &&
              " В этой сфере фото для оценки не используется — цена называется из списка услуг."}
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
                      Услуги, цены и мастеров он уже знает из системы. Любой вопрос можно
                      пропустить.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                      <span className="rounded-full bg-muted px-2 py-0.5">≈ 2–3 минуты</span>
                      <span className="text-muted-foreground">
                        Заполнено {filled} из {kqs.length}
                      </span>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={fillKnowledgeExamples}>
                    Подставить пример
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
                  <Label className="text-sm">Правила для Ассистента</Label>
                  <Textarea
                    rows={4}
                    placeholder={
                      "Например:\n" +
                      "— Всегда сразу называй цену перед вопросом о дате.\n" +
                      "— Никогда не предлагай другой день, если клиент назвал конкретный.\n" +
                      "— Сначала спрашивай уровень мастера, потом день."
                    }
                    value={data.ai_rules ?? ""}
                    onChange={(e) => setData({ ...data, ai_rules: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Жёсткие инструкции, как Ассистент должен себя вести. Их приоритет выше любых
                    общих правил системы — то, что написано здесь, Ассистент обязан выполнять
                    всегда. Пишите короткими повелительными фразами, по одной на строку.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Оформление сообщений (списки, эмодзи) правилами не задаётся — для этого есть
                    переключатель ниже.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={data.rich_formatting}
                      onCheckedChange={(v) => setData({ ...data, rich_formatting: v })}
                    />
                    <Label className="text-sm">Красивое оформление сообщений</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    По умолчанию Ассистент пишет сплошным текстом, как живой человек в чате, и
                    ставит максимум один эмодзи — списки и переносы строк вырезаются. Включите, если
                    хотите структурные сообщения: короткие списки с маркерами, переносы строк и
                    эмодзи. Жирный шрифт и «звёздочки» недоступны в любом случае — WhatsApp и
                    Instagram их не отображают.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">Факты о бизнесе</Label>
                  <Textarea
                    rows={3}
                    placeholder="Например: парковка бесплатная во дворе, оплата картой и QR, работаем без выходных."
                    value={data.knowledge_base ?? ""}
                    onChange={(e) => setData({ ...data, knowledge_base: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Справочная информация о салоне, которую Ассистент использует в ответах:
                    парковка, оплата, акции, гарантия, материалы и т.п. Это факты, а не правила
                    поведения — их пишите выше.
                  </p>
                </div>
              </div>
            );
          })()}
      </Section>

      <Section
        id="limits"
        icon={ShieldOff}
        title="Кому не отвечать"
        summary="Личные чаты, поставщики, сотрудники"
      >
        <ExcludedContactsCard salonId={salonId} embedded />
      </Section>

      {/* Раздел платформы, не салона: у сети закрепление ассистента за одной точкой —
          редкая операция поддержки, а у салона с одной точкой такого вопроса нет вовсе. */}
      {isSuperAdmin && branches.length > 1 && (
        <Section
          id="branch"
          icon={Building2}
          title="Филиал ассистента"
          summary="Закрепить ассистента за одной точкой сети"
        >
          <div className="space-y-2">
            <Label>Филиал ассистента</Label>
            <Select
              value={data.assistant_branch_id ?? "__all__"}
              onValueChange={(v) =>
                setData({ ...data, assistant_branch_id: v === "__all__" ? null : v })
              }
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Все филиалы (спрашивать у клиента)</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Если закрепить конкретный филиал — ассистент будет работать ИСКЛЮЧИТЕЛЬНО с его
              данными: мастерами, расписанием, свободными окнами и записями. Он больше не будет
              спрашивать клиента, в какой филиал записать, и не упомянет мастеров других филиалов.
              Выберите «Все филиалы», чтобы вернуть прежнее поведение — ассистент сам спросит
              клиента, в какой филиал он хочет записаться.
            </p>
          </div>
        </Section>
      )}

      <Section
        id="test"
        icon={PlayCircle}
        title="Проверить на себе"
        summary="Поговорить с ассистентом, не трогая настоящих клиентов"
      >
        <WaSimulator salonId={salonId} />
      </Section>

      {/* Кнопка есть и внизу: на телефоне до верхней после длинной формы ещё надо доскроллить. */}
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Раздел настроек ассистента.
 *
 * ЗАЧЕМ ОН ПОЯВИЛСЯ. Раньше здесь был один свиток на два экрана: приветствие, режим продаж,
 * книга знаний, правила отмены и языки шли подряд без единого заголовка. Найти нужное можно было
 * только прокруткой сверху вниз, и владелец, зашедший поменять одну фразу, каждый раз проходил
 * мимо пятнадцати чужих полей.
 *
 * ПОЧЕМУ СВОРАЧИВАЕТСЯ, А НЕ РАЗБИТО НА ВКЛАДКИ. Вкладки прячут то, что человек не открыл, и
 * поэтому он не узнаёт, что оно вообще есть. Свёрнутый раздел виден целиком, с подписью, что
 * внутри, и открывается там же, не унося со страницы.
 */
function Section({
  id,
  icon: Icon,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`section-${id}`}
        className="qb-press flex w-full items-center gap-3 p-5 text-left hover:bg-muted/40"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{title}</span>
          <span className="mt-0.5 block truncate text-sm text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div id={`section-${id}`} className="qb-rise space-y-5 border-t p-5">
          {children}
        </div>
      )}
    </Card>
  );
}

// Per-salon list of phones the AI must ignore entirely (personal chats, staff, delivery guys).
// Checked in the WA webhook (src/routes/api/public/wa.$salonId.ts) at the earliest possible point
// so no Gemini / Green-API spend / conversation state is touched.
type ExcludedContact = { id: string; phone: string; label: string | null; created_at?: string };

// ─────────────────────────── Книга продаж ────────────────────────────────────
// Three lists and one policy switch. Deliberately NOT another free-text box: the assistant
// injects only the objection that actually came up in a given message, and picking one entry
// out of a wall of prose is not something it can do reliably. Everything here is optional —
// an empty playbook means the assistant handles objections honestly on facts alone and never
// claims an advantage the owner did not write down.
function SalesPlaybookSection({
  data,
  setData,
  services,
}: {
  data: Assistant;
  setData: React.Dispatch<React.SetStateAction<Assistant>>;
  services: { id: string; name: string; price: number }[];
}) {
  const patch = (p: Partial<Assistant>) => setData((d) => ({ ...d, ...p }));

  return (
    <div className="space-y-6 rounded-lg border border-dashed p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <Label className="text-sm font-semibold">Книга продаж</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Здесь вы задаёте, чем ваш бизнес силён, что отвечать на частые возражения и какие акции
          сейчас действуют. Ассистент использует ТОЛЬКО то, что здесь написано — он не придумывает
          скидки, преимущества и гарантии сам.
        </p>
      </div>

      {/* Двухшаговая продажа */}
      <div className="space-y-2">
        <Label className="text-sm">Первый шаг: на что ассистент записывает в переписке</Label>
        <Select
          value={data.entry_service_id ?? "__none__"}
          onValueChange={(v) => patch({ entry_service_id: v === "__none__" ? null : v })}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="На то, о чём спросил клиент" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">На то, о чём спросил клиент</SelectItem>
            {services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} · {s.price.toLocaleString("ru-RU")} сом
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Если у вас есть дорогая длительная программа, продавать её прямо в переписке почти
          невозможно: человек слышит большую сумму и уходит. Выберите здесь недорогую услугу —
          обычно консультацию или осмотр. Ассистент честно назовёт цену программы, если спросят, но
          записывать будет на этот первый шаг, а программу предложит уже специалист на приёме.
          Клиента, который сам уверенно просит программу, ассистент запишет на неё.
        </p>
      </div>

      {/* Объяснение цены */}
      <div className="space-y-2">
        <Label className="text-sm">Как объяснять крупную цену</Label>
        <Textarea
          rows={4}
          value={data.sales_price_framing}
          onChange={(e) => patch({ sales_price_framing: e.target.value })}
          placeholder={
            "Например: Программа 20 000 сом — это 3 месяца ведения, примерно 6 700 сом в месяц.\n" +
            "Входит: разбор анализов, план питания, коррекция назначений и связь с врачом между приёмами.\n" +
            "Отдельно за повторные приёмы внутри программы платить не нужно."
          }
        />
        <p className="text-xs text-muted-foreground">
          Большая сумма пугает, пока непонятно, что за ней стоит. Распишите своими словами, из чего
          она складывается и на какой срок. Ассистент передаст этот смысл, когда речь зайдёт о цене,
          и <b>ничего сюда не добавит от себя</b> — ни рассрочки, ни скидки, ни расчётов, которых вы
          здесь не написали.
        </p>
      </div>

      {/* Догоняющее сообщение */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            checked={data.followup_enabled}
            onCheckedChange={(v) => patch({ followup_enabled: v })}
          />
          <Label className="text-sm">Написать ещё раз, если клиент замолчал</Label>
        </div>
        {data.followup_enabled && (
          <div className="space-y-2 pl-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Написать через</span>
              <Input
                type="number"
                min={1}
                max={20}
                className="h-8 w-20"
                value={data.followup_delay_hours}
                onChange={(e) =>
                  patch({
                    followup_delay_hours: Math.min(20, Math.max(1, Number(e.target.value) || 3)),
                  })
                }
              />
              <span className="text-xs text-muted-foreground">часа(ов) молчания</span>
            </div>
            <Textarea
              rows={3}
              value={data.followup_text}
              onChange={(e) => patch({ followup_text: e.target.value })}
              placeholder="Например: Здравствуйте! Вы спрашивали про программу — остались вопросы? Готова ответить."
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Отправляется <b>один раз за диалог</b> и только тем, кто не ответил на последнее
          сообщение. Не отправляется тем, кто уже записан, кому отвечает живой администратор, и
          ночью (с 21:00 до 9:00 по вашему времени). Текст уходит <b>ровно как написан</b> —
          ассистент его не переписывает.
        </p>
        <p className="text-xs text-muted-foreground">
          Важное ограничение Instagram и WhatsApp: писать клиенту можно только{" "}
          <b>в течение 24 часов</b> после его последнего сообщения. Если человек молчит дольше,
          сообщение не отправится — это правило Meta, обойти его нельзя. Поэтому ставьте 2–5 часов,
          а не сутки.
        </p>
      </div>

      {/* USP */}
      <div className="space-y-2">
        <Label className="text-sm">Чем вы сильны</Label>
        <p className="text-xs text-muted-foreground">
          Короткие конкретные факты, а не общие слова. «Работаем 8 лет, мастера с сертификатами
          L'Oreal» — хорошо. «Индивидуальный подход и качество» — ассистенту нечего с этим делать.
        </p>
        {data.sales_usp.map((u, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={u}
              placeholder="Например: используем только профессиональную косметику, состав показываем перед процедурой"
              onChange={(e) => {
                const next = [...data.sales_usp];
                next[i] = e.target.value;
                patch({ sales_usp: next });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => patch({ sales_usp: data.sales_usp.filter((_, j) => j !== i) })}
            >
              Удалить
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => patch({ sales_usp: [...data.sales_usp, ""] })}
        >
          + Добавить преимущество
        </Button>
      </div>

      {/* Objections */}
      <div className="space-y-2">
        <Label className="text-sm">Частые возражения и ваши ответы</Label>
        <p className="text-xs text-muted-foreground">
          Слева — как это говорит клиент («дорого», «у других дешевле», «боюсь, что испортите
          волосы»). Справа — что вы хотите, чтобы он услышал. Ваш ответ важнее любых общих правил
          ассистента.
        </p>
        {data.sales_objections.map((o, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
            <Input
              value={o.trigger}
              placeholder="дорого"
              onChange={(e) => {
                const next = [...data.sales_objections];
                next[i] = { ...next[i], trigger: e.target.value };
                patch({ sales_objections: next });
              }}
            />
            <Textarea
              rows={2}
              value={o.answer}
              placeholder="В цену входит уход и укладка, повторно приходить не нужно. Есть вариант подешевле — у наших младших мастеров."
              onChange={(e) => {
                const next = [...data.sales_objections];
                next[i] = { ...next[i], answer: e.target.value };
                patch({ sales_objections: next });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({ sales_objections: data.sales_objections.filter((_, j) => j !== i) })
              }
            >
              Удалить
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            patch({ sales_objections: [...data.sales_objections, { trigger: "", answer: "" }] })
          }
        >
          + Добавить возражение
        </Button>
      </div>

      {/* Promos */}
      <div className="space-y-2">
        <Label className="text-sm">Действующие акции</Label>
        <p className="text-xs text-muted-foreground">
          Ассистент сам расскажет об акции, если она подходит к услуге, о которой спрашивает клиент.
          После даты окончания акция перестаёт упоминаться автоматически.
        </p>
        {data.sales_promos.map((p, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto]">
            <Input
              value={p.title}
              placeholder="Кератин + стрижка"
              onChange={(e) => {
                const next = [...data.sales_promos];
                next[i] = { ...next[i], title: e.target.value };
                patch({ sales_promos: next });
              }}
            />
            <Input
              value={p.details}
              placeholder="стрижка кончиков в подарок при любом кератине"
              onChange={(e) => {
                const next = [...data.sales_promos];
                next[i] = { ...next[i], details: e.target.value };
                patch({ sales_promos: next });
              }}
            />
            <Input
              type="date"
              value={p.until}
              onChange={(e) => {
                const next = [...data.sales_promos];
                next[i] = { ...next[i], until: e.target.value };
                patch({ sales_promos: next });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => patch({ sales_promos: data.sales_promos.filter((_, j) => j !== i) })}
            >
              Удалить
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            patch({
              sales_promos: [...data.sales_promos, { title: "", details: "", until: "" }],
            })
          }
        >
          + Добавить акцию
        </Button>
      </div>

      {/* Booking-link policy */}
      <div className="space-y-2">
        <Label className="text-sm">Ссылка на онлайн-запись</Label>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { code: "off", label: "Не отправлять" },
              { code: "auto", label: "По ситуации" },
              { code: "eager", label: "Предлагать активно" },
            ] as const
          ).map((m) => (
            <Button
              key={m.code}
              type="button"
              size="sm"
              variant={data.booking_link_mode === m.code ? "default" : "outline"}
              onClick={() => patch({ booking_link_mode: m.code })}
            >
              {m.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          «По ситуации» — ассистент пришлёт ссылку, только если клиент сам её попросил, долго не
          может выбрать время или расписание не отвечает. В остальных случаях он записывает прямо в
          переписке: так конверсия выше. Ссылка берётся из адреса вашей страницы записи
          автоматически.
        </p>
      </div>
    </div>
  );
}

function normalizePhone(input: string): string {
  // digits only, no leading '+'. Matches normalizeChatIdToPhone in wa-agent.server.ts.
  return input.replace(/\D+/g, "");
}

function ExcludedContactsCard({
  salonId,
  embedded = false,
}: {
  salonId: string;
  embedded?: boolean;
}) {
  const [list, setList] = useState<ExcludedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from("excluded_contacts")
      .select("id, phone, label, created_at")
      .eq("salon_id", salonId)
      .order("created_at", { ascending: false });
    if (!error) setList((data as ExcludedContact[]) ?? []);
    setLoading(false);
  }
  useEffect(() => {
    void load();
  }, [salonId]);

  async function add() {
    const p = normalizePhone(phone);
    if (p.length < 8) {
      toast.error("Введите корректный номер (минимум 8 цифр)");
      return;
    }
    setBusy(true);
    const { error } = await (supabase as any).from("excluded_contacts").insert({
      salon_id: salonId,
      phone: p,
      label: label.trim() || null,
    });
    setBusy(false);
    if (error) {
      if ((error.message || "").includes("duplicate")) toast.error("Этот номер уже в списке");
      else toast.error(humanError(error, "Не удалось добавить"));
      return;
    }
    setPhone("");
    setLabel("");
    toast.success("Готово — этому номеру ассистент больше не отвечает");
    void load();
  }

  async function remove(id: string) {
    if (!confirm("Убрать номер из списка? Ассистент снова начнёт ему отвечать.")) return;
    const { error } = await (supabase as any).from("excluded_contacts").delete().eq("id", id);
    if (error) return toast.error(humanError(error, "Не удалось удалить"));
    toast.success("Контакт убран из списка");
    void load();
  }

  // `embedded` — карточка внутри раздела настроек: свой заголовок и рамка там были бы второй
  // рамкой внутри первой. Отдельно (например, на экране супер-админа) она по-прежнему карточка.
  const Shell = embedded
    ? ({ children }: { children: React.ReactNode }) => <div className="space-y-4">{children}</div>
    : ({ children }: { children: React.ReactNode }) => (
        <Card className="space-y-4 p-4 sm:p-6">{children}</Card>
      );

  return (
    <Shell>
      {!embedded && (
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <MessageCircle className="h-4 w-4" /> Кому ассистент не отвечает
          </h2>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Этим номерам ассистент не отвечает совсем — сообщения от них он просто не видит. Удобно для
        личных чатов, сотрудников и курьеров. Вернуть обратно можно в любой момент.
      </p>

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[180px]">
          <Label className="text-xs">Номер (WhatsApp)</Label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="996700123456"
            className="mt-1"
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <Label className="text-xs">Кто это (для памяти)</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Курьер, партнёр, личный чат…"
            className="mt-1"
          />
        </div>
        <Button onClick={add} disabled={busy || !phone.trim()}>
          Добавить
        </Button>
      </div>

      <ExcludedSuggestions salonId={salonId} onAdded={() => void load()} />

      {loading ? (
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Пока нет исключённых контактов.</p>
      ) : (
        <div className="border rounded-lg divide-y">
          {list.map((c) => (
            <div key={c.id} className="flex items-center gap-3 p-3">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">+{c.phone}</div>
                {c.label ? (
                  <div className="text-xs text-muted-foreground truncate">{c.label}</div>
                ) : null}
              </div>
              <Button size="sm" variant="outline" onClick={() => remove(c.id)}>
                Убрать
              </Button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
