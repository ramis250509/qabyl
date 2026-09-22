// Айдар (Sales) — ТОЛЬКО СЕРВЕР. Лиды, воронка, черновики сообщений, касания.
//
// ЧТО ОН ДЕЛАЕТ СЕЙЧАС, БЕЗ СВОЕГО НОМЕРА. Ведёт лидов, спрашивает у модели текст под конкретного
// человека, ставит следующее касание и не даёт лиду молча умереть. Отправка идёт через гейт
// одобрения; пока номер Qabyl не подключён, одобренное сообщение приходит владельцу текстом —
// скопировать и отправить самому. Это не заглушка: ценность Айдара в том, ЧТО написать и КОГДА
// вернуться, а не в кнопке «отправить».
//
// ПРАВИЛО META, из-за которого всё так. Первое сообщение незнакомому номеру в WhatsApp вне
// 24-часового окна разрешено только одобренным шаблоном. Значит холодная рассылка свободным
// текстом невозможна в принципе — ни с номером, ни без. Поэтому sendLeadMessage честно называет
// причину отказа, а не делает вид, что доставит.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { audit, kvGet, kvSet } from "@/lib/ops-agents.server";
import { emitEvent } from "@/lib/ops-bus.server";
import { draftOutreachFallback, isTouchDue, type Lead, type LeadStage } from "@/lib/ops-sales";

const db = () => supabaseAdmin as any;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_LLM_PER_DAY = 10;

// ---------------------------------------------------------------------------
// Лиды
// ---------------------------------------------------------------------------

export async function createLead(p: {
  phone: string;
  name?: string | null;
  company?: string | null;
  industry?: string | null;
}): Promise<{ lead: Lead | null; existed: boolean }> {
  const { data: found } = await db()
    .from("ops_leads")
    .select("*")
    .eq("phone", p.phone)
    .limit(1)
    .maybeSingle();
  if (found) return { lead: found as Lead, existed: true };

  const { data, error } = await db()
    .from("ops_leads")
    .insert({
      phone: p.phone,
      name: p.name ?? null,
      company: p.company ?? null,
      industry: p.industry ?? null,
    })
    .select("*")
    .single();
  if (error) {
    console.error(`[ops-sales] createLead: ${error.message}`);
    return { lead: null, existed: false };
  }
  await audit("sales", "lead.created", { phone: p.phone }, { type: "lead", id: String(data.id) });
  return { lead: data as Lead, existed: false };
}

export async function getLead(id: number): Promise<Lead | null> {
  const { data } = await db().from("ops_leads").select("*").eq("id", id).maybeSingle();
  return (data ?? null) as Lead | null;
}

export async function listLeads(opts: { stage?: LeadStage; limit?: number } = {}): Promise<Lead[]> {
  let q = db()
    .from("ops_leads")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 15);
  if (opts.stage) q = q.eq("stage", opts.stage);
  const { data } = await q;
  return (data ?? []) as Lead[];
}

export async function updateLead(id: number, patch: Record<string, unknown>): Promise<Lead | null> {
  const { data, error } = await db()
    .from("ops_leads")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error(`[ops-sales] updateLead ${id}: ${error.message}`);
    return null;
  }
  return (data ?? null) as Lead | null;
}

/**
 * Смена стадии. Переход в «выясняем» — это и есть квалификация: событие поднимает Кэпу задачу на
 * созвон, чтобы живой разговор не откладывался до следующей недели.
 */
export async function setLeadStage(id: number, stage: LeadStage): Promise<Lead | null> {
  const lead = await updateLead(id, { stage });
  if (!lead) return null;
  await audit("sales", "lead.stage", { stage }, { type: "lead", id: String(id) });
  if (stage === "qualifying") {
    await emitEvent("lead.qualified", "sales", {
      lead_id: id,
      name: lead.name,
      phone: lead.phone,
    });
  }
  return lead;
}

export async function funnelCounts(): Promise<Record<string, number>> {
  const { data } = await db().from("ops_leads").select("stage").limit(1000);
  const counts: Record<string, number> = {};
  for (const r of (data ?? []) as any[]) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  return counts;
}

export async function dueLeads(now = new Date()): Promise<Lead[]> {
  const { data } = await db()
    .from("ops_leads")
    .select("*")
    .in("stage", ["new", "qualifying", "meeting_set"])
    .order("updated_at", { ascending: true })
    .limit(100);
  return ((data ?? []) as Lead[]).filter((l) => isTouchDue(l, now));
}

/** Переписка с лидом — чтобы черновики учитывали, что уже сказано. */
export async function logLeadMessage(
  leadId: number,
  role: "owner" | "agent" | "system",
  text: string,
): Promise<void> {
  await db()
    .from("ops_messages")
    .insert({ thread: `lead:${leadId}`, role, text: text.slice(0, 3000) });
}

async function leadHistory(leadId: number): Promise<string[]> {
  const { data } = await db()
    .from("ops_messages")
    .select("role, text")
    .eq("thread", `lead:${leadId}`)
    .order("at", { ascending: false })
    .limit(6);
  return ((data ?? []) as any[]).reverse().map((m) => `${m.role}: ${m.text ?? ""}`);
}

// ---------------------------------------------------------------------------
// Черновик сообщения
// ---------------------------------------------------------------------------

async function llmBudgetLeft(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const kv = (await kvGet("sales_llm")) as { date?: string; count?: number } | null;
  const count = kv?.date === today ? Number(kv.count ?? 0) : 0;
  if (count >= MAX_LLM_PER_DAY) return false;
  await kvSet("sales_llm", { date: today, count: count + 1 });
  return true;
}

/**
 * Черновик под конкретного лида. Модель получает только факты платформы и то, что уже сказано —
 * придумать «у нас 500 салонов» она не может. Без ключа или при сбое отдаём шаблон: продажнику
 * нельзя молчать из-за чужого сбоя.
 */
export async function draftOutreach(
  leadId: number,
): Promise<{ text: string; fromModel: boolean } | null> {
  const lead = await getLead(leadId);
  if (!lead) return null;

  const { platformFacts } = await import("@/lib/ops-marketer.server");
  const facts = await platformFacts();
  const fallback = draftOutreachFallback(lead, { aiBookings7d: facts.aiBookings7d });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !(await llmBudgetLeft())) return { text: fallback, fromModel: false };

  const history = await leadHistory(leadId);
  const prompt = `Ты — продажник SaaS-платформы Qabyl (Кыргызстан). Qabyl даёт салонам красоты онлайн-запись,
сайт салона и ИИ-администратора, который отвечает клиентам в WhatsApp: подбирает время, записывает,
напоминает о визите. Пишешь ВЛАДЕЛЬЦУ салона в WhatsApp, коротко и по-человечески.

Лид: имя ${lead.name ?? "неизвестно"}, салон ${lead.company ?? "неизвестен"}, стадия ${lead.stage}.
${lead.needs ? `Что ему нужно: ${lead.needs}.` : ""}
${lead.objections ? `Возражения: ${lead.objections}.` : ""}
Факты платформы: активных салонов ${facts.salons}, записей за 7 дней ${facts.bookings7d}, из них ассистент оформил ${facts.aiBookings7d}, доля неявок ${facts.noShowRate30d}%.
${history.length ? `Уже сказано:\n${history.join("\n")}` : "Это первое сообщение."}

Правила: 3–5 предложений, без «инноваций» и «оптимизации», без технических слов (Meta, API, нейросеть).
Один конкретный вопрос в конце. Никаких обещаний скидок, которых нет. Верни только текст сообщения.`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return { text: fallback, fromModel: false };
    const json: any = await res.json();
    const text = String(
      json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "",
    ).trim();
    if (text.length < 40) return { text: fallback, fromModel: false };
    return { text: text.slice(0, 1200), fromModel: true };
  } catch (e: any) {
    console.error(`[ops-sales] gemini: ${e?.message ?? e}`);
    return { text: fallback, fromModel: false };
  }
}

// ---------------------------------------------------------------------------
// Канал Qabyl (подключается переменными, когда появится номер)
// ---------------------------------------------------------------------------

export function opsWaConfigured(): boolean {
  return Boolean(process.env.OPS_WA_PHONE_NUMBER_ID && process.env.OPS_WA_TOKEN);
}

/**
 * Отправка лиду с номера Qabyl. Свободный текст законен только в 24 часа после его сообщения —
 * за пределами окна Meta откажет, и отказ возвращается владельцу словами, а не тишиной.
 */
export async function sendLeadMessage(
  phone: string,
  text: string,
): Promise<{ ok: boolean; note: string }> {
  if (!opsWaConfigured()) {
    return { ok: false, note: "номер Qabyl ещё не подключён — отправьте вручную" };
  }
  const version = process.env.WA_CLOUD_API_VERSION ?? "v25.0";
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${process.env.OPS_WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPS_WA_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: phone,
          type: "text",
          text: { body: text, preview_url: false },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 200);
      try {
        const err = JSON.parse(raw)?.error;
        if (err?.code === 131047) detail = "вне 24-часового окна — нужен одобренный шаблон";
        else if (err?.message) detail = `${err.code ?? "?"}: ${err.message}`;
      } catch {
        /* оставляем сырой текст */
      }
      return { ok: false, note: `WhatsApp отказал — ${detail}` };
    }
    return { ok: true, note: "отправлено с номера Qabyl" };
  } catch (e: any) {
    return { ok: false, note: `сеть: ${e?.message ?? e}` };
  }
}
