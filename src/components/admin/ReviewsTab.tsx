import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Star, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";

export function ReviewsTab({ salonId }: { salonId: string }) {
  const [reviews, setReviews] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ client_name: "", rating: 5, text: "" });

  async function load() {
    const { data } = await supabase
      .from("salon_reviews")
      .select("*")
      .eq("salon_id", salonId)
      .order("created_at", { ascending: false });
    setReviews(data ?? []);
  }
  useEffect(() => {
    load();
  }, [salonId]);

  async function add() {
    if (!form.client_name.trim()) return toast.error("Введите имя клиента");
    const { error } = await supabase.from("salon_reviews").insert({ ...form, salon_id: salonId });
    if (error) return toast.error(humanError(error));
    toast.success("Отзыв добавлен");
    setForm({ client_name: "", rating: 5, text: "" });
    setAdding(false);
    load();
  }

  async function togglePublish(id: string, is_published: boolean) {
    await supabase.from("salon_reviews").update({ is_published: !is_published }).eq("id", id);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Удалить отзыв?")) return;
    await supabase.from("salon_reviews").delete().eq("id", id);
    load();
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <Card className="p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Отзывы клиентов</h3>
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Добавить
            </Button>
          )}
        </div>

        {adding && (
          <div className="border rounded-lg p-4 space-y-3 mb-4 bg-muted/30">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>Имя клиента</Label>
                <Input
                  value={form.client_name}
                  onChange={(e) => setForm({ ...form, client_name: e.target.value })}
                />
              </div>
              <div>
                <Label>Оценка</Label>
                <div className="flex gap-1 mt-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => setForm({ ...form, rating: n })}>
                      <Star
                        className="h-6 w-6"
                        fill={n <= form.rating ? "#f59e0b" : "none"}
                        stroke="#f59e0b"
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <Label>Текст отзыва</Label>
              <Textarea
                rows={3}
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={add}>
                Сохранить
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Отмена
              </Button>
            </div>
          </div>
        )}

        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пока нет отзывов</p>
        ) : (
          <div className="space-y-2">
            {reviews.map((r) => (
              <div
                key={r.id}
                className="border rounded-lg p-3 flex items-start justify-between gap-3"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-sm">{r.client_name}</div>
                    <div className="flex">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className="h-3 w-3"
                          fill={i < r.rating ? "#f59e0b" : "none"}
                          stroke="#f59e0b"
                        />
                      ))}
                    </div>
                  </div>
                  {r.text && <p className="text-sm text-muted-foreground mt-1">{r.text}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    <Switch
                      checked={r.is_published}
                      onCheckedChange={() => togglePublish(r.id, r.is_published)}
                    />
                    <span className="text-muted-foreground">
                      {r.is_published ? "Видно" : "Скрыто"}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => remove(r.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
