import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import {
  PHOTO_SUBJECTS,
  guessPhotoSubject,
  photoPresetsFor,
  photoZoneOf,
  photoPriceTable,
  photoRequestLine,
  photoRuleRangeError,
  validatePhotoConfig,
  type PhotoCriterion,
  type PhotoPricingConfig,
} from "@/lib/photo-pricing";

type Service = {
  id: string;
  name: string;
  category: string | null;
  price: number;
  price_max: number | null;
  price_type: string;
  photo_pricing_config: unknown;
};
const empty: PhotoPricingConfig = { enabled: false, criteria: [] };
/** «от 1500», а не «1500–null»: у части услуг-вилок в прайсе нет верхней цены. */
const priceLabel = (s: Service) =>
  s.price_type !== "range"
    ? String(s.price)
    : s.price_max == null
      ? `от ${s.price}`
      : `${s.price}–${s.price_max}`;
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
      .select("id, name, category, price, price_max, price_type, photo_pricing_config")
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
  // Готовые критерии — только для зоны этой услуги: у ресниц нет «густоты волос».
  const presets = photoPresetsFor(photoZoneOf(config, service));
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
              {`${s.name} (${priceLabel(s)})`}
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
              onCheckedChange={(enabled) =>
                setConfig((c) => ({
                  ...c,
                  enabled,
                  // Первое включение: зону угадываем по названию услуги, чтобы маникюру сразу
                  // предлагались критерии ногтей, а не «длина и густота волос».
                  subject:
                    c.subject ?? (c.criteria.length ? undefined : guessPhotoSubject(service)),
                }))
              }
            />
            <Label>Оценивать фото для этой услуги</Label>
          </div>
          {config.enabled && service.price_max == null && (
            <p className="rounded-md border border-destructive/40 p-3 text-sm">
              В прайсе у этой услуги нет цены «до» — ассистент не сможет назвать больше{" "}
              {service.price}. Укажите верхнюю цену во вкладке «Услуги», иначе доплаты не
              сохранятся.
            </p>
          )}
          {config.enabled && (
            <>
              {/* Две настройки вместо абзаца текста: что клиент фотографирует и нужен ли
                  референс. Из них собирается фраза-просьба, которую владелец видит тут же —
                  ровно ту, что услышит клиент. Печатать вручную ничего не нужно. */}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  Что клиент фотографирует
                  <select
                    aria-label="Что клиент фотографирует"
                    className="w-full rounded-md border bg-background p-2"
                    value={config.subject ?? ""}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, subject: e.target.value || undefined }))
                    }
                  >
                    <option value="">Не указывать</option>
                    {PHOTO_SUBJECTS.map((s) => (
                      <option key={s.id} value={s.genitive}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2 pt-6">
                  <Switch
                    checked={!!config.needs_reference}
                    onCheckedChange={(needs_reference) =>
                      setConfig((c) => ({ ...c, needs_reference }))
                    }
                  />
                  <Label>Нужно ещё фото желаемого результата</Label>
                </div>
              </div>
              <div className="rounded-md bg-muted p-3 text-sm">
                <span className="text-xs text-muted-foreground">Ассистент напишет клиенту:</span>
                <p className="mt-1">
                  {photoRequestLine({ ...config, enabled: true }) ||
                    "Добавьте хотя бы один критерий."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {presets
                  .filter((p) => !config.criteria.some((c) => c.id === p.id))
                  .map((p) => (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      key={p.id}
                      onClick={() => addPreset(p)}
                    >
                      + {p.label}
                    </Button>
                  ))}
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
              {!presets.length && (
                <p className="text-xs text-muted-foreground">
                  Для этой зоны готовых критериев нет — добавьте свой.
                </p>
              )}
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
                    {/* На каком снимке искать признак. Сложность дизайна видна на референсе, а
                        не на фото «до» — без этой пометки ИИ читал бы её не с того кадра. */}
                    <select
                      aria-label="По какому фото"
                      className="rounded-md border bg-background p-2 text-sm"
                      value={c.shot === "reference" ? "reference" : "current"}
                      onChange={(e) =>
                        updateCriterion(c.id, (v) => ({
                          ...v,
                          shot: e.target.value as "current" | "reference",
                        }))
                      }
                    >
                      <option value="current">Видно сейчас</option>
                      <option value="reference">Видно на референсе</option>
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
              <PriceTablePreview config={config} service={service} />
              <p className="text-xs text-muted-foreground">
                «Цена» — полная стоимость услуги, её варианты пишите целиком. «Доплата» прибавляется
                к ней, у самого простого варианта ставьте 0. Итог обязан оставаться в прайсе услуги{" "}
                {service.price}–{service.price_max ?? service.price}. Не видно признака на фото —
                ассистент попросит переснять, а не угадает.
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

/**
 * Итоговые цены таблицей — ответ на вопрос «сколько выйдет, если длинные и густые», который
 * иначе владелец считает в уме. Комбинации вне прайса подсвечены: сохранить такие правила
 * кабинет не даст, и по таблице сразу видно, какая именно строка виновата.
 */
function PriceTablePreview({ config, service }: { config: PhotoPricingConfig; service: Service }) {
  const table = photoPriceTable({ ...config, enabled: true }, service);
  if (!table) return null;
  const max = service.price_max ?? service.price;
  const outside = (price: number) => price < service.price || price > max;
  return (
    <div className="space-y-1 rounded-md border p-3">
      <span className="text-xs text-muted-foreground">Какие цены назовёт ассистент:</span>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="p-1 text-left font-normal">
                {table.colTitle ? `${table.rowTitle} / ${table.colTitle}` : table.rowTitle}
              </th>
              {(table.cols.length ? table.cols : ["Цена"]).map((col, j) => (
                <th key={j} className="p-1 text-right font-normal">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-t">
                <td className="p-1">{row}</td>
                {table.prices[i].map((price, j) => (
                  <td
                    key={j}
                    className={`p-1 text-right tabular-nums ${outside(price) ? "font-medium text-destructive" : ""}`}
                  >
                    {price}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.extras.map((extra, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          + доплата за «{extra.label}»:{" "}
          {extra.min === extra.max ? extra.min : `от ${extra.min} до ${extra.max}`}
        </p>
      ))}
    </div>
  );
}
