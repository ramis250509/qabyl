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

type StepKey = "business" | "services" | "team" | "whatsapp" | "done";

const STEPS: { key: StepKey; title: string; hint: string }[] = [
  { key: "business", title: "О салоне", hint: "Название, сфера, город" },
  { key: "services", title: "Услуги", hint: "На что записываются клиенты" },
  { key: "team", title: "Мастера", hint: "Кто принимает и когда" },
  { key: "whatsapp", title: "WhatsApp", hint: "Ассистент отвечает клиентам" },
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
      toast.error(e?.message ?? "Не удалось создать салон");
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
  const categories = useMemo(() => Array.from(new Set(catalog.map((s) => s.category))), [catalog]);
  // Всё отмечено по умолчанию. Снять лишнее быстрее, чем набрать нужное с нуля, а главное —
  // владелец, который просто нажмёт «Дальше», получит рабочий прайс, а не пустой.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(catalog.map((s) => s.name)));
  const [busy, setBusy] = useState(false);

  function toggle(name: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  }

  function toggleCategory(cat: string) {
    const names = catalog.filter((s) => s.category === cat).map((s) => s.name);
    const allOn = names.every((n) => picked.has(n));
    setPicked((p) => {
      const n = new Set(p);
      for (const name of names) {
        if (allOn) n.delete(name);
        else n.add(name);
      }
      return n;
    });
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await seed({
        data: { salonId, industry, names: Array.from(picked) },
      });
      if (res.created > 0) toast.success(`Добавлено услуг: ${res.created}`);
      onDone();
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось добавить услуги");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qb-rise space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Что вы делаете</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Мы подготовили прайс для вашей сферы. Снимите лишнее — цены и длительность поправите
          потом, они сейчас средние по рынку.
        </p>
      </div>

      <div className="max-h-[46vh] space-y-5 overflow-y-auto rounded-xl border p-4">
        {categories.map((cat) => {
          const items = catalog.filter((s) => s.category === cat);
          const allOn = items.every((s) => picked.has(s.name));
          return (
            <div key={cat}>
              <button
                type="button"
                onClick={() => toggleCategory(cat)}
                className="mb-2 text-sm font-semibold hover:underline"
              >
                {cat}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {allOn ? "снять все" : "выбрать все"}
                </span>
              </button>
              <div className="space-y-1.5">
                {items.map((s) => (
                  <label
                    key={s.name}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
                  >
                    <Checkbox checked={picked.has(s.name)} onCheckedChange={() => toggle(s.name)} />
                    <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {s.price_type === "range" && s.price_max
                        ? `${s.price}–${s.price_max}`
                        : s.price}{" "}
                      · {s.duration_min} мин
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={submit} disabled={busy || picked.size === 0}>
          {busy ? "Добавляем…" : `Добавить ${picked.size}`}
          {!busy && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy} className="text-muted-foreground">
          Заполню сам позже
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
      toast.error(e?.message ?? "Не удалось добавить мастеров");
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
// Шаг 5 — готово
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
      <Button size="lg" onClick={() => window.location.assign("/admin")}>
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

      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
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
                setStep("done");
              }}
            />
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
