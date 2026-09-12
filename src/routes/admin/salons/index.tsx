import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, ExternalLink, Globe, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { LoadingState } from "@/components/ui/loading-state";
import { useRegisterRefresh } from "@/lib/refresh-context";

export const Route = createFileRoute("/admin/salons/")({
  component: SalonsList,
});

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(
      /[а-яё]/g,
      (c) =>
        ({
          а: "a",
          б: "b",
          в: "v",
          г: "g",
          д: "d",
          е: "e",
          ё: "e",
          ж: "zh",
          з: "z",
          и: "i",
          й: "y",
          к: "k",
          л: "l",
          м: "m",
          н: "n",
          о: "o",
          п: "p",
          р: "r",
          с: "s",
          т: "t",
          у: "u",
          ф: "f",
          х: "h",
          ц: "c",
          ч: "ch",
          ш: "sh",
          щ: "sch",
          ъ: "",
          ы: "y",
          ь: "",
          э: "e",
          ю: "yu",
          я: "ya",
        })[c] ?? c,
    )
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function SalonsList() {
  const [salons, setSalons] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // Автоподстановка slug идёт по названию, пока владелец сам его не правил. Судить по «поле
  // пустое» нельзя: после первой же буквы оно перестаёт быть пустым, и slug замирал на «т».
  const [slugTouched, setSlugTouched] = useState(false);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("salons")
      .select("*")
      .order("created_at", { ascending: false });
    setSalons(data ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);
  useRegisterRefresh(load);

  async function create() {
    if (!name.trim()) return toast.error("Введите название");
    const finalSlug = slug.trim() || slugify(name);
    const { error } = await supabase.from("salons").insert({
      name: name.trim(),
      slug: finalSlug,
      address: address || null,
      phone: phone || null,
      description: description || null,
    });
    if (error) return toast.error(humanError(error));
    toast.success("Салон создан");
    setOpen(false);
    setName("");
    setSlug("");
    setSlugTouched(false);
    setAddress("");
    setPhone("");
    setDescription("");
    load();
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Салоны</h1>
          <p className="text-muted-foreground">Управление всеми салонами</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Новый салон
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Создать салон</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Название</Label>
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                />
              </div>
              <div>
                <Label>Slug (для URL)</Label>
                <Input
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  placeholder="my-salon"
                />
              </div>
              <div>
                <Label>Адрес</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
              <div>
                <Label>Телефон</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div>
                <Label>Описание</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <Button className="w-full" onClick={create}>
                Создать
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {loading && salons.length === 0 ? (
        <Card>
          <LoadingState />
        </Card>
      ) : salons.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground">Пока ни одного салона. Создайте первый.</p>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {salons.map((s) => (
            <Card key={s.id} className="p-5">
              <div className="flex items-start gap-3">
                <div
                  className="h-12 w-12 rounded-full flex items-center justify-center font-bold text-white"
                  style={{ background: s.brand_primary || "#0ea5e9" }}
                >
                  {s.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{s.name}</h3>
                  <p className="text-xs text-muted-foreground truncate">{s.address || "—"}</p>
                  {s.custom_domain && (
                    <p className="text-xs text-primary mt-1 flex items-center gap-1">
                      <Globe className="h-3 w-3" />
                      {s.custom_domain}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <Link to="/admin/salons/$salonId" params={{ salonId: s.id }} className="flex-1">
                  <Button variant="outline" size="sm" className="w-full">
                    Настройки
                  </Button>
                </Link>
                {s.custom_domain && (
                  <a href={`https://${s.custom_domain}`} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm">
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </a>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    if (
                      !confirm(
                        `Удалить салон «${s.name}» вместе со всеми его данными (мастера, услуги, записи, филиалы)? Это действие необратимо.`,
                      )
                    )
                      return;
                    const { error } = await supabase.from("salons").delete().eq("id", s.id);
                    if (error) return toast.error(humanError(error));
                    toast.success("Салон удалён");
                    load();
                  }}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
