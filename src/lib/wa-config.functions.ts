// Server functions to manage the AI WhatsApp webhook configuration for a salon.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { WaAgentState, WaAgentStateData, WaIncomingMessage } from "@/lib/wa-agent.server";

async function assertSalonAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

function publicBaseUrl(): string {
  // Stable production URL pattern. Override with PUBLIC_APP_URL if needed.
  return (
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://qabyl.lovable.app"
  );
}

function genToken(): string {
  // 32 hex chars
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const getWaWebhookConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("salon_secrets")
      .select("greenapi_webhook_token")
      .eq("salon_id", data.salonId)
      .maybeSingle();
    const token = row?.greenapi_webhook_token ?? null;
    return {
      has_token: !!token,
      webhook_url: token
        ? `${publicBaseUrl()}/api/public/wa/${data.salonId}?token=${token}`
        : null,
    };
  });

export const simulateWaMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      salonId: z.string().uuid(),
      messageText: z.string(),
      history: z.array(z.any()).default([]),
      state: z.string().default("idle"),
      stateData: z.record(z.unknown()).default({}),
      selectedBranchId: z.string().nullable().default(null),
      imageBase64: z.string().optional(),
      imageMime: z.string().optional(),
    }).parse(input)
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runWaAgent } = await import("@/lib/wa-agent.server");

    const [{ data: salon }, { data: assistant }, { data: branchRows }] = await Promise.all([
      supabaseAdmin.from("salons").select("id, name, timezone").eq("id", data.salonId).maybeSingle(),
      supabaseAdmin.from("salon_ai_assistant").select("greeting, tone_instructions, pricing_rules, languages").eq("salon_id", data.salonId).maybeSingle(),
      supabaseAdmin.from("branches").select("id, name, address").eq("salon_id", data.salonId).eq("is_active", true).order("sort_order"),
    ]);

    if (!salon) throw new Error("Salon not found");

    // Upload simulator image to storage if provided
    let imageSignedUrl: string | null = null;
    let imagePath: string | null = null;
    if (data.imageBase64 && data.imageMime) {
      const ext = data.imageMime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      imagePath = `simulator/${data.salonId}/${Date.now()}.${ext}`;
      const bytes = Uint8Array.from(atob(data.imageBase64), (c) => c.charCodeAt(0));
      const { error: upErr } = await supabaseAdmin.storage
        .from("wa-media")
        .upload(imagePath, bytes, { contentType: data.imageMime, upsert: false });
      if (!upErr) {
        const { data: s } = await supabaseAdmin.storage
          .from("wa-media")
          .createSignedUrl(imagePath, 600);
        imageSignedUrl = s?.signedUrl ?? null;
      }
    }

    const isImageOnly = imageSignedUrl && !data.messageText.trim();
    const incomingMsg: WaIncomingMessage = {
      id: crypto.randomUUID(),
      direction: "in",
      kind: imageSignedUrl ? "image" : "text",
      text_body: data.messageText || null,
      media_signed_url: imageSignedUrl,
      media_mime: data.imageMime ?? null,
      media_path: imagePath,
      created_at: new Date().toISOString(),
    };

    const result = await runWaAgent({
      salon: {
        salonId: data.salonId,
        salonName: (salon as any).name,
        timezone: (salon as any).timezone ?? "UTC",
      },
      config: {
        greeting: (assistant as any)?.greeting ?? null,
        tone_instructions: (assistant as any)?.tone_instructions ?? null,
        pricing_rules: (assistant as any)?.pricing_rules ?? null,
        languages: (assistant as any)?.languages?.length ? (assistant as any).languages : ["ru"],
      },
      client: { phone: "simulator_test", name: "Тест" },
      history: data.history as WaIncomingMessage[],
      lastMessages: [incomingMsg],
      branches: (branchRows ?? []).map((b: any) => ({
        id: b.id,
        name: b.name,
        address: b.address ?? null,
      })),
      selectedBranchId: data.selectedBranchId,
      state: data.state as WaAgentState,
      stateData: data.stateData as WaAgentStateData,
    });

    return {
      reply: result.reply,
      nextState: result.nextState,
      nextStateData: result.nextStateData,
      selectedBranchId: result.selectedBranchId,
      debug: result.debug,
    };
  });

export const regenerateWaWebhookToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = genToken();
    const { error } = await supabaseAdmin.from("salon_secrets").upsert(
      { salon_id: data.salonId, greenapi_webhook_token: token },
      { onConflict: "salon_id" },
    );
    if (error) throw new Error(error.message);
    return {
      has_token: true,
      webhook_url: `${publicBaseUrl()}/api/public/wa/${data.salonId}?token=${token}`,
    };
  });
