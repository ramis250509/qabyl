import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import {
  PHOTO_PRESETS,
  photoRuleRangeError,
  validatePhotoConfig,
  type PhotoCriterion,
  type PhotoPricingConfig,
} from "@/lib/photo-pricing";

type Service = {
  id: string;
  name: string;
  price: number;
  price_max: number | null;
  price_type: string;
  photo_pricing_config: unknown;
};
const empty: PhotoPricingConfig = { enabled: false, criteria: [] };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export function PhotoPricingEditor({ salonId }: { salonId: string }) {
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [copyTo, setCopyTo] = useState("");
  const [config, setConfig] = useState<PhotoPricingConfig>(empty);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    supabase
      .from("services")
      .select("id, name, price, price_max, price_type, photo_pricing_config")
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .order("sort_order")
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          toast.error("Не удалось загрузить настройки фото");
          return;
        }
        const rows = (data ?? []) as Service[];
        setServices(rows);
        setServiceId(rows[0]?.id ?? "");
      });
    return () => {
      active = false;
    };
  }, [salonId]);
  useEffect(() => {
    const raw = services.find((s) => s.id === serviceId)?.photo_pricing_config;
    setConfig(raw && typeof raw === "object" ? clone(raw as PhotoPricingConfig) : clone(empty));
  }, [serviceId, services]);
  const service = services.find((s) => s.id === serviceId);
  const updateCriterion = (id: string, change: (c: PhotoCriterion) => PhotoCriterion) =>
    setConfig((prev) => ({
      ...prev,
      criteria: prev.criteria.map((c) => (c.id === id ? change(c) : c)),
    }));
  const addPreset = (preset: PhotoCriterion) =>
    setConfig((prev) => ({
      ...prev,
      enabled: true,
      criteria: [...prev.criteria, clone(preset)],
    }));
  async function save(targetId = serviceId) {
    if (!targetId) return;
    const target = services.find((s) => s.id === targetId);
    const validation =
      config.enabled && target
        ? photoRuleRangeError(config, {
            price: target.price,
            price_max: target.price_max ?? target.price,
          })
        : null;
    if (validation) {
      toast.error(validation);
      return;
    }
    setSaving(true);
    const { data, error } = await supabase
      .from("services")
      .update({ photo_pricing_config: config as unknown as Json })
      .eq("id", targetId)
      .eq("salon_id", salonId)
      .select("id");
    setSaving(false);
    if (error || data?.length !== 1) {
      toast.error("Не удалось сохранить правила фото");
      return;
    }
    setServices((rows) =>
      rows.map((s) => (s.id === targetId ? { ...s, photo_pricing_config: clone(config) } : s)),
    );
    toast.success(targetId === serviceId ? "Правила фото сохранены" : "Правила скопированы");
  }
  function exportCatalog() {
    const configured = services.filter((s) => validatePhotoConfig(s.photo_pricing_config));
    const blob = new Blob([JSON.stringify(configured, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qabyl-photo-catalog.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="font-medium">Оценка цены по фото</h3>
        <p className="text-xs text-muted-foreground">
          Выберите услугу и укажите видимые критерии. ИИ определяет признаки, цену считает Qabyl по
          вашим цифрам. Без правил точную цену по фото не назовёт.
        </p>
        <Button type="button" size="sm" variant="link" onClick={exportCatalog}>
          Скачать правила для теста фото
        </Button>
      </div>
      <label className="block space-y-1 text-sm">
        Услуга
        <select
          className="w-full rounded-md border bg-background p-2"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.price_type === "range" ? `${s.price}–${s.price_max}` : s.price})
            </option>
          ))}
        </select>
      </label>
      {service?.price_type !== "range" ? (
        <p className="text-sm">
          У этой услуги фиксированная цена из прайса — оценка по фото не нужна.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Switch
              checked={!!config.enabled}
              onCheckedChange={(enabled) => setConfig((c) => ({ ...c, enabled }))}
            />
            <Label>Оценивать фото для этой услуги</Label>
          </div>
          {config.enabled && (
            <>
              <div className="flex flex-wrap gap-2">
                {PHOTO_PRESETS.filter((p) => !config.criteria.some((c) => c.id === p.id)).map(
                  (p) => (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      key={p.id}
                      onClick={() => addPreset(p)}
                    >
                      + {p.label}
                    </Button>
                  ),
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const id = `custom_${Date.now().toString(36)}`;
                    setConfig((c) => ({
                      ...c,
                      criteria: [
                        ...c.criteria,
                        {
                          id,
                          label: "Новый критерий",
                          mode: "surcharge",
                          options: [
                            { id: "option_1", label: "Вариант 1", amount: 0 },
                            { id: "option_2", label: "Вариант 2", amount: 0 },
                          ],
                        },
                      ],
                    }));
                  }}
                >
                  + Свой критерий
                </Button>
              </div>
              {config.criteria.map((c) => (
                <div className="space-y-2 rounded-md border p-3" key={c.id}>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Название критерия"
                      value={c.label}
                      onChange={(e) =>
                        updateCriterion(c.id, (v) => ({ ...v, label: e.target.value }))
                      }
                    />
                    <select
                      aria-label="Тип цены"
                      className="rounded-md border bg-background p-2 text-sm"
                      value={c.mode}
                      onChange={(e) =>
                        updateCriterion(c.id, (v) => ({
                          ...v,
                          mode: e.target.value as "base" | "surcharge",
                        }))
                      }
                    >
                      <option value="base">Цена</option>
                      <option value="surcharge">Доплата</option>
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setConfig((v) => ({
                          ...v,
                          criteria: v.criteria.filter((x) => x.id !== c.id),
                        }))
                      }
                    >
                      Убрать
                    </Button>
                  </div>
                  {c.options.map((o) => (
                    <div className="flex gap-2" key={o.id}>
                      <Input
                        aria-label="Вариант"
                        value={o.label}
                        onChange={(e) =>
                          updateCriterion(c.id, (v) => ({
                            ...v,
                            options: v.options.map((x) =>
                              x.id === o.id ? { ...x, label: e.target.value } : x,
                            ),
                          }))
                        }
                      />
                      <Input
                        aria-label={c.mode === "base" ? "Цена" : "Доплата"}
                        type="number"
                        min="0"
                        className="w-28"
                        value={o.amount}
                        onChange={(e) =>
                          updateCriterion(c.id, (v) => ({
                            ...v,
                            options: v.options.map((x) =>
                              x.id === o.id ? { ...x, amount: Number(e.target.value) } : x,
                            ),
                          }))
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={c.options.length <= 2}
                        onClick={() =>
                          updateCriterion(c.id, (v) => ({
                            ...v,
                            options: v.options.filter((x) => x.id !== o.id),
                          }))
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      updateCriterion(c.id, (v) => ({
                        ...v,
                        options: [
                          ...v.options,
                          {
                            id: `option_${Date.now().toString(36)}`,
                            label: "Новый вариант",
                            amount: 0,
                          },
                        ],
                      }))
                    }
                  >
                    + Вариант
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Для «Цены» укажите полную стоимость; «Доплата» прибавляется к ней. Итог обязан
                оставаться в диапазоне услуги {service.price}–{service.price_max}. Неразличимый
                признак → просьба прислать другое фото, не догадка.
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={saving} onClick={() => void save()}>
              Сохранить правила фото
            </Button>
            <select
              aria-label="Скопировать в услугу"
              className="rounded-md border bg-background p-2 text-sm"
              value={copyTo}
              onChange={(e) => setCopyTo(e.target.value)}
            >
              <option value="">Скопировать в…</option>
              {services
                .filter((s) => s.id !== serviceId && s.price_type === "range")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              variant="outline"
              disabled={!copyTo || saving}
              onClick={() => void save(copyTo)}
            >
              Копировать
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
