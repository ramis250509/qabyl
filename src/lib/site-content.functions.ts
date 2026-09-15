import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { INDUSTRY_SITE, INDUSTRIES_META, normalizeIndustry } from "./industries";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export type GeneratedSiteContent = {
  hero_title: string;
  hero_subtitle: string;
  about_text: string;
};

// Generate site copy (hero + about) in the salon's industry voice. Uses the LLM with high
// temperature so two salons in the same niche get genuinely different, human-sounding text — and
// falls back to the static per-industry example on any failure (no key, network, bad JSON), so
// the "Подставить пример" button always returns usable content.
export const generateSiteContent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<GeneratedSiteContent> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: salon }, { data: ai }] = await Promise.all([
      supabaseAdmin.from("salons").select("name").eq("id", data.salonId).maybeSingle(),
      supabaseAdmin
        .from("salon_ai_assistant")
        .select("industry")
        .eq("salon_id", data.salonId)
        .maybeSingle(),
    ]);
    const industry = normalizeIndustry((ai as any)?.industry);
    const fallback = INDUSTRY_SITE[industry];

    const apiKey = (process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);
    if (!apiKey) return fallback;

    try {
      const meta = INDUSTRIES_META[industry];
      const prompt = `Ты — сильный копирайтер. Напиши тексты для сайта бизнеса в нише «${meta.label}» (${meta.tagline}) в Кыргызстане${
        salon?.name ? `, название «${salon.name}»` : ""
      }.
Верни СТРОГО JSON без markdown и пояснений: {"hero_title": "...", "hero_subtitle": "...", "about_text": "..."}.
Требования:
- hero_title — цепляющий заголовок до 6 слов;
- hero_subtitle — одно предложение о сути;
- about_text — 2–3 живых предложения голосом специалиста этой ниши: чем вы отличаетесь и мягкое приглашение записаться.
Пиши по-человечески, разнообразно, без клише, штампов и эмодзи. Каждый раз формулируй по-новому.`;

      const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.1, responseMimeType: "application/json" },
        }),
      });
      if (!resp.ok) return fallback;
      const json: any = await resp.json();
      const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const parsed = JSON.parse(text);
      return {
        hero_title: String(parsed.hero_title || fallback.hero_title).slice(0, 120),
        hero_subtitle: String(parsed.hero_subtitle || fallback.hero_subtitle).slice(0, 300),
        about_text: String(parsed.about_text || fallback.about_text).slice(0, 1200),
      };
    } catch {
      return fallback;
    }
  });
