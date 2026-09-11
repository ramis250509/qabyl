// Поиск кандидатов в «Контакты без Админа» по переписке салона.
//
// Всё читается за один вызов и считается в памяти: PostgREST не умеет GROUP BY, а переписка
// салона за два месяца — несколько тысяч строк. Страниц ограниченное число, чтобы вызов укладывался
// в лимит подзапросов воркера; если переписок больше, смотрим самые свежие и честно говорим об этом.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const DAY = 86_400_000;
const PAGE = 1000;

export type ExcludedCandidate = {
  phone: string;
  name: string | null;
  score: number;
  confidence: "high" | "medium";
  reasons: string[];
  aiReplies: number;
  preview: string | null;
  lastMessageAt: string | null;
};

async function assertSalonAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

async function fetchPages(
  make: (from: number, to: number) => any,
  maxPages: number,
): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await make(i * PAGE, (i + 1) * PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const last9 = (v: unknown) =>
  String(v ?? "")
    .replace(/\D/g, "")
    .slice(-9);

export const findExcludedCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { assessContact, stemsFromServiceNames } = await import("@/lib/excluded-suggestions");
    const sb = supabaseAdmin as any;
    const salonId = data.salonId;
    const since = new Date(Date.now() - 60 * DAY).toISOString();

    const [convRes, msgRes, apptRes, excludedQ, servicesQ, salonQ, branchesQ, secretsQ] =
      await Promise.all([
        fetchPages(
          (f, t) =>
            sb
              .from("wa_conversations")
              .select(
                "id, client_phone, client_name, channel, appointment_id, last_appointment_at, last_message_at",
              )
              .eq("salon_id", salonId)
              .gte("last_message_at", since)
              .order("last_message_at", { ascending: false })
              .range(f, t),
          3,
        ),
        fetchPages(
          (f, t) =>
            sb
              .from("wa_messages")
              .select("conversation_id, direction, kind, text_body")
              .eq("salon_id", salonId)
              .gte("created_at", since)
              .order("created_at", { ascending: false })
              .range(f, t),
          15,
        ),
        fetchPages(
          (f, t) =>
            sb
              .from("appointments")
              .select("client_phone")
              .eq("salon_id", salonId)
              .order("created_at", { ascending: false })
              .range(f, t),
          5,
        ),
        sb.from("excluded_contacts").select("phone").eq("salon_id", salonId),
        sb.from("services").select("name").eq("salon_id", salonId),
        sb.from("salons").select("phone").eq("id", salonId).maybeSingle(),
        sb.from("branches").select("phone").eq("salon_id", salonId),
        sb.from("salon_secrets").select("owner_notify_phone").eq("salon_id", salonId).maybeSingle(),
      ]);

    const excludedKeys = new Set((excludedQ.data ?? []).map((r: any) => last9(r.phone)));
    const bookedKeys = new Set(apptRes.rows.map((r: any) => last9(r.client_phone)));
    const salonKeys = new Set(
      [
        salonQ.data?.phone,
        secretsQ.data?.owner_notify_phone,
        ...(branchesQ.data ?? []).map((b: any) => b.phone),
      ]
        .map(last9)
        .filter((k) => k.length === 9),
    );
    const stems = stemsFromServiceNames(
      (servicesQ.data ?? []).map((s: any) => String(s.name ?? "")),
    );

    const byConv = new Map<
      string,
      { texts: string[]; inbound: number; ai: number; owner: number }
    >();
    for (const m of msgRes.rows) {
      const agg = byConv.get(m.conversation_id) ?? { texts: [], inbound: 0, ai: 0, owner: 0 };
      if (m.direction === "in") {
        agg.inbound++;
        if (m.text_body && agg.texts.length < 40) agg.texts.push(String(m.text_body).slice(0, 400));
      } else if (m.kind === "system") {
        // Сообщение, набранное владельцем на телефоне, приходит эхом и хранится как system.
        if (m.text_body) agg.owner++;
      } else if (m.kind === "text") {
        agg.ai++;
      }
      byConv.set(m.conversation_id, agg);
    }

    const seen = new Set<string>();
    const candidates: ExcludedCandidate[] = [];
    for (const c of convRes.rows) {
      const raw = String(c.client_phone ?? "");
      if (c.channel === "instagram" || raw.startsWith("ig:")) continue;
      const phone = raw.replace(/\D/g, "");
      if (phone.length < 8) continue;
      const key = phone.slice(-9);
      if (excludedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);

      const agg = byConv.get(c.id) ?? { texts: [], inbound: 0, ai: 0, owner: 0 };
      const verdict = assessContact(
        {
          phone,
          name: c.client_name ?? null,
          inboundTexts: agg.texts,
          inboundCount: agg.inbound,
          aiReplies: agg.ai,
          ownerReplies: agg.owner,
          everBooked: Boolean(c.appointment_id || c.last_appointment_at) || bookedKeys.has(key),
          isSalonNumber: salonKeys.has(key),
        },
        stems,
      );
      if (!verdict) continue;
      candidates.push({
        phone,
        name: c.client_name ?? null,
        ...verdict,
        aiReplies: agg.ai,
        preview: agg.texts[0] ? agg.texts[0].slice(0, 90) : null,
        lastMessageAt: c.last_message_at ?? null,
      });
    }

    candidates.sort((a, b) => b.score - a.score || b.aiReplies - a.aiReplies);
    return {
      candidates: candidates.slice(0, 60),
      scannedChats: seen.size,
      truncated: convRes.truncated || msgRes.truncated,
    };
  });
