// Первые пять минут в Qabyl: от «зарегистрировался» до «салон принимает записи».
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ЭКРАН, А НЕ ЧЕКЛИСТ В НАСТРОЙКАХ. Чеклист в настройках уже есть, и он полезен
// потом — когда владелец знает, где что лежит. Но человек, впервые открывший панель с
// одиннадцатью вкладками, не знает, с какой начать, и закрывает её. Мастер убирает выбор: один
// вопрос на экране, понятно, сколько осталось, и после последнего шага салон реально работает.
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ «ГОТОВО». Не «заполнены все поля», а «клиент может записаться»: есть
// услуга, есть мастер с графиком, есть филиал с часами. Всё остальное — сайт, книга знаний,
// предоплата — можно и нужно делать потом, и мастер об этом не спрашивает.
//
// ШАГИ НЕ БЛОКИРУЮТ. WhatsApp можно пропустить: салон без него всё равно принимает записи через
// страницу. Требовать подключения на первом входе значит терять тех, у кого сейчас нет доступа к
// Facebook-аккаунту, — а это половина.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { EmptyState, StatusDot } from "@/components/ui/status";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MessageCircle,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { INDUSTRIES_META, INDUSTRY_ORDER, type IndustryKey } from "@/lib/industries";
import { SERVICE_CATALOG_TEMPLATES } from "@/lib/service-catalog-templates";
import {
  createMySalon,
  getOnboardingProgress,
  seedServiceCatalog,
  seedTeam,
} from "@/lib/onboarding.functions";
import { WaConnectButton, type SignupOutcome } from "@/components/admin/WaConnectButton";
import { finishWaOnboarding } from "@/lib/wa-onboarding.functions";
import { changeBillingPlan, getBillingOverview } from "@/lib/billing.functions";
import { PlanCards, type PlanCardData } from "@/components/billing/PlanCards";
import { markTourPending } from "@/components/admin/ProductTour";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Настройка салона — Qabyl" }] }),
  component: OnboardingWizard,
});

/**
 * Города, а не часовые пояса.
 *
 * Владелица салона в Оше не знает, что она в Asia/Bishkek, и уж точно не знает, что такое UTC+6.
 * Она знает город. Список короткий и покрывает рынки, на которых мы работаем; всё остальное
 * меняется потом в настройках, где рядом есть подсказка.
 */
const CITIES: { label: string; tz: string }[] = [
  { label: "Бишкек", tz: "Asia/Bishkek" },
  { label: "Ош", tz: "Asia/Bishkek" },
  { label: "Алматы", tz: "Asia/Almaty" },
  { label: "Астана", tz: "Asia/Almaty" },
  { label: "Шымкент", tz: "Asia/Almaty" },
  { label: "Ташкент", tz: "Asia/Tashkent" },
  { label: "Душанбе", tz: "Asia/Dushanbe" },
  { label: "Москва", tz: "Europe/Moscow" },
  { label: "Санкт-Петербург", tz: "Europe/Moscow" },
  { label: "Екатеринбург", tz: "Asia/Yekaterinburg" },
  { label: "Новосибирск", tz: "Asia/Novosibirsk" },
];

const WEEKDAYS = [
  { dow: 1, short: "Пн" },
  { dow: 2, short: "Вт" },
  { dow: 3, short: "Ср" },
  { dow: 4, short: "Чт" },
  { dow: 5, short: "Пт" },
  { dow: 6, short: "Сб" },
  { dow: 0, short: "Вс" },
];

type StepKey = "business" | "services" | "team" | "whatsapp" | "plan" | "done";

const STEPS: { key: StepKey; title: string; hint: string }[] = [
  { key: "business", title: "О салоне", hint: "Название, сфера, город" },
  { key: "services", title: "Услуги", hint: "На что записываются клиенты" },
  { key: "team", title: "Мастера", hint: "Кто принимает и когда" },
  { key: "whatsapp", title: "WhatsApp", hint: "Ассистент отвечает клиентам" },
  { key: "plan", title: "Тариф", hint: "Первые дни бесплатно" },
  { key: "done", title: "Готово", hint: "Ссылка для клиентов" },
];

/** Полоса прогресса и список шагов. На мобильном сворачивается в одну строку. */
function Progress({ current }: { current: StepKey }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${((idx + 1) / STEPS.length) * 100}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          Шаг {idx + 1} из {STEPS.length}
        </span>
      </div>

      {/* Полный список — только там, где он помещается, не мешая. На телефоне полосы и номера
          шага достаточно: пять подписей в строку превращаются в кашу. */}
      <ol className="hidden gap-1 sm:flex">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex flex-1 items-center gap-2 text-xs">
            {i < idx ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <StatusDot tone={i === idx ? "warn" : "idle"} pulse={i === idx} />
            )}
            <span
              className={
                i === idx
                  ? "font-medium"
                  : i < idx
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60"
              }
            >
              {s.title}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Шаг 1 — о салоне
// ---------------------------------------------------------------------------

function BusinessStep({
  onDone,
}: {
  onDone: (v: { salonId: string; industry: IndustryKey }) => void;
}) {
  const create = useServerFn(createMySalon);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState<IndustryKey>("beauty");
  const [city, setCity] = useState(CITIES[0].label);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = name.trim().length >= 2 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const tz = CITIES.find((c) => c.label === city)?.tz ?? "Asia/Bishkek";
      const res = await create({
        data: {
          name: name.trim(),
          industry,
          timezone: tz,
          phone: phone.trim() || null,
          address: city,
        },
      });
      onDone({ salonId: res.salonId, industry });
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось создать салон"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qb-rise space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Расскажите о салоне</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Четыре поля — и у вас будет своя страница записи. Всё остальное можно поменять потом.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="salon-name">Название</Label>
        <Input
          id="salon-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например: Эркеайым"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <p className="text-xs text-muted-foreground">Так вас увидят клиенты.</p>
      </div>

      <div className="space-y-2">
        <Label>Чем занимаетесь</Label>
        {/* Карточки, а не выпадающий список: выбор определяет стартовый прайс, тексты сайта и
            экспертизу ассистента, и он заслуживает того, чтобы его увидели, а не пролистали. */}
        <div className="qb-stagger grid grid-cols-2 gap-2 sm:grid-cols-3">
          {INDUSTRY_ORDER.map((k) => {
            const m = INDUSTRIES_META[k];
            const active = industry === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setIndustry(k)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition-all duration-150 hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? "border-primary bg-primary/5 shadow-sm" : "border-border"
                }`}
              >
                <span className="text-xl" aria-hidden>
                  {m.emoji}
                </span>
                <span className="mt-1 block text-sm font-medium">{m.label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {m.tagline}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Город</Label>
          <Select value={city} onValueChange={setCity}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CITIES.map((c) => (
                <SelectItem key={c.label} value={c.label}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Нужен, чтобы время записей было вашим.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="salon-phone">Телефон салона</Label>
          <Input
            id="salon-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+996 700 000 000"
            inputMode="tel"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <p className="text-xs text-muted-foreground">Необязательно. Покажем клиентам.</p>
        </div>
      </div>

      <Button size="lg" className="w-full sm:w-auto" onClick={submit} disabled={!canSubmit}>
        {busy ? "Создаём…" : "Продолжить"}
        {!busy && <ArrowRight className="ml-2 h-4 w-4" />}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Шаг 2 — услуги
// ---------------------------------------------------------------------------

/**
 * Шаг 2 — прайс.
 *
 * ЧТО БЫЛО. Список галочек: владелец мог только снять лишнее. Цены и время он видел, но поменять
 * не мог, и на экране честно писалось «поправите потом». На практике «потом» не наступало: салон
 * уходил в работу со средними по рынку ценами, ассистент называл их клиентам, и первое, что
 * владелец узнавал о Qabyl, — что тот врёт про деньги.
 *
 * ЧТО СТАЛО. Тот же каталог, но каждая строка — живая: имя, цена и время правятся на месте,
 * лишнее удаляется крестиком, своё добавляется одной кнопкой. Обязательных полей нет: не тронул
 * ничего — получил ровно прежнее поведение.
 *
 * ПОЧЕМУ НЕ ФОРМА НА КАЖДУЮ УСЛУГУ. Их тридцать. Тридцать раз «Добавить → заполнить → Сохранить» —
 * это не онбординг, это рабочий день.
 */
type DraftService = {
  /** Ключ строки. Имя для этого не годится: его как раз и редактируют. */
  key: string;
  name: string;
  price: string;
  duration: string;
  category: string;
  /** Придумана владельцем, а не взята из каталога, — показываем отдельно. */
  custom?: boolean;
};

let draftSeq = 0;
const nextKey = () => `svc-${++draftSeq}`;

function ServicesStep({
  salonId,
  industry,
  onDone,
}: {
  salonId: string;
  industry: IndustryKey;
  onDone: () => void;
}) {
  const seed = useServerFn(seedServiceCatalog);
  const catalog = useMemo(() => SERVICE_CATALOG_TEMPLATES[industry] ?? [], [industry]);

  // Стартуем с полного каталога: снять лишнее быстрее, чем набрать нужное с нуля.
  const [rows, setRows] = useState<DraftService[]>(() =>
    catalog.map((s) => ({
      key: nextKey(),
      name: s.name,
      price: String(s.price),
      duration: String(s.duration_min),
      category: s.category,
    })),
  );
  const [busy, setBusy] = useState(false);

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows) if (!seen.includes(r.category)) seen.push(r.category);
    return seen;
  }, [rows]);

  function patch(key: string, p: Partial<DraftService>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }

  function remove(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  function removeCategory(cat: string) {
    setRows((prev) => prev.filter((r) => r.category !== cat));
  }

  function addCustom(category: string) {
    const key = nextKey();
    setRows((prev) => [
      ...prev,
      { key, name: "", price: "", duration: "60", category, custom: true },
    ]);
    // Новая строка бесполезна, если до неё надо ещё доскроллить и догадаться кликнуть.
    requestAnimationFrame(() => {
      document.getElementById(`svc-name-${key}`)?.focus();
    });
  }

  const ready = rows.filter((r) => r.name.trim());

  async function submit() {
    const items = ready.map((r) => ({
      name: r.name.trim(),
      // Пустая цена — это «пока не знаю», а не ноль. Ноль ассистент назовёт клиенту как «бесплатно».
      price: Math.max(0, Math.round(Number(r.price.replace(/[^\d]/g, "")) || 0)),
      duration_min: Math.min(1440, Math.max(5, Math.round(Number(r.duration) || 60))),
    }));
    setBusy(true);
    try {
      const res = await seed({ data: { salonId, industry, items } });
      if (res.created > 0) toast.success(`Готово: услуг в прайсе — ${res.created}`);
      onDone();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось сохранить прайс"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qb-rise space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Ваш прайс</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Мы подставили типичные услуги и цены для вашей сферы. Поправьте цену и время прямо здесь,
          лишнее удалите крестиком. Ничего не трогать тоже можно — всё изменится и потом.
        </p>
      </div>

      <div className="max-h-[52vh] space-y-6 overflow-y-auto rounded-xl border p-3 sm:p-4">
        {categories.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Прайс пуст. Добавьте первую услугу — или пропустите шаг и заполните позже.
          </div>
        ) : (
          categories.map((cat) => {
            const items = rows.filter((r) => r.category === cat);
            return (
              <div key={cat}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">{cat}</h2>
                  <button
                    type="button"
                    onClick={() => removeCategory(cat)}
                    className="text-xs text-muted-foreground transition-colors hover:text-danger"
                  >
                    убрать всё
                  </button>
                </div>
                <div className="space-y-1.5">
                  {items.map((r) => (
                    <div
                      key={r.key}
                      className="flex items-center gap-2 rounded-lg border bg-card px-2 py-1.5"
                    >
                      <Input
                        id={`svc-name-${r.key}`}
                        value={r.name}
                        onChange={(e) => patch(r.key, { name: e.target.value })}
                        placeholder="Название услуги"
                        aria-label="Название услуги"
                        className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1.5 shadow-none focus-visible:bg-muted/60"
                      />
                      <div className="flex shrink-0 items-center gap-1">
                        <Input
                          value={r.price}
                          onChange={(e) =>
                            patch(r.key, { price: e.target.value.replace(/[^\d]/g, "") })
                          }
                          inputMode="numeric"
                          placeholder="0"
                          aria-label={`Цена: ${r.name || "услуга"}`}
                          className="h-9 w-[4.5rem] px-1.5 text-right tabular-nums"
                        />
                        <span className="w-8 text-xs text-muted-foreground">сом</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Input
                          value={r.duration}
                          onChange={(e) =>
                            patch(r.key, { duration: e.target.value.replace(/[^\d]/g, "") })
                          }
                          inputMode="numeric"
                          placeholder="60"
                          aria-label={`Длительность: ${r.name || "услуга"}`}
                          className="h-9 w-14 px-1.5 text-right tabular-nums"
                        />
                        <span className="w-8 text-xs text-muted-foreground">мин</span>
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(r.key)}
                        aria-label={`Удалить ${r.name || "услугу"}`}
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-danger"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addCustom(cat)}
                    className="qb-press flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    Добавить услугу в «{cat}»
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={submit} disabled={busy || ready.length === 0}>
          {busy ? "Сохраняем…" : `Сохранить ${ready.length}`}
          {!busy && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy} className="text-muted-foreground">
          Заполню позже
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Шаг 3 — мастера
// ---------------------------------------------------------------------------

function TeamStep({ salonId, onDone }: { salonId: string; onDone: () => void }) {
  const seed = useServerFn(seedTeam);
  const [rows, setRows] = useState<{ name: string; specialization: string }[]>([
    { name: "", specialization: "" },
  ]);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("20:00");
  const [busy, setBusy] = useState(false);

  const filled = rows.filter((r) => r.name.trim());
  const timeValid = start < end;
  const canSubmit = filled.length > 0 && days.length > 0 && timeValid && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await seed({
        data: {
          salonId,
          masters: filled.map((r) => ({
            name: r.name.trim(),
            specialization: r.specialization.trim() || undefined,
          })),
          weekdays: days,
          start,
          end,
        },
      });
      onDone();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось добавить мастеров"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qb-rise space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Кто принимает клиентов
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Если работаете одна — впишите себя. График общий для всех, у каждого его можно поменять
          отдельно потом.
        </p>
      </div>

      <div className="qb-stagger space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={r.name}
              onChange={(e) =>
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
              placeholder="Имя"
              autoFocus={i === 0}
              className="flex-1"
            />
            <Input
              value={r.specialization}
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((x, j) => (j === i ? { ...x, specialization: e.target.value } : x)),
                )
              }
              placeholder="Специализация (необязательно)"
              className="hidden flex-1 sm:block"
            />
            {rows.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                aria-label="Убрать"
                className="shrink-0 text-muted-foreground hover:text-danger"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRows((rs) => [...rs, { name: "", specialization: "" }])}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Ещё мастер
        </Button>
      </div>

      <div className="space-y-3 rounded-xl border p-4">
        <Label className="text-sm">Рабочие дни и время</Label>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((d) => {
            const on = days.includes(d.dow);
            return (
              <button
                key={d.dow}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setDays((ds) =>
                    ds.includes(d.dow) ? ds.filter((x) => x !== d.dow) : [...ds, d.dow],
                  )
                }
                className={`h-9 w-11 rounded-lg border text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {d.short}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-32"
          />
          <span className="text-muted-foreground">—</span>
          <Input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-32"
          />
        </div>
        {/* Не косметика. Интервал, который кончается раньше, чем начинается, проходит в базу и
            делает салон незаписываемым молча: расписание пересекает часы филиала с графиком
            мастера и отбрасывает каждое окно. Так в августе 2026 встал живой салон. */}
        {!timeValid && (
          <p className="text-xs text-danger">
            Время окончания должно быть позже начала — иначе свободных окон не будет вообще.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={submit} disabled={!canSubmit}>
          {busy ? "Сохраняем…" : "Продолжить"}
          {!busy && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy} className="text-muted-foreground">
          Добавлю позже
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Шаг 4 — WhatsApp
// ---------------------------------------------------------------------------

function WhatsAppStep({
  salonId,
  connected,
  onDone,
}: {
  salonId: string;
  connected: boolean;
  onDone: () => void;
}) {
  const onboard = useServerFn(finishWaOnboarding);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(connected);

  async function onSignup(outcome: SignupOutcome) {
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "error") {
      toast.error(outcome.message, { duration: 10000 });
      return;
    }
    setBusy(true);
    try {
      const res = await onboard({
        data: {
          salonId,
          code: outcome.code,
          wabaId: outcome.wabaId,
          phoneNumberId: outcome.phoneNumberId,
          coexistence: outcome.coexistence,
        },
      });
      setOk(true);
      toast.success(res.status.level === "ok" ? "WhatsApp подключён" : res.status.title);
      // Уведомления клиентам включаем сами: владелец только что подключил канал именно ради них,
      // и отдельный тумблер на следующем экране — это шаг, который забывают.
      await supabase.from("salons").update({ whatsapp_enabled: true }).eq("id", salonId);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось завершить подключение", { duration: 10000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qb-rise space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Пусть клиентам отвечает ассистент
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Подключите WhatsApp — и Qabyl будет отвечать на вопросы, подбирать время и записывать
          клиентов круглосуточно. Вы войдёте в свой Facebook и подтвердите номер, остальное
          настроится само.
        </p>
      </div>

      <div className="qb-stagger space-y-2.5 rounded-xl border bg-muted/30 p-5">
        {[
          "Ваш WhatsApp Business на телефоне продолжит работать — переписку вы видите как раньше",
          "Клиент пишет ночью — ассистент отвечает и записывает, а вы видите запись утром",
          "Подтверждения и напоминания за два часа уходят сами",
        ].map((t) => (
          <div key={t} className="flex items-start gap-2.5 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>{t}</span>
          </div>
        ))}
      </div>

      {ok ? (
        <div className="qb-pop flex items-center gap-3 rounded-xl border border-success-border bg-success-surface p-4">
          <Check className="h-5 w-5 text-success" />
          <span className="text-sm font-medium">WhatsApp подключён</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {!ok && <WaConnectButton connected={false} onConnected={onSignup} size="lg" />}
        <Button
          size={ok ? "lg" : "default"}
          variant={ok ? "default" : "ghost"}
          onClick={onDone}
          disabled={busy}
          className={ok ? undefined : "text-muted-foreground"}
        >
          {ok ? "Продолжить" : "Пропустить пока"}
          {ok && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </div>

      {!ok && (
        <p className="text-xs text-muted-foreground">
          Можно вернуться к этому в любой момент — салон уже принимает записи через страницу.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Шаг 5 — тариф
// ---------------------------------------------------------------------------
//
// После WhatsApp, а не в начале: к этому моменту владелец уже видел, что Qabyl делает, и выбирает
// осознанно. Пробный период идёт с создания салона на Start; выбор другого тарифа пересчитывает
// его по правилам выбранного (Business и Pro — 14 дней). Карта не нужна. Не выбрал — остаётся Start,
// сменить можно в кабинете в любой момент.

function PlanStep({ salonId, onDone }: { salonId: string; onDone: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getBillingOverview>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  // Что человек отметил на экране. Не то же самое, что сохранённый тариф: выбор и подтверждение
  // выбора — два разных действия, и раньше они были склеены (см. `confirm` ниже).
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBillingOverview({ data: { salonId } })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  /**
   * Нажатие по карточке только отмечает тариф.
   *
   * ЗАЧЕМ РАЗДЕЛЕНО. Раньше клик по карточке сразу сохранял тариф и перебрасывал на следующий
   * шаг. Человек, который просто читал, чем Business отличается от Start, нажимал — и оказывался
   * дальше, уже с выбранным тарифом, не успев сравнить. Отменить это на экране было нечем.
   * Теперь выбор виден на экране, сравнивать можно сколько угодно, а дальше ведёт отдельная
   * кнопка «Продолжить».
   */
  function pick(p: PlanCardData) {
    setPicked(p.code);
  }

  async function confirm() {
    const p = data?.plans.find((x) => x.code === picked);
    if (!p) return;
    setBusyCode(p.code);
    try {
      const r = await changeBillingPlan({ data: { salonId, planCode: p.code } });
      if (r.redirectUrl) {
        window.location.assign(r.redirectUrl);
        return;
      }
      toast.success(`Тариф ${p.name} выбран`);
      onDone();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось выбрать тариф"));
    } finally {
      setBusyCode(null);
    }
  }

  // Тариф не читается — не держим человека на пороге: выбрать можно и в кабинете.
  if (failed || (data && !data.state?.has_subscription)) {
    return (
      <div className="qb-rise space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Тариф выберете позже</h1>
        <p className="text-sm text-muted-foreground">
          Пробный период уже идёт. Сравнить тарифы и выбрать можно в кабинете, в разделе «Тариф и
          оплата».
        </p>
        <Button size="lg" onClick={onDone}>
          Продолжить
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex justify-center py-16" role="status" aria-label="Загружаем тарифы">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const current = data.plans.find((p) => p.code === data.state?.plan_code) ?? null;
  // Что-то должно быть отмечено с самого начала: пустой экран выбора без подсказки заставляет
  // гадать, а рекомендованный тариф у нас и так помечен «Самый популярный».
  const selected =
    picked ?? current?.code ?? data.plans.find((p) => p.is_featured)?.code ?? data.plans[0]?.code;
  const selectedPlan = data.plans.find((p) => p.code === selected) ?? null;

  return (
    <div className="qb-rise space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Выберите тариф</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Первые дни — бесплатно, карта не нужна. Тариф можно сменить в любой момент в кабинете.
        </p>
      </div>

      <PlanCards
        plans={data.plans}
        selectedCode={selected ?? null}
        currentCode={current?.code ?? null}
        busyCode={busyCode}
        disabled={busyCode !== null}
        onChoose={pick}
        mode="onboarding"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={confirm} disabled={busyCode !== null || !selectedPlan}>
          {busyCode ? "Сохраняем…" : `Продолжить с ${selectedPlan?.name ?? ""}`}
          {!busyCode && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={onDone}
          disabled={busyCode !== null}
        >
          Решу позже
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Шаг 6 — готово
// ---------------------------------------------------------------------------

function DoneStep({ slug, salonName }: { slug: string; salonName: string }) {
  const url = typeof window !== "undefined" ? `${window.location.origin}/book/${slug}` : "";
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Не удалось скопировать — выделите ссылку и скопируйте вручную");
    }
  }

  return (
    <div className="qb-rise space-y-6 text-center">
      <div className="qb-pop mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-surface">
        <Sparkles className="h-8 w-8 text-success" />
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          «{salonName}» принимает записи
        </h1>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          Отправьте эту ссылку клиентам или поставьте её в Instagram — записи появятся у вас в
          календаре.
        </p>
      </div>

      <div className="mx-auto flex max-w-md gap-2">
        <Input
          readOnly
          value={url}
          className="text-center text-sm"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button variant="outline" size="icon" onClick={copy} aria-label="Скопировать ссылку">
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button variant="outline" size="icon" asChild aria-label="Открыть">
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </div>

      {/* Жёсткий переход, а не router.navigate. Роль salon_admin появилась в базе минуту назад,
          но в текущей сессии её ещё нет: useAuth грузит роли один раз на идентификатор
          пользователя и по своим ссылкам-охранникам не станет перезапрашивать. Мягкий переход
          привёл бы в /admin, где охранник не увидел бы роли и отправил владельца обратно сюда —
          по кругу. Перезагрузка страницы читает роли заново и стоит одну секунду ровно один раз
          за всю жизнь аккаунта. */}
      <Button
        size="lg"
        onClick={() => {
          // Заказываем короткую экскурсию по кабинету. Показать её здесь нельзя: кабинета ещё
          // нет на экране, подсвечивать нечего. Кабинет сам заберёт эту отметку при загрузке.
          markTourPending();
          window.location.assign("/admin");
        }}
      >
        Перейти в кабинет
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Мастер целиком
// ---------------------------------------------------------------------------

function OnboardingWizard() {
  const navigate = useNavigate();
  const { user, loading, rolesLoading, salonId, isSuperAdmin } = useAuth();
  const progressFn = useServerFn(getOnboardingProgress);

  const [step, setStep] = useState<StepKey | null>(null);
  const [industry, setIndustry] = useState<IndustryKey>("beauty");
  const [mySalonId, setMySalonId] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [salonName, setSalonName] = useState("");
  const [waConnected, setWaConnected] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth", replace: true });
  }, [loading, user, navigate]);

  // Куда попал человек, у которого уже что-то настроено. Шаг выбирается по СОСТОЯНИЮ БАЗЫ, а не
  // по тому, где он был в прошлый раз: перезагрузка страницы, второй браузер и возврат через
  // неделю должны приводить в одно и то же место.
  useEffect(() => {
    if (loading || rolesLoading || !user) return;
    // Владельцу платформы мастер не нужен: у него свой путь через /admin/salons, и RPC ему
    // откажет («у этого аккаунта уже есть салон»).
    if (isSuperAdmin) {
      navigate({ to: "/admin", replace: true });
      return;
    }
    if (!salonId) {
      setStep("business");
      return;
    }
    setMySalonId(salonId);
    (async () => {
      try {
        const p = await progressFn({ data: { salonId } });
        setSlug(p.slug);
        setSalonName(p.salonName);
        setWaConnected(p.whatsapp.connected);
        const { data: a } = await supabase
          .from("salon_ai_assistant")
          .select("industry")
          .eq("salon_id", salonId)
          .maybeSingle();
        if (a?.industry) setIndustry(a.industry as IndustryKey);

        if (p.servicesCount === 0) setStep("services");
        else if (p.bookableMastersCount === 0) setStep("team");
        else if (!p.whatsapp.connected) setStep("whatsapp");
        else setStep("done");
      } catch {
        setStep("services");
      }
    })();
  }, [loading, rolesLoading, user, salonId, isSuperAdmin, navigate, progressFn]);

  if (loading || rolesLoading || !step) return <FullScreenLoader />;

  const idx = STEPS.findIndex((s) => s.key === step);
  const canGoBack = idx > 0 && step !== "done";

  return (
    <div className="min-h-[100dvh] bg-muted/20">
      <header className="flex items-center justify-between border-b bg-card px-4 py-3 sm:px-6">
        <span className="font-bold">Qabyl</span>
        {/* Выход, а не «пропустить всё»: человек мог зайти не тем аккаунтом, и это единственный
            способ выбраться с экрана, который иначе выглядит безвыходным. */}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={async () => {
            const { signOutFromApp } = await import("@/lib/auth-client");
            await signOutFromApp();
            navigate({ to: "/auth", replace: true });
          }}
        >
          <X className="mr-1.5 h-3.5 w-3.5" />
          Выйти
        </Button>
      </header>

      <main
        className={`mx-auto w-full px-4 py-8 sm:px-6 sm:py-12 ${step === "plan" ? "max-w-5xl" : "max-w-2xl"}`}
      >
        <Progress current={step} />

        <Card className="p-5 sm:p-8">
          {step === "business" && (
            <BusinessStep
              onDone={({ salonId: id, industry: ind }) => {
                setMySalonId(id);
                setIndustry(ind);
                setStep("services");
                // Роли перечитываются на следующем заходе в кабинет; здесь достаточно локального
                // состояния — иначе пришлось бы перезагружать страницу посреди мастера.
              }}
            />
          )}

          {step === "services" && mySalonId && (
            <ServicesStep salonId={mySalonId} industry={industry} onDone={() => setStep("team")} />
          )}

          {step === "team" && mySalonId && (
            <TeamStep salonId={mySalonId} onDone={() => setStep("whatsapp")} />
          )}

          {step === "whatsapp" && mySalonId && (
            <WhatsAppStep
              salonId={mySalonId}
              connected={waConnected}
              onDone={async () => {
                // Имя и slug могли появиться уже после первого шага — перечитываем перед финалом,
                // иначе последний экран покажет пустую ссылку.
                if (mySalonId && !slug) {
                  try {
                    const p = await progressFn({ data: { salonId: mySalonId } });
                    setSlug(p.slug);
                    setSalonName(p.salonName);
                  } catch {
                    /* финальный экран переживёт отсутствие имени */
                  }
                }
                setStep("plan");
              }}
            />
          )}

          {step === "plan" && mySalonId && (
            <PlanStep salonId={mySalonId} onDone={() => setStep("done")} />
          )}

          {step === "done" &&
            (slug ? (
              <DoneStep slug={slug} salonName={salonName} />
            ) : (
              <EmptyState
                icon={MessageCircle}
                title="Салон настроен"
                body="Ссылку для клиентов можно взять в кабинете, в настройках салона."
                action={{ label: "В кабинет", onClick: () => window.location.assign("/admin") }}
              />
            ))}
        </Card>

        {canGoBack && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-4 text-muted-foreground"
            onClick={() => setStep(STEPS[idx - 1].key)}
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Назад
          </Button>
        )}
      </main>
    </div>
  );
}
