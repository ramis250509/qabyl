// Мира (Marketer) — ТОЛЬКО СЕРВЕР. Раз в неделю приносит контент-план и идею промо.
//
// ЧТО ОНА ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ. Мира ничего не публикует: у Qabyl нет прав на постинг в наши же
// соцсети, да и доверять ленту агенту незачем. Она собирает ФАКТЫ о платформе из базы, просит у
// модели тексты и приносит их владельцу кнопкой «Одобрить». Одобренное становится задачами на
// доске, а промо — событием, о котором узнаёт Айдар.
//
// ФАКТЫ СЧИТАЮТСЯ ДЕТЕРМИНИРОВАННО. Модель получает готовые числа и не имеет доступа к базе:
// придумать «у нас 200 салонов» она не может, потому что числа приходят в промпт из SQL.
//
// БЮДЖЕТ. Не больше MAX_LLM_PER_DAY обращений к модели в сутки на всю платформу: агент, которого
// можно позвать кнопкой, обязан иметь потолок расходов.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { audit, kvGet, kvSet } from "@/lib/ops-agents.server";
import {
  contentPlanAction,
  fallbackContentPlan,
  formatContentPlan,
  parseContentPlan,
  type ContentPlan,
  type PlatformFacts,
} from "@/lib/ops-content";

const db = () => supabaseAdmin as any;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_LLM_PER_DAY = 5;

// ---------------------------------------------------------------------------
// Факты о платформе
// ---------------------------------------------------------------------------

export async function platformFacts(): Promise<PlatformFacts> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const since7 = Date.now() - 7 * 86_400_000;

  const [{ data: salons }, { data: assistants }, { data: appts }] = await Promise.all([
    db().from("salons").select("id, created_at").eq("is_active", true),
    db().from("salon_ai_assistant").select("industry"),
    db()
      .from("appointments")
      .select("created_at, status, source, services(name)")
      .gte("created_at", since30)
      .limit(5000),
  ]);

  const rows = (appts ?? []) as any[];
  const isActive = (a: any) => a.status === "confirmed" || a.status === "completed";
  const last7 = rows.filter((a) => new Date(a.created_at).getTime() >= since7);
  const noShow = rows.filter((a) => a.status === "no_show").length;
  const activeCount = rows.filter(isActive).length;

  const serviceCount = new Map<string, number>();
  for (const a of rows) {
    const name = a.services?.name;
    if (!name) continue;
    serviceCount.set(name, (serviceCount.get(name) ?? 0) + 1);
  }

  return {
    salons: (salons ?? []).length,
    newSalons30d: (salons ?? []).filter((s: any) => s.created_at >= since30).length,
    industries: [
      ...new Set(
        ((assistants ?? []) as any[]).map((a) => String(a.industry ?? "").trim()).filter(Boolean),
      ),
    ].slice(0, 6),
    bookings7d: last7.filter(isActive).length,
    aiBookings7d: last7.filter((a) => isActive(a) && a.source === "ai_assistant").length,
    topServices: [...serviceCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name),
    noShowRate30d:
      activeCount + noShow > 0 ? Math.round((noShow / (activeCount + noShow)) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Модель
// ---------------------------------------------------------------------------

async function llmBudgetLeft(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const kv = (await kvGet("marketer_llm")) as { date?: string; count?: number } | null;
  const count = kv?.date === today ? Number(kv.count ?? 0) : 0;
  if (count >= MAX_LLM_PER_DAY) return false;
  await kvSet("marketer_llm", { date: today, count: count + 1 });
  return true;
}

function prompt(f: PlatformFacts): string {
  return `Ты — маркетолог SaaS-платформы Qabyl (Кыргызстан). Qabyl даёт салонам красоты онлайн-запись,
сайт салона и ИИ-администратора, который отвечает клиентам в WhatsApp и Instagram: подбирает время,
записывает, напоминает о визите. Покупатель — владелец салона, не его клиент.

Факты о платформе прямо сейчас (использовать только их, ничего не выдумывать):
- активных салонов: ${f.salons}, из них пришло за 30 дней: ${f.newSalons30d}
- ниши: ${f.industries.join(", ") || "салоны красоты"}
- записей за 7 дней: ${f.bookings7d}, из них оформил ассистент: ${f.aiBookings7d}
- доля неявок за 30 дней: ${f.noShowRate30d}%
- частые услуги: ${f.topServices.join(", ") || "маникюр, ресницы, стрижки"}

Сделай план контента на неделю для наших соцсетей: три материала и, если уместно, одну идею промо.
Форматы: один «Пост» (статичная картинка) и два «Рилс» или «Сторис» — их мы делаем motion-графикой,
без съёмки, поэтому идея должна держаться на тексте, цифрах и простой анимации, а не на видеоряде.
Говори с владельцем салона о его деньгах и времени, без слов «инновации», «синергия», «оптимизация».
Никакой технической части: ни Meta, ни API, ни нейросетей — только польза.

Верни СТРОГО JSON без markdown:
{"posts":[{"format":"Пост|Сторис|Рилс","hook":"цепляющая первая строка","caption":"2-4 живых предложения","cta":"призыв"}],
 "promo":{"title":"","audience":"","offer":"","why":""}}
Если промо сейчас не нужно — верни "promo": null.`;
}

async function askModel(f: PlatformFacts): Promise<ContentPlan | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!(await llmBudgetLeft())) {
    await audit("marketer", "marketer.budget_exhausted", { limit: MAX_LLM_PER_DAY });
    return null;
  }
  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt(f) }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 1600 },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.error(`[ops-marketer] gemini HTTP ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
    return parseContentPlan(text);
  } catch (e: any) {
    console.error(`[ops-marketer] gemini: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// План недели
// ---------------------------------------------------------------------------

/**
 * Собрать план. Модель не ответила или ответила мусором — берём план из фактов: Мира приходит
 * всегда, просто иногда скучнее.
 */
export async function buildWeeklyPlan(): Promise<{
  text: string;
  action: Record<string, unknown>;
  fromModel: boolean;
}> {
  const facts = await platformFacts();
  const fromModel = await askModel(facts);
  const plan = fromModel ?? fallbackContentPlan(facts);
  await audit("marketer", "marketer.plan_built", {
    from_model: Boolean(fromModel),
    posts: plan.posts.length,
    promo: Boolean(plan.promo),
  });
  return {
    text: formatContentPlan(plan, facts),
    action: contentPlanAction(plan),
    fromModel: Boolean(fromModel),
  };
}
