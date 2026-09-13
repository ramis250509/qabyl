import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ChevronUp, ChevronDown, EyeOff, Eye, RotateCcw, ListChecks } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatPrice } from "@/lib/price";
import { humanError } from "@/lib/human-error";

const UNCATEGORIZED = "__uncategorized__";

type ServiceRow = {
  id: string;
  name: string;
  category: string | null;
  price: number | null;
  price_max: number | null;
  price_type: string | null;
  sort_order: number | null;
};

type Override = { service_id: string; is_enabled: boolean; sort_order: number | null };

// Список услуг, который видит и предлагает клиенту ИИ-ассистент в WhatsApp — отдельный
// от вкладки «Услуги». Порядок/видимость категорий хранятся на salon_ai_assistant
// (ai_category_order, ai_hidden_categories), порядок/включённость отдельных услуг — в
// таблице ai_service_overrides. Отсутствие переопределения = дефолт (как в «Услугах»).
export function AiServiceListEditor({ salonId }: { salonId: string }) {
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);

  async function load() {
    setLoading(true);
    const [{ data: svc }, { data: assistant }, { data: ov }] = await Promise.all([
      supabase
        .from("services")
        .select("id, name, category, price, price_max, price_type, sort_order")
        .eq("salon_id", salonId)
        .eq("is_active", true)
        .order("sort_order"),
      supabase
        .from("salon_ai_assistant")
        .select("ai_category_order, ai_hidden_categories")
        .eq("salon_id", salonId)
        .maybeSingle(),
      supabase
        .from("ai_service_overrides")
        .select("service_id, is_enabled, sort_order")
        .eq("salon_id", salonId),
    ]);
    setServices((svc as ServiceRow[]) ?? []);
    setCategoryOrder(((assistant as any)?.ai_category_order as string[]) ?? []);
    setHiddenCategories(((assistant as any)?.ai_hidden_categories as string[]) ?? []);
    setOverrides((ov as Override[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [salonId]);

  const groups = useMemo(() => {
    const byCat = new Map<string, ServiceRow[]>();
    for (const s of services) {
      const cat = (s.category ?? "").trim() || UNCATEGORIZED;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(s);
    }
    const ovMap = new Map(overrides.map((o) => [o.service_id, o]));
    for (const list of byCat.values()) {
      list.sort((a, b) => {
        const sa = ovMap.get(a.id)?.sort_order ?? a.sort_order ?? 0;
        const sb = ovMap.get(b.id)?.sort_order ?? b.sort_order ?? 0;
        return sa - sb;
      });
    }
    const knownCats = Array.from(byCat.keys());
    const orderedCats = [
      ...categoryOrder.filter((c) => knownCats.includes(c)),
      ...knownCats.filter((c) => !categoryOrder.includes(c)),
    ];
    return { orderedCats, byCat, ovMap };
  }, [services, categoryOrder, overrides]);

  async function persistCategoryOrder(next: string[]) {
    setCategoryOrder(next);
    const { error } = await supabase
      .from("salon_ai_assistant")
      .upsert({ salon_id: salonId, ai_category_order: next }, { onConflict: "salon_id" });
    if (error) toast.error(humanError(error));
  }

  async function persistHiddenCategories(next: string[]) {
    setHiddenCategories(next);
    const { error } = await supabase
      .from("salon_ai_assistant")
      .upsert({ salon_id: salonId, ai_hidden_categories: next }, { onConflict: "salon_id" });
    if (error) toast.error(humanError(error));
  }

  function moveCategory(cat: string, dir: -1 | 1) {
    const idx = groups.orderedCats.indexOf(cat);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= groups.orderedCats.length) return;
    const next = groups.orderedCats.slice();
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    persistCategoryOrder(next);
  }

  function toggleCategoryHidden(cat: string) {
    const next = hiddenCategories.includes(cat)
      ? hiddenCategories.filter((c) => c !== cat)
      : [...hiddenCategories, cat];
    persistHiddenCategories(next);
  }

  async function upsertOverride(serviceId: string, patch: Partial<Override>) {
    const existing = groups.ovMap.get(serviceId);
    const merged: Override = {
      service_id: serviceId,
      is_enabled: existing?.is_enabled ?? true,
      sort_order: existing?.sort_order ?? null,
      ...patch,
    };
    setOverrides((prev) => [...prev.filter((o) => o.service_id !== serviceId), merged]);
    const { error } = await supabase
      .from("ai_service_overrides")
      .upsert({ salon_id: salonId, ...merged }, { onConflict: "salon_id,service_id" });
    if (error) toast.error(humanError(error));
  }

  function toggleServiceEnabled(s: ServiceRow) {
    const enabled = groups.ovMap.get(s.id)?.is_enabled ?? true;
    upsertOverride(s.id, { is_enabled: !enabled });
  }

  function moveService(cat: string, serviceId: string, dir: -1 | 1) {
    const list = groups.byCat.get(cat) ?? [];
    const idx = list.findIndex((s) => s.id === serviceId);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= list.length) return;
    // Re-number the whole category sequentially so order stays stable after repeated moves.
    const reordered = list.slice();
    [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
    reordered.forEach((s, i) => upsertOverride(s.id, { sort_order: i }));
  }

  async function resetToServicesList() {
    if (!confirm("Сбросить кастомный список для Ассистента к обычному списку услуг?")) return;
    const [{ error: delErr }, { error: upErr }] = await Promise.all([
      supabase.from("ai_service_overrides").delete().eq("salon_id", salonId),
      supabase
        .from("salon_ai_assistant")
        .upsert({ salon_id: salonId, ai_category_order: [], ai_hidden_categories: [] }, { onConflict: "salon_id" }),
    ]);
    if (delErr) return toast.error(humanError(delErr));
    if (upErr) return toast.error(humanError(upErr));
    toast.success("Список для Ассистента сброшен");
    load();
  }

  if (loading) return null;

  return (
    <Card className="p-4 sm:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <ListChecks className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">Список услуг для Ассистента</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Свой порядок и видимость категорий/услуг для чата с клиентом — не влияет на
              вкладку «Услуги» и публичную запись. Стрелки меняют порядок, переключатель
              скрывает категорию или временно отключает услугу только для ассистента.
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={resetToServicesList}>
          <RotateCcw className="h-4 w-4 mr-1" />Сбросить
        </Button>
      </div>

      {groups.orderedCats.length === 0 && (
        <p className="text-sm text-muted-foreground">Пока нет активных услуг во вкладке «Услуги».</p>
      )}

      <div className="space-y-3">
        {groups.orderedCats.map((cat, catIdx) => {
          const isHidden = hiddenCategories.includes(cat);
          const label = cat === UNCATEGORIZED ? "Без категории" : cat;
          const list = groups.byCat.get(cat) ?? [];
          return (
            <div key={cat} className="rounded-lg border">
              <div className={`flex items-center justify-between gap-2 p-2.5 ${isHidden ? "opacity-50" : ""}`}>
                <div className="flex items-center gap-1 min-w-0">
                  <div className="flex flex-col -my-1 mr-1">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      disabled={catIdx === 0}
                      onClick={() => moveCategory(cat, -1)}
                    ><ChevronUp className="h-3.5 w-3.5" /></button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                      disabled={catIdx === groups.orderedCats.length - 1}
                      onClick={() => moveCategory(cat, 1)}
                    ><ChevronDown className="h-3.5 w-3.5" /></button>
                  </div>
                  <span className="font-medium truncate">{label}</span>
                  <span className="text-xs text-muted-foreground shrink-0">({list.length})</span>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0"
                  onClick={() => toggleCategoryHidden(cat)}
                  title={isHidden ? "Показать Ассистенту" : "Скрыть от Ассистента"}
                >
                  {isHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {isHidden ? "Скрыта" : "Видна"}
                </button>
              </div>
              {!isHidden && list.length > 0 && (
                <div className="divide-y border-t">
                  {list.map((s, sIdx) => {
                    const enabled = groups.ovMap.get(s.id)?.is_enabled ?? true;
                    return (
                      <div key={s.id} className={`flex items-center justify-between gap-2 p-2.5 pl-8 text-sm ${!enabled ? "opacity-50" : ""}`}>
                        <div className="flex items-center gap-1 min-w-0">
                          <div className="flex flex-col -my-1 mr-1">
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              disabled={sIdx === 0}
                              onClick={() => moveService(cat, s.id, -1)}
                            ><ChevronUp className="h-3 w-3" /></button>
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              disabled={sIdx === list.length - 1}
                              onClick={() => moveService(cat, s.id, 1)}
                            ><ChevronDown className="h-3 w-3" /></button>
                          </div>
                          <span className="truncate">{s.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">{formatPrice(s)}</span>
                        </div>
                        <Switch checked={enabled} onCheckedChange={() => toggleServiceEnabled(s)} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
