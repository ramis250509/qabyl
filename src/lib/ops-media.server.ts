// Картинки для постов Миры. ТОЛЬКО СЕРВЕР.
//
// ГЛАВНОЕ: КАЖДЫЙ ВЫЗОВ СТОИТ ДЕНЕГ. Поэтому здесь потолок расходов в сутки, стоимость считается
// до генерации и показывается владельцу, а картинка делается только по его команде — ни один
// автоматический проход (крон, шина, лечение) сюда не ходит.
//
// Модель: gpt-image-2 (gpt-image-1 отключают 23.10.2026). Качество по умолчанию «low» — для ленты
// бьюти-аккаунта этого хватает, а разница в цене тридцатикратная: 0,006 против 0,211 доллара.
//
// Картинка кладётся в публичный бакет: Instagram скачивает медиа ПО ССЫЛКЕ и не умеет принимать
// файл в запросе. Ссылка должна быть доступна без авторизации, иначе публикация не состоится.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { audit, kvGet, kvSet } from "@/lib/ops-agents.server";
import { imageCostUsd } from "@/lib/ops-content";

const db = () => supabaseAdmin as any;
const OPENAI_IMAGES = "https://api.openai.com/v1/images/generations";
const BUCKET = "ops-media";

function model(): string {
  return (process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2").trim();
}

/** Потолок расходов на картинки в сутки, долларов. Меняется переменной, без выкладки. */
function dailyCapUsd(): number {
  const v = Number(process.env.OPS_MEDIA_DAILY_USD ?? 3);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

export function mediaConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export type ImageQuality = "low" | "medium" | "high";

/** Сколько уже потрачено сегодня и сколько осталось. */
export async function mediaSpendToday(): Promise<{ spentUsd: number; capUsd: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const kv = (await kvGet("media_spend")) as { date?: string; usd?: number } | null;
  return {
    spentUsd: kv?.date === today ? Number(kv.usd ?? 0) : 0,
    capUsd: dailyCapUsd(),
  };
}

async function addSpend(usd: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { spentUsd } = await mediaSpendToday();
  await kvSet("media_spend", { date: today, usd: Number((spentUsd + usd).toFixed(4)) });
}

/** Бакет создаётся при первой картинке — отдельной миграции для этого не нужно. */
async function ensureBucket(): Promise<void> {
  try {
    const { data } = await db().storage.getBucket(BUCKET);
    if (data) return;
    await db().storage.createBucket(BUCKET, { public: true });
  } catch {
    // Уже есть или нет прав — вторая попытка загрузки скажет об этом точнее.
  }
}

export type GenerateResult =
  | { ok: true; url: string; path: string; costUsd: number }
  | { ok: false; error: string };

/**
 * Сгенерировать картинку и положить в хранилище. Возвращает публичную ссылку.
 *
 * Отказ — это всегда слова, с которыми владелец может что-то сделать: нет ключа, кончился дневной
 * лимит, модель отказалась. Молчаливого «не получилось» здесь быть не должно: за каждой такой
 * попыткой стоит его решение опубликовать пост.
 */
export async function generateImage(opts: {
  prompt: string;
  quality?: ImageQuality;
  /** Квадрат для ленты, вертикаль для сторис и рилс. */
  vertical?: boolean;
}): Promise<GenerateResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "ключ OpenAI не задан" };

  const quality: ImageQuality = opts.quality ?? "low";
  const cost = imageCostUsd(quality);
  const { spentUsd, capUsd } = await mediaSpendToday();
  if (spentUsd + cost > capUsd) {
    return {
      ok: false,
      error: `дневной лимит на картинки исчерпан (${spentUsd.toFixed(2)} из ${capUsd.toFixed(2)} $)`,
    };
  }

  try {
    const res = await fetch(OPENAI_IMAGES, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model(),
        prompt: opts.prompt,
        size: opts.vertical ? "1024x1536" : "1024x1024",
        quality,
        n: 1,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, error: `модель отказала: ${String(msg).slice(0, 200)}` };
    }
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: "модель вернула пустой ответ" };

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const path = `posts/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.png`;

    await ensureBucket();
    const { error: upErr } = await db()
      .storage.from(BUCKET)
      .upload(path, bytes, { contentType: "image/png", upsert: false });
    if (upErr) return { ok: false, error: `не удалось сохранить картинку: ${upErr.message}` };

    const { data: pub } = db().storage.from(BUCKET).getPublicUrl(path);
    const url = pub?.publicUrl;
    if (!url) return { ok: false, error: "картинка сохранена, но ссылка не получена" };

    await addSpend(cost);
    await audit("marketer", "media.generated", { costUsd: cost, quality, path });
    return { ok: true, url, path, costUsd: cost };
  } catch (e: any) {
    return { ok: false, error: `сеть или таймаут: ${e?.message ?? e}` };
  }
}
