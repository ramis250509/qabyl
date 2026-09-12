import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { generateSiteContent } from "@/lib/site-content.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Upload, Trash2, Image as ImageIcon, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";

const TEMPLATES = [
  { id: "minimal", name: "Минимал", desc: "Белый фон, много воздуха, тонкая типографика" },
  { id: "premium", name: "Премиум", desc: "Тёмный фон, золотые акценты, serif-заголовки" },
  { id: "vivid", name: "Яркий", desc: "Градиенты на бренд-цветах, жирный шрифт, тени" },
  {
    id: "custom",
    name: "Свой HTML",
    desc: "Полный контроль над оформлением — вставьте собственный HTML-код",
  },
];

export function SiteTab({ salon, onSaved }: { salon: any; onSaved: (s: any) => void }) {
  const [form, setForm] = useState<any>({
    site_template: salon.site_template || "minimal",
    site_enabled: salon.site_enabled ?? true,
    multilang_enabled: salon.multilang_enabled ?? false,
    hero_title: salon.hero_title ?? "",
    hero_subtitle: salon.hero_subtitle ?? "",
    hero_image_url: salon.hero_image_url ?? "",
    about_text: salon.about_text ?? "",
    gallery_images: salon.gallery_images ?? [],
    instagram_url: salon.instagram_url ?? "",
    tiktok_url: salon.tiktok_url ?? "",
    whatsapp_url: salon.whatsapp_url ?? "",
    telegram_url: salon.telegram_url ?? "",
    custom_html: salon.custom_html ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const genContent = useServerFn(generateSiteContent);

  // Generate site text (hero + about) in the salon's niche voice — unique each time (the server
  // uses the LLM, falling back to a per-industry example). Never overwrites what the owner wrote.
  async function fillSiteExamples() {
    setGenerating(true);
    try {
      const ex = await genContent({ data: { salonId: salon.id } });
      setForm((f: any) => ({
        ...f,
        hero_title: f.hero_title?.trim() ? f.hero_title : ex.hero_title,
        hero_subtitle: f.hero_subtitle?.trim() ? f.hero_subtitle : ex.hero_subtitle,
        about_text: f.about_text?.trim() ? f.about_text : ex.about_text,
      }));
      toast.success("Текст сайта сгенерирован под вашу нишу — отредактируйте под свой салон");
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось сгенерировать текст"));
    } finally {
      setGenerating(false);
    }
  }

  async function uploadFile(file: File, kind: "hero" | "gallery") {
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `${salon.id}/${kind}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("salon-media")
      .upload(path, file, { upsert: false });
    setUploading(false);
    if (error) {
      toast.error(humanError(error));
      return null;
    }
    const { data } = supabase.storage.from("salon-media").getPublicUrl(path);
    return data.publicUrl;
  }

  async function onHeroUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = await uploadFile(file, "hero");
    if (url) setForm({ ...form, hero_image_url: url });
  }

  async function onGalleryUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const urls: string[] = [];
    for (const f of files) {
      const u = await uploadFile(f, "gallery");
      if (u) urls.push(u);
    }
    if (urls.length) setForm({ ...form, gallery_images: [...form.gallery_images, ...urls] });
    e.target.value = "";
  }

  function removeGalleryImage(url: string) {
    setForm({ ...form, gallery_images: form.gallery_images.filter((u: string) => u !== url) });
  }

  async function save() {
    setSaving(true);
    const { data, error } = await supabase
      .from("salons")
      .update(form)
      .eq("id", salon.id)
      .select()
      .single();
    setSaving(false);
    if (error) return toast.error(humanError(error));
    toast.success("Сохранено");
    onSaved(data);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Card className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Показывать сайт на домене</h3>
            <p className="text-sm text-muted-foreground">
              Если выключено — на домене сразу откроется форма записи (как раньше).
            </p>
          </div>
          <Switch
            checked={form.site_enabled}
            onCheckedChange={(v) => setForm({ ...form, site_enabled: v })}
          />
        </div>
        <div className="flex items-center justify-between pt-4 border-t">
          <div>
            <h3 className="font-semibold">Мультиязычность сайта (RU / KY / EN)</h3>
            <p className="text-sm text-muted-foreground">
              Когда выключено — сайт показывается только на русском, переключатель языков скрыт.
            </p>
          </div>
          <Switch
            checked={form.multilang_enabled}
            onCheckedChange={(v) => setForm({ ...form, multilang_enabled: v })}
          />
        </div>
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <h3 className="font-semibold">Шаблон сайта</h3>
        <div className="grid sm:grid-cols-3 gap-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setForm({ ...form, site_template: t.id })}
              className={`p-4 rounded-lg border-2 text-left transition ${form.site_template === t.id ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground"}`}
            >
              <div className="font-medium">{t.name}</div>
              <div className="text-xs text-muted-foreground mt-1">{t.desc}</div>
            </button>
          ))}
        </div>

        {form.site_template === "custom" && (
          <div className="space-y-2 pt-2 border-t">
            <Label>Кастомный HTML</Label>
            <Textarea
              rows={12}
              value={form.custom_html}
              onChange={(e) => setForm({ ...form, custom_html: e.target.value })}
              placeholder={`<section><h1>{{hero_title}}</h1><p>{{hero_subtitle}}</p>{{booking_button}}</section>\n<section><h2>Услуги</h2><div style="display:grid;gap:1rem">{{services}}</div></section>`}
              className="font-mono text-xs"
            />
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium">Доступные плейсхолдеры:</p>
              <p>
                <code className="bg-muted px-1 rounded">{"{{hero_title}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{hero_subtitle}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{hero_image}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{salon_name}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{about}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{phone}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{address}}"}</code>
              </p>
              <p>
                <code className="bg-muted px-1 rounded">{"{{booking_button}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{services}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{masters}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{gallery}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{reviews}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{contacts}}"}</code>
              </p>
              <p>
                URL соцсетей: <code className="bg-muted px-1 rounded">{"{{instagram}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{tiktok}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{whatsapp}}"}</code> ·{" "}
                <code className="bg-muted px-1 rounded">{"{{telegram}}"}</code>
              </p>
              <p className="pt-1">
                Скрипты вырезаются автоматически (для безопасности). Стили (CSS) и любая разметка —
                работают.
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold">Hero (первый экран)</h3>
            <p className="text-sm text-muted-foreground">
              Заголовок, подзаголовок и «О салоне» можно сгенерировать под вашу нишу — каждый раз
              по-новому.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={fillSiteExamples}
            disabled={generating}
          >
            {generating ? "Генерирую…" : "Сгенерировать текст"}
          </Button>
        </div>
        <div>
          <Label>Заголовок</Label>
          <Input
            value={form.hero_title}
            onChange={(e) => setForm({ ...form, hero_title: e.target.value })}
            placeholder={salon.name}
          />
        </div>
        <div>
          <Label>Подзаголовок</Label>
          <Textarea
            value={form.hero_subtitle}
            onChange={(e) => setForm({ ...form, hero_subtitle: e.target.value })}
            placeholder="Короткое описание салона в 1-2 предложениях"
          />
        </div>
        <div>
          <Label>Фоновое фото</Label>
          <div className="flex items-center gap-3 mt-2">
            {form.hero_image_url ? (
              <img src={form.hero_image_url} className="h-20 w-32 object-cover rounded-md border" />
            ) : (
              <div className="h-20 w-32 rounded-md border flex items-center justify-center bg-muted">
                <ImageIcon className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <div className="space-y-2">
              <input
                type="file"
                accept="image/*"
                onChange={onHeroUpload}
                className="hidden"
                id="hero-upload"
              />
              <label
                htmlFor="hero-upload"
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded-md cursor-pointer hover:bg-muted"
              >
                <Upload className="h-4 w-4" />
                {uploading ? "..." : "Загрузить"}
              </label>
              {form.hero_image_url && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setForm({ ...form, hero_image_url: "" })}
                >
                  Удалить
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <h3 className="font-semibold">О салоне</h3>
        <Textarea
          rows={5}
          value={form.about_text}
          onChange={(e) => setForm({ ...form, about_text: e.target.value })}
          placeholder="Расскажите о салоне: история, философия, что вас отличает"
        />
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <h3 className="font-semibold">Галерея работ</h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {form.gallery_images.map((url: string) => (
            <div key={url} className="relative aspect-square group">
              <img src={url} className="w-full h-full object-cover rounded-md border" />
              <button
                onClick={() => removeGalleryImage(url)}
                className="absolute top-1 right-1 bg-destructive text-destructive-foreground rounded-full p-1 opacity-0 group-hover:opacity-100 transition"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <label className="aspect-square border-2 border-dashed rounded-md flex items-center justify-center cursor-pointer hover:bg-muted">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={onGalleryUpload}
              className="hidden"
            />
            <Upload className="h-5 w-5 text-muted-foreground" />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Можно выбрать несколько фото сразу</p>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <h3 className="font-semibold">Соцсети</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label>Instagram</Label>
            <Input
              value={form.instagram_url}
              onChange={(e) => setForm({ ...form, instagram_url: e.target.value })}
              placeholder="https://instagram.com/..."
            />
          </div>
          <div>
            <Label>TikTok</Label>
            <Input
              value={form.tiktok_url}
              onChange={(e) => setForm({ ...form, tiktok_url: e.target.value })}
              placeholder="https://tiktok.com/@..."
            />
          </div>
          <div>
            <Label>WhatsApp</Label>
            <Input
              value={form.whatsapp_url}
              onChange={(e) => setForm({ ...form, whatsapp_url: e.target.value })}
              placeholder="https://wa.me/7..."
            />
          </div>
          <div>
            <Label>Telegram</Label>
            <Input
              value={form.telegram_url}
              onChange={(e) => setForm({ ...form, telegram_url: e.target.value })}
              placeholder="https://t.me/..."
            />
          </div>
        </div>
      </Card>

      <div className="flex gap-3 items-center">
        <Button onClick={save} disabled={saving}>
          {saving ? "..." : "Сохранить"}
        </Button>
        <a
          href={`/preview/salon/${salon.id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ExternalLink className="h-4 w-4" />
          Открыть превью сайта
        </a>
      </div>
    </div>
  );
}
