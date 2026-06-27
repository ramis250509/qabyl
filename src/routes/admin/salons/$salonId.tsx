import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Plus, Trash2, Edit, Copy, UserPlus, ChevronDown, FolderPlus, MapPin, GripVertical } from "lucide-react";
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, DragOverlay, type DragEndEvent, type DragStartEvent, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { createSalonAdmin, listSalonAdmins, revokeSalonAdmin } from "@/lib/salon-admins.functions";
import { createBranchMaster, listBranchMasters, revokeBranchMaster } from "@/lib/branch-masters.functions";
import { createSalonMaster, listSalonMasters, revokeSalonMaster } from "@/lib/salon-masters.functions";
import { getSalonSecrets, upsertSalonSecrets } from "@/lib/salon-secrets.functions";
import { KeyRound } from "lucide-react";
import { SiteTab } from "@/components/admin/SiteTab";
import { SalonShareCard } from "@/components/admin/SalonShareCard";
import { ReviewsTab } from "@/components/admin/ReviewsTab";
import { formatPrice } from "@/lib/price";
import { BranchHoursEditor, defaultBranchHours } from "@/components/admin/BranchHoursEditor";
import { MasterDayOverrides } from "@/components/admin/MasterDayOverrides";
import { AiAssistantTab } from "@/components/admin/AiAssistantTab";
// WaChatsTab tab hidden from UI by request; component kept for future use.

export const Route = createFileRoute("/admin/salons/$salonId")({
  component: SalonEdit,
});

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

const TIMEZONES: { value: string; label: string }[] = [
  { value: "Asia/Bishkek", label: "Бишкек (UTC+6)" },
  { value: "Asia/Almaty", label: "Алматы (UTC+5)" },
  { value: "Asia/Aqtobe", label: "Актобе (UTC+5)" },
  { value: "Asia/Tashkent", label: "Ташкент (UTC+5)" },
  { value: "Asia/Dushanbe", label: "Душанбе (UTC+5)" },
  { value: "Asia/Ashgabat", label: "Ашхабад (UTC+5)" },
  { value: "Europe/Moscow", label: "Москва (UTC+3)" },
  { value: "Europe/Samara", label: "Самара (UTC+4)" },
  { value: "Asia/Yekaterinburg", label: "Екатеринбург (UTC+5)" },
  { value: "Asia/Novosibirsk", label: "Новосибирск (UTC+7)" },
  { value: "Europe/Kyiv", label: "Киев (UTC+2/+3)" },
  { value: "Europe/Minsk", label: "Минск (UTC+3)" },
  { value: "Asia/Baku", label: "Баку (UTC+4)" },
  { value: "Asia/Yerevan", label: "Ереван (UTC+4)" },
  { value: "Asia/Tbilisi", label: "Тбилиси (UTC+4)" },
  { value: "Asia/Dubai", label: "Дубай (UTC+4)" },
  { value: "Europe/Istanbul", label: "Стамбул (UTC+3)" },
];

function SalonEdit() {
  const { salonId } = Route.useParams();
  const navigate = useNavigate();
  const { isSuperAdmin } = useAuth();
  const [salon, setSalon] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("info");

  useEffect(() => {
    supabase.from("salons").select("*").eq("id", salonId).maybeSingle().then(({ data }) => setSalon(data));
  }, [salonId]);

  if (!salon) return <div className="p-8 text-muted-foreground">Загрузка...</div>;

  return (
    <div className="p-4 sm:p-8 space-y-6">
      {isSuperAdmin && (
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/admin/salons" })}>
          <ArrowLeft className="h-4 w-4 mr-1" />К списку
        </Button>
      )}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold">{salon.name}</h1>
        <p className="text-muted-foreground">Настройки салона</p>
      </div>

      <SalonShareCard slug={salon.slug} name={salon.name} />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="info">Информация</TabsTrigger>
            <TabsTrigger value="branches">Филиалы</TabsTrigger>
            <TabsTrigger value="site">Сайт</TabsTrigger>
            <TabsTrigger value="reviews">Отзывы</TabsTrigger>
            <TabsTrigger value="masters">Мастера</TabsTrigger>
            <TabsTrigger value="services">Услуги</TabsTrigger>
            <TabsTrigger value="addons">Доп. услуги</TabsTrigger>
            <TabsTrigger value="faq">FAQ</TabsTrigger>
            <TabsTrigger value="integrations">WhatsApp</TabsTrigger>
            {(isSuperAdmin || salon.ai_assistant_enabled) && <TabsTrigger value="ai">Ассистент</TabsTrigger>}
            
            {isSuperAdmin && <TabsTrigger value="access">Доступ</TabsTrigger>}
          </TabsList>
        </div>

        <TabsContent value="info"><SalonInfoTab salon={salon} onSaved={(s) => setSalon(s)} /></TabsContent>
        <TabsContent value="branches"><BranchesTab salonId={salonId} /></TabsContent>
        <TabsContent value="site"><SiteTab salon={salon} onSaved={(s) => setSalon(s)} /></TabsContent>
        <TabsContent value="reviews"><ReviewsTab salonId={salonId} /></TabsContent>
        <TabsContent value="masters"><MastersTab salonId={salonId} /></TabsContent>
        <TabsContent value="services"><ServicesTab salonId={salonId} /></TabsContent>
        <TabsContent value="addons"><AddonsTab salonId={salonId} /></TabsContent>
        <TabsContent value="faq"><FaqTab salonId={salonId} /></TabsContent>
        <TabsContent value="integrations"><IntegrationsTab salon={salon} onSaved={(s) => setSalon(s)} /></TabsContent>
        {(isSuperAdmin || salon.ai_assistant_enabled) && (
          <TabsContent value="ai"><AiAssistantTab salonId={salonId} salonName={salon.name} onOpenWhatsAppTab={() => setActiveTab("integrations")} /></TabsContent>
        )}
        {isSuperAdmin && <TabsContent value="access"><AccessTab salonId={salonId} /></TabsContent>}
      </Tabs>

    </div>
  );
}

function SalonInfoTab({ salon, onSaved }: { salon: any; onSaved: (s: any) => void }) {
  const [form, setForm] = useState(salon);
  const [saving, setSaving] = useState(false);
  const [tzNow, setTzNow] = useState("");

  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

  useEffect(() => {
    function tick() {
      try {
        setTzNow(new Intl.DateTimeFormat("ru-RU", { timeZone: form.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()));
      } catch { setTzNow("—"); }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [form.timezone]);

  const tzMismatch = (() => {
    if (!browserTz || !form.timezone) return false;
    try {
      const fmt = (tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date());
      return fmt(browserTz) !== fmt(form.timezone);
    } catch { return false; }
  })();

  async function save() {
    const slug = (form.slug ?? "").trim();
    if (!/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) {
      return toast.error("Slug: 3–40 символов, латиница/цифры/дефис, без дефиса по краям");
    }
    setSaving(true);
    const { data, error } = await supabase.from("salons").update({
      name: form.name, slug, description: form.description, address: form.address, phone: form.phone,
      custom_domain: form.custom_domain || null, brand_primary: form.brand_primary, brand_accent: form.brand_accent,
      logo_url: form.logo_url || null, timezone: form.timezone, is_active: form.is_active,
    }).eq("id", salon.id).select().single();
    setSaving(false);
    if (error) {
      if (String(error.message).includes("salons_slug")) return toast.error("Такой slug уже занят");
      return toast.error(error.message);
    }
    toast.success("Сохранено. Старая ссылка больше не работает.");
    onSaved(data);
  }


  return (
    <Card className="p-4 sm:p-6 space-y-4 max-w-2xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><Label>Название</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div>
          <Label>Slug</Label>
          <Input
            value={form.slug ?? ""}
            onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40) })}
            placeholder="my-salon"
          />
          <p className="text-xs text-muted-foreground mt-1">Латиница, цифры и дефис. После сохранения старая ссылка перестанет работать.</p>
        </div>
      </div>
      <div><Label>Описание</Label><Textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><Label>Адрес (общий)</Label><Input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
        <div><Label>Телефон (общий)</Label><Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
      </div>
      <p className="text-xs text-muted-foreground">Конкретные адреса и телефоны точек настраиваются во вкладке «Филиалы».</p>
      <div>
        <Label>Кастомный домен</Label>
        <Input value={form.custom_domain ?? ""} onChange={(e) => setForm({ ...form, custom_domain: e.target.value })} placeholder="zapis.салон.com" />
        <p className="text-xs text-muted-foreground mt-1">Без <code>https://</code> и без слэшей.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><Label>Основной цвет</Label><Input type="color" value={form.brand_primary ?? "#0ea5e9"} onChange={(e) => setForm({ ...form, brand_primary: e.target.value })} /></div>
        <div><Label>Акцент</Label><Input type="color" value={form.brand_accent ?? "#f59e0b"} onChange={(e) => setForm({ ...form, brand_accent: e.target.value })} /></div>
      </div>
      <div>
        <Label>Часовой пояс салона</Label>
        <Select value={form.timezone} onValueChange={(v) => setForm({ ...form, timezone: v })}>
          <SelectTrigger><SelectValue placeholder="Выберите город" /></SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            {form.timezone && !TIMEZONES.some((t) => t.value === form.timezone) && (
              <SelectItem value={form.timezone}>{form.timezone}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Сейчас по этому поясу: <b>{tzNow}</b>. Все слоты записи показываются клиентам именно в этом времени.
        </p>
        {tzMismatch && (
          <div className="mt-2 text-xs rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 space-y-1">
            <p>⚠️ Время выше не совпадает с часами на вашем устройстве ({browserTz}). Если салон находится там же, где и вы — нажмите кнопку ниже.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, timezone: browserTz })}>
              Использовать моё время ({browserTz})
            </Button>
          </div>
        )}
      </div>
      <div>
        <Label>Логотип салона</Label>
        <div className="flex items-center gap-3 mt-2">
          {form.logo_url ? (
            <img src={form.logo_url} alt="Логотип" className="h-16 w-16 rounded-full object-cover border" />
          ) : (
            <div className="h-16 w-16 rounded-full border flex items-center justify-center bg-muted text-xs text-muted-foreground">нет</div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="image/*"
              id="logo-upload"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]; if (!file) return;
                const ext = file.name.split(".").pop();
                const path = `${salon.id}/logo/${Date.now()}.${ext}`;
                const { error } = await supabase.storage.from("salon-media").upload(path, file, { upsert: false });
                if (error) return toast.error(error.message);
                const { data } = supabase.storage.from("salon-media").getPublicUrl(path);
                setForm({ ...form, logo_url: data.publicUrl });
                e.target.value = "";
              }}
            />
            <label htmlFor="logo-upload" className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded-md cursor-pointer hover:bg-muted">
              Загрузить фото
            </label>
            {form.logo_url && (
              <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, logo_url: "" })}>Удалить</Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">Не забудьте нажать «Сохранить» после загрузки.</p>
      </div>
      <Button onClick={save} disabled={saving}>{saving ? "..." : "Сохранить"}</Button>
    </Card>
  );
}

function BranchesTab({ salonId }: { salonId: string }) {
  const [branches, setBranches] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [mastersForBranch, setMastersForBranch] = useState<any | null>(null);
  const [salonMastersOpen, setSalonMastersOpen] = useState(false);

  async function load() {
    const { data } = await supabase.from("branches").select("*").eq("salon_id", salonId).order("sort_order");
    setBranches(data ?? []);
  }
  useEffect(() => { load(); }, [salonId]);

  return (
    <Card className="p-4 sm:p-6 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="font-semibold">Филиалы</h2>
          <p className="text-xs text-muted-foreground">Если филиалов больше одного, клиент выберет нужный перед записью.</p>
        </div>
        <Button size="sm" onClick={() => setEditing({ salon_id: salonId, name: "", address: "", phone: "", is_active: true })}>
          <Plus className="h-4 w-4 mr-1" />Добавить
        </Button>
      </div>

      {branches.length === 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">Пока нет филиалов</p>
          <div className="rounded-lg border border-dashed p-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Логины мастеров салона</p>
              <p className="text-xs text-muted-foreground">
                Создайте общий логин для мастеров — они увидят только Календарь и Уведомления салона.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setSalonMastersOpen(true)}>
              <KeyRound className="h-4 w-4 mr-1" />Управлять
            </Button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {branches.map((b) => (
          <div key={b.id} className="flex items-start justify-between gap-2 p-3 border rounded-lg">
            <div className="flex items-start gap-3 min-w-0">
              <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center shrink-0"><MapPin className="h-4 w-4" /></div>
              <div className="min-w-0">
                <p className="font-medium truncate">{b.name}</p>
                {b.address && <p className="text-xs text-muted-foreground truncate">{b.address}</p>}
                {b.phone && <p className="text-xs text-muted-foreground truncate">{b.phone}</p>}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button size="sm" variant="ghost" title="Логины мастеров филиала" onClick={() => setMastersForBranch(b)}>
                <KeyRound className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(b)}><Edit className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" onClick={async () => {
                if (!confirm(`Удалить филиал «${b.name}»? Мастера и записи останутся, но привязка к филиалу пропадёт.`)) return;
                const { error } = await supabase.from("branches").delete().eq("id", b.id);
                if (error) return toast.error(error.message);
                load();
              }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <BranchDialog
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {mastersForBranch && (
        <BranchMastersDialog
          branch={mastersForBranch}
          onClose={() => setMastersForBranch(null)}
        />
      )}
      {salonMastersOpen && (
        <SalonMastersDialog salonId={salonId} onClose={() => setSalonMastersOpen(false)} />
      )}
    </Card>
  );
}

function BranchMastersDialog({ branch, onClose }: { branch: any; onClose: () => void }) {
  const list = useServerFn(listBranchMasters);
  const create = useServerFn(createBranchMaster);
  const revoke = useServerFn(revokeBranchMaster);
  const [items, setItems] = useState<any[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [newCreds, setNewCreds] = useState<{ email: string; password: string } | null>(null);

  async function load() {
    try { setItems(await list({ data: { branchId: branch.id } })); }
    catch (e: any) { toast.error(e.message); }
  }
  useEffect(() => { load(); }, [branch.id]);

  async function onCreate() {
    if (!email.trim()) return toast.error("Введите email");
    setBusy(true);
    try {
      const res = await create({ data: { branchId: branch.id, email: email.trim() } });
      if (res.alreadyExisted) toast.success("Пользователь уже существовал — доступ выдан");
      else if (res.password) setNewCreds({ email: res.email, password: res.password });
      setEmail("");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function onRevoke(roleId: string) {
    if (!confirm("Отозвать доступ?")) return;
    try { await revoke({ data: { roleId } }); toast.success("Доступ отозван"); load(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Логины мастеров — {branch.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Создай общий логин для филиала. Все мастера филиала заходят под ним и видят только календарь и уведомления своего филиала.
          </p>
          <div className="flex gap-2">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="masters-aksakal@salon.com" type="email" />
            <Button onClick={onCreate} disabled={busy}><UserPlus className="h-4 w-4 mr-1" />{busy ? "..." : "Создать"}</Button>
          </div>
          <div className="space-y-2">
            {items.length === 0 && <p className="text-sm text-muted-foreground">Пока никто не имеет доступа</p>}
            {items.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{a.email}</p>
                  <p className="text-xs text-muted-foreground">Доступ с {new Date(a.createdAt).toLocaleDateString("ru-RU")}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onRevoke(a.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <Dialog open={!!newCreds} onOpenChange={(o) => !o && setNewCreds(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Логин создан</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Передай эти данные мастерам филиала. Пароль показывается один раз!</p>
              <div>
                <Label>Email</Label>
                <div className="flex gap-2">
                  <Input value={newCreds?.email ?? ""} readOnly />
                  <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newCreds?.email ?? ""); toast.success("Скопировано"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label>Пароль</Label>
                <div className="flex gap-2">
                  <Input value={newCreds?.password ?? ""} readOnly className="font-mono" />
                  <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newCreds?.password ?? ""); toast.success("Скопировано"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Button className="w-full" onClick={() => setNewCreds(null)}>Готово</Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function SalonMastersDialog({ salonId, onClose }: { salonId: string; onClose: () => void }) {
  const list = useServerFn(listSalonMasters);
  const create = useServerFn(createSalonMaster);
  const revoke = useServerFn(revokeSalonMaster);
  const [items, setItems] = useState<any[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [newCreds, setNewCreds] = useState<{ email: string; password: string } | null>(null);

  async function load() {
    try { setItems(await list({ data: { salonId } })); }
    catch (e: any) { toast.error(e.message); }
  }
  useEffect(() => { load(); }, [salonId]);

  async function onCreate() {
    if (!email.trim()) return toast.error("Введите email");
    setBusy(true);
    try {
      const res = await create({ data: { salonId, email: email.trim() } });
      if (res.alreadyExisted) toast.success("Пользователь уже существовал — доступ выдан");
      else if (res.password) setNewCreds({ email: res.email, password: res.password });
      setEmail("");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function onRevoke(roleId: string) {
    if (!confirm("Отозвать доступ?")) return;
    try { await revoke({ data: { roleId } }); toast.success("Доступ отозван"); load(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Логины мастеров салона</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Создай общий логин для мастеров салона. Они зайдут под ним и увидят только Календарь и Уведомления салона.
          </p>
          <div className="flex gap-2">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="masters@salon.com" type="email" />
            <Button onClick={onCreate} disabled={busy}><UserPlus className="h-4 w-4 mr-1" />{busy ? "..." : "Создать"}</Button>
          </div>
          <div className="space-y-2">
            {items.length === 0 && <p className="text-sm text-muted-foreground">Пока никто не имеет доступа</p>}
            {items.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{a.email}</p>
                  <p className="text-xs text-muted-foreground">Доступ с {new Date(a.createdAt).toLocaleDateString("ru-RU")}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onRevoke(a.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <Dialog open={!!newCreds} onOpenChange={(o) => !o && setNewCreds(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Логин создан</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Передай эти данные мастерам. Пароль показывается один раз!</p>
              <div>
                <Label>Email</Label>
                <div className="flex gap-2">
                  <Input value={newCreds?.email ?? ""} readOnly />
                  <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newCreds?.email ?? ""); toast.success("Скопировано"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label>Пароль</Label>
                <div className="flex gap-2">
                  <Input value={newCreds?.password ?? ""} readOnly className="font-mono" />
                  <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newCreds?.password ?? ""); toast.success("Скопировано"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Button className="w-full" onClick={() => setNewCreds(null)}>Готово</Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function BranchDialog({ editing, onClose, onSaved }: { editing: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({ working_hours: defaultBranchHours(), ...editing });
  async function save() {
    if (!form.name?.trim()) return toast.error("Введите название филиала");
    const payload = {
      name: form.name.trim(),
      address: form.address || null,
      phone: form.phone || null,
      is_active: form.is_active ?? true,
      working_hours: form.working_hours ?? null,
      instagram_url: form.instagram_url || null,
      whatsapp_url: form.whatsapp_url || null,
      telegram_url: form.telegram_url || null,
      tiktok_url: form.tiktok_url || null,
    };
    if (form.id) {
      const { error } = await supabase.from("branches").update(payload).eq("id", form.id);
      if (error) return toast.error(error.message);
    } else {
      const { error } = await supabase.from("branches").insert({ salon_id: form.salon_id, ...payload });
      if (error) return toast.error(error.message);
    }
    toast.success("Сохранено");
    onSaved();
  }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{form.id ? "Редактировать филиал" : "Новый филиал"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Название</Label><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Филиал на Ахунбаева" /></div>
          <div><Label>Адрес</Label><Input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="ул. Ахунбаева, 119" /></div>
          <div><Label>Телефон</Label><Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+996 ..." /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Instagram</Label><Input value={form.instagram_url ?? ""} onChange={(e) => setForm({ ...form, instagram_url: e.target.value })} placeholder="https://instagram.com/..." /></div>
            <div><Label>WhatsApp</Label><Input value={form.whatsapp_url ?? ""} onChange={(e) => setForm({ ...form, whatsapp_url: e.target.value })} placeholder="https://wa.me/996..." /></div>
            <div><Label>Telegram</Label><Input value={form.telegram_url ?? ""} onChange={(e) => setForm({ ...form, telegram_url: e.target.value })} placeholder="https://t.me/..." /></div>
            <div><Label>TikTok</Label><Input value={form.tiktok_url ?? ""} onChange={(e) => setForm({ ...form, tiktok_url: e.target.value })} placeholder="https://tiktok.com/@..." /></div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.is_active ?? true} onCheckedChange={(v) => setForm({ ...form, is_active: !!v })} />
            Активен
          </label>
          <BranchHoursEditor value={form.working_hours} onChange={(wh) => setForm({ ...form, working_hours: wh })} />
          <Button className="w-full" onClick={save}>Сохранить</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MastersTab({ salonId }: { salonId: string }) {
  const [deleting, setDeleting] = useState<any | null>(null);
  async function confirmDelete() {
    if (!deleting) return;
    const { error } = await supabase.from("masters").delete().eq("id", deleting.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Мастер удалён");
    setDeleting(null);
    load();
  }
  const [masters, setMasters] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);

  async function load() {
    const [{ data: m }, { data: b }] = await Promise.all([
      supabase.from("masters").select("*").eq("salon_id", salonId).order("sort_order"),
      supabase.from("branches").select("id, name").eq("salon_id", salonId).order("sort_order"),
    ]);
    setMasters(m ?? []);
    setBranches(b ?? []);
  }
  useEffect(() => { load(); }, [salonId]);
  

  const grouped = (() => {
    const map = new Map<string, { id: string | null; name: string; items: any[] }>();
    for (const b of branches) map.set(b.id, { id: b.id, name: b.name, items: [] });
    map.set("__none__", { id: null, name: "Без филиала", items: [] });
    for (const m of masters) {
      const k = m.branch_id ?? "__none__";
      if (!map.has(k)) map.set(k, { id: m.branch_id, name: "—", items: [] });
      map.get(k)!.items.push(m);
    }
    return Array.from(map.values()).filter((g) => g.items.length > 0 || branches.some((b) => b.id === g.id));
  })();

  return (
    <Card className="p-4 sm:p-6 space-y-5">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold">Мастера</h2>
        <Button size="sm" onClick={() => setEditing({ salon_id: salonId, name: "", specialization: "", photo_url: "", is_active: true, branch_id: branches[0]?.id ?? null })}>
          <Plus className="h-4 w-4 mr-1" />Добавить
        </Button>
      </div>

      {masters.length === 0 && <p className="text-muted-foreground text-sm">Пока нет мастеров</p>}

      {grouped.map((g) => (
        <div key={g.id ?? "__none__"} className="space-y-2">
          <div className="flex items-center justify-between border-b pb-1.5">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5" />{g.name}
              <span className="text-xs font-normal text-muted-foreground/70">· {g.items.length}</span>
            </h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing({ salon_id: salonId, name: "", specialization: "", photo_url: "", is_active: true, branch_id: g.id })}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />Добавить
            </Button>
          </div>
          {g.items.length === 0 ? (
            <p className="text-xs text-muted-foreground italic px-1">Нет мастеров в этом филиале</p>
          ) : (
            <div className="space-y-2">
              {g.items.map((m) => (
                <div key={m.id} className="flex items-start justify-between gap-2 p-3 border rounded-lg">
                  <div className="flex items-center gap-3 min-w-0">
                    {m.photo_url ? <img src={m.photo_url} className="h-10 w-10 rounded-full object-cover shrink-0" /> : <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">{m.name[0]}</div>}
                    <div className="min-w-0">
                      <p className="font-medium truncate">{m.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.specialization}</p>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(m)}><Edit className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(m)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {editing && <MasterDialog master={editing} branches={branches} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} salonId={salonId} />}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить мастера {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Все записи мастера (включая будущие), расписания и привязки к услугам будут удалены безвозвратно. Клиенты не получат уведомления об отмене.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Удалить мастера и записи
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function MasterDialog({ master, salonId, branches, onClose, onSaved }: { master: any; salonId: string; branches: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(master);
  const [services, setServices] = useState<any[]>([]);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [schedule, setSchedule] = useState<Record<number, { start: string; end: string } | null>>({});

  useEffect(() => {
    supabase.from("services").select("*").eq("salon_id", salonId).then(({ data }) => setServices(data ?? []));
    if (master.id) {
      supabase.from("master_services").select("service_id").eq("master_id", master.id).then(({ data }) => {
        setLinked(new Set((data ?? []).map((r: any) => r.service_id)));
      });
      supabase.from("master_schedules").select("*").eq("master_id", master.id).then(({ data }) => {
        const sch: any = {};
        (data ?? []).forEach((s: any) => { sch[s.weekday] = { start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }; });
        setSchedule(sch);
      });
    }
  }, [master.id, salonId]);

  async function save() {
    if (!form.name?.trim()) return toast.error("Введите имя");
    let id = form.id;
    const payload = {
      name: form.name, specialization: form.specialization, photo_url: form.photo_url || null,
      is_active: form.is_active ?? true, branch_id: form.branch_id || null,
    };
    if (id) {
      const { error } = await supabase.from("masters").update(payload).eq("id", id);
      if (error) return toast.error(error.message);
    } else {
      const { data, error } = await supabase.from("masters").insert({ salon_id: salonId, ...payload }).select().single();
      if (error) return toast.error(error.message);
      id = data.id;
    }
    await supabase.from("master_services").delete().eq("master_id", id);
    if (linked.size > 0) {
      await supabase.from("master_services").insert(Array.from(linked).map((sid) => ({ master_id: id, service_id: sid })));
    }
    await supabase.from("master_schedules").delete().eq("master_id", id);
    const inserts = Object.entries(schedule).filter(([_, v]) => v).map(([wd, v]) => ({
      master_id: id, weekday: Number(wd), start_time: v!.start, end_time: v!.end,
    }));
    if (inserts.length) await supabase.from("master_schedules").insert(inserts);
    toast.success("Сохранено");
    onSaved();
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{form.id ? "Редактировать мастера" : "Новый мастер"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Имя</Label><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Специализация</Label><Input value={form.specialization ?? ""} onChange={(e) => setForm({ ...form, specialization: e.target.value })} /></div>
          <div>
            <Label>Фото мастера</Label>
            <div className="flex items-center gap-3 mt-2">
              {form.photo_url ? (
                <img src={form.photo_url} alt="" className="h-16 w-16 rounded-full object-cover border" />
              ) : (
                <div className="h-16 w-16 rounded-full border flex items-center justify-center bg-muted text-xs text-muted-foreground">нет</div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  accept="image/*"
                  id={`master-photo-${form.id ?? "new"}`}
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]; if (!file) return;
                    const ext = file.name.split(".").pop();
                    const path = `${salonId}/masters/${Date.now()}.${ext}`;
                    const { error } = await supabase.storage.from("salon-media").upload(path, file, { upsert: false });
                    if (error) return toast.error(error.message);
                    const { data } = supabase.storage.from("salon-media").getPublicUrl(path);
                    setForm({ ...form, photo_url: data.publicUrl });
                    e.target.value = "";
                  }}
                />
                <label htmlFor={`master-photo-${form.id ?? "new"}`} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded-md cursor-pointer hover:bg-muted">
                  Загрузить
                </label>
                {form.photo_url && (
                  <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, photo_url: "" })}>Удалить</Button>
                )}
              </div>
            </div>
          </div>

          {branches.length > 0 && (
            <div>
              <Label>Филиал</Label>
              <Select value={form.branch_id ?? "__none__"} onValueChange={(v) => setForm({ ...form, branch_id: v === "__none__" ? null : v })}>
                <SelectTrigger><SelectValue placeholder="Без филиала" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Без филиала —</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Клиент увидит этого мастера только при выборе соответствующего филиала.</p>
            </div>
          )}

          <div>
            <Label>Услуги мастера</Label>
            <div className="space-y-1 mt-2 max-h-40 overflow-y-auto border rounded p-2">
              {services.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={linked.has(s.id)} onCheckedChange={(v) => {
                    const n = new Set(linked); if (v) n.add(s.id); else n.delete(s.id); setLinked(n);
                  }} />
                  {s.name} <span className="text-muted-foreground">({s.duration_min} мин · {formatPrice(s)})</span>
                </label>
              ))}
              {services.length === 0 && <p className="text-xs text-muted-foreground">Сначала добавьте услуги во вкладке "Услуги"</p>}
            </div>
          </div>

          <div>
            <Label>График работы</Label>
            <div className="space-y-2 mt-2">
              {WEEKDAYS.map((wd, i) => {
                const day = schedule[i];
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                    <div className="w-12 font-medium">{wd}</div>
                    <Checkbox checked={!!day} onCheckedChange={(v) => setSchedule({ ...schedule, [i]: v ? { start: "10:00", end: "20:00" } : null })} />
                    {day && (
                      <>
                        <Input type="time" value={day.start} onChange={(e) => setSchedule({ ...schedule, [i]: { ...day, start: e.target.value } })} className="w-28" />
                        <span>—</span>
                        <Input type="time" value={day.end} onChange={(e) => setSchedule({ ...schedule, [i]: { ...day, end: e.target.value } })} className="w-28" />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {form.id && <MasterDayOverrides masterId={form.id} />}

          <Button onClick={save} className="w-full">Сохранить</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


const UNCATEGORIZED = "__uncategorized__";
const NO_CATEGORY = "__none__";
const NEW_CATEGORY = "__new__";

function ServicesTab({ salonId }: { salonId: string }) {
  const [services, setServices] = useState<any[]>([]);
  const [extraCats, setExtraCats] = useState<string[]>([]);
  const [catOrder, setCatOrder] = useState<string[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [renamingCat, setRenamingCat] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const [activeDrag, setActiveDrag] = useState<{ kind: "service" | "category"; id: string } | null>(null);

  const [collapsedCats, setCollapsedCats] = useState<string[]>([]);

  async function load() {
    const [{ data: svc }, { data: salon }] = await Promise.all([
      supabase.from("services").select("*").eq("salon_id", salonId).order("sort_order"),
      supabase.from("salons").select("category_order, collapsed_categories").eq("id", salonId).maybeSingle(),
    ]);
    setServices(svc ?? []);
    setCatOrder((salon?.category_order as string[]) ?? []);
    setCollapsedCats(((salon as any)?.collapsed_categories as string[]) ?? []);
  }
  useEffect(() => { load(); }, [salonId]);

  async function toggleCollapsed(name: string) {
    const next = collapsedCats.includes(name) ? collapsedCats.filter((c) => c !== name) : [...collapsedCats, name];
    setCollapsedCats(next);
    const { error } = await supabase.from("salons").update({ collapsed_categories: next as any }).eq("id", salonId);
    if (error) toast.error(error.message);
  }


  const usedCats = Array.from(new Set(services.map((s) => (s.category ?? "").trim()).filter(Boolean)));
  const allCatsUnordered = Array.from(new Set([...usedCats, ...extraCats]));
  const allCats = [
    ...catOrder.filter((c) => allCatsUnordered.includes(c)),
    ...allCatsUnordered.filter((c) => !catOrder.includes(c)),
  ];

  async function persistCategoryOrder(next: string[]) {
    setCatOrder(next);
    await supabase.from("salons").update({ category_order: next }).eq("id", salonId);
  }

  function toggleCat(c: string) {
    const n = new Set(openCats);
    if (n.has(c)) n.delete(c); else n.add(c);
    setOpenCats(n);
  }

  function addCategory() {
    const v = newCatName.trim();
    if (!v) return;
    if (allCats.includes(v)) return toast.error("Такая категория уже есть");
    setExtraCats([...extraCats, v]);
    setOpenCats(new Set([...openCats, v]));
    persistCategoryOrder([...allCats, v]);
    setNewCatName("");
    toast.success("Категория создана");
  }

  async function renameCategory(oldName: string) {
    const v = renameValue.trim();
    if (!v || v === oldName) { setRenamingCat(null); return; }
    if (allCats.includes(v)) return toast.error("Такая категория уже есть");
    const ids = services.filter((s) => (s.category ?? "") === oldName).map((s) => s.id);
    if (ids.length) {
      const { error } = await supabase.from("services").update({ category: v }).in("id", ids);
      if (error) return toast.error(error.message);
    }
    setExtraCats(extraCats.map((c) => (c === oldName ? v : c)));
    await persistCategoryOrder(catOrder.map((c) => (c === oldName ? v : c)));
    setRenamingCat(null);
    load();
  }

  async function deleteCategory(name: string) {
    const inCat = services.filter((s) => (s.category ?? "") === name);
    if (inCat.length > 0) {
      if (!confirm(`В категории "${name}" ${inCat.length} услуг. Удалить категорию? Услуги останутся, но станут без категории.`)) return;
      const { error } = await supabase.from("services").update({ category: null }).in("id", inCat.map((s) => s.id));
      if (error) return toast.error(error.message);
    }
    setExtraCats(extraCats.filter((c) => c !== name));
    await persistCategoryOrder(catOrder.filter((c) => c !== name));
    load();
  }

  // Group services by category
  const groups = new Map<string, any[]>();
  for (const c of allCats) groups.set(c, []);
  groups.set(UNCATEGORIZED, []);
  for (const s of services) {
    const c = (s.category ?? "").trim();
    if (c && groups.has(c)) groups.get(c)!.push(s);
    else if (c) { groups.set(c, [s]); }
    else groups.get(UNCATEGORIZED)!.push(s);
  }
  // Sort each group by sort_order
  for (const list of groups.values()) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  async function persistServiceOrder(updates: { id: string; category: string | null; sort_order: number }[]) {
    // Optimistic — issue parallel updates
    await Promise.all(updates.map((u) =>
      supabase.from("services").update({ category: u.category, sort_order: u.sort_order }).eq("id", u.id)
    ));
  }

  function findContainerOfService(id: string): string | null {
    for (const [cat, list] of groups.entries()) {
      if (list.some((s) => s.id === id)) return cat;
    }
    return null;
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = e;
    if (!over) return;
    const aId = String(active.id);
    const oId = String(over.id);

    // Category reorder
    if (aId.startsWith("cat:") && oId.startsWith("cat:")) {
      const from = allCats.indexOf(aId.slice(4));
      const to = allCats.indexOf(oId.slice(4));
      if (from < 0 || to < 0 || from === to) return;
      const next = arrayMove(allCats, from, to);
      await persistCategoryOrder(next);
      return;
    }

    // Service move
    if (aId.startsWith("svc:")) {
      const sid = aId.slice(4);
      const fromCat = findContainerOfService(sid);
      if (!fromCat) return;
      let toCat: string;
      let toIndex: number;
      if (oId.startsWith("svc:")) {
        const overSid = oId.slice(4);
        toCat = findContainerOfService(overSid) ?? UNCATEGORIZED;
        toIndex = groups.get(toCat)!.findIndex((s) => s.id === overSid);
      } else if (oId.startsWith("drop:")) {
        toCat = oId.slice(5);
        toIndex = groups.get(toCat)?.length ?? 0;
      } else {
        return;
      }
      const newCategoryValue = toCat === UNCATEGORIZED ? null : toCat;
      const movingService = services.find((s) => s.id === sid);
      if (!movingService) return;

      // Build new ordering
      const fromList = groups.get(fromCat)!.filter((s) => s.id !== sid);
      const toList = toCat === fromCat ? fromList.slice() : (groups.get(toCat) ?? []).slice();
      toList.splice(Math.max(0, Math.min(toIndex, toList.length)), 0, { ...movingService, category: newCategoryValue });

      const updates: { id: string; category: string | null; sort_order: number }[] = [];
      toList.forEach((s, i) => updates.push({ id: s.id, category: newCategoryValue, sort_order: i }));
      if (toCat !== fromCat) {
        fromList.forEach((s, i) => updates.push({ id: s.id, category: s.category ?? null, sort_order: i }));
      }
      // Optimistic local update
      setServices((prev) => prev.map((s) => {
        const u = updates.find((x) => x.id === s.id);
        return u ? { ...s, category: u.category, sort_order: u.sort_order } : s;
      }));
      await persistServiceOrder(updates);
      load();
    }
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const activeService = activeDrag?.kind === "service" ? services.find((s) => s.id === activeDrag.id) : null;

  const renderServiceRow = (s: any, dragHandle = true) => (
    <ServiceRow key={s.id} s={s} onEdit={() => setEditing(s)} onDelete={async () => {
      if (confirm(`Удалить ${s.name}?`)) { await supabase.from("services").delete().eq("id", s.id); load(); }
    }} dragHandle={dragHandle} />
  );

  return (
    <Card className="p-4 sm:p-6 space-y-6">
      {/* Categories management */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Категории</h2>
          <span className="text-xs text-muted-foreground">{allCats.length} категорий</span>
        </div>
        <div className="flex gap-2">
          <Input
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="Например: Маникюр"
            onKeyDown={(e) => { if (e.key === "Enter") addCategory(); }}
          />
          <Button onClick={addCategory} variant="outline"><FolderPlus className="h-4 w-4 mr-1" />Создать</Button>
        </div>
        {allCats.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {allCats.map((c) => (
                <div key={c} className="flex items-center gap-1 px-2 py-1 border rounded-md text-sm bg-muted/30">
                  {renamingCat === c ? (
                    <>
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") renameCategory(c); if (e.key === "Escape") setRenamingCat(null); }}
                        className="h-6 w-32 text-sm"
                      />
                      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => renameCategory(c)}>OK</Button>
                    </>
                  ) : (
                    <>
                      <span>{c}</span>
                      <span className="text-xs text-muted-foreground">({services.filter((s) => (s.category ?? "") === c).length})</span>
                      <button className="text-muted-foreground hover:text-foreground" onClick={() => { setRenamingCat(c); setRenameValue(c); }}><Edit className="h-3 w-3" /></button>
                      <button className="text-muted-foreground hover:text-destructive" onClick={() => deleteCategory(c)}><Trash2 className="h-3 w-3" /></button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="border rounded-md p-3 bg-muted/20 space-y-2">
              <p className="text-xs font-medium">Раскрытие категорий на форме записи</p>
              {allCats.map((c) => {
                const expanded = !collapsedCats.includes(c);
                return (
                  <label key={c} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{c}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {expanded ? "развёрнута" : "свёрнута"}
                      <Switch checked={expanded} onCheckedChange={() => toggleCollapsed(c)} />
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {/* Services with DnD */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex justify-between">
          <h2 className="font-semibold">Услуги</h2>
          <Button size="sm" onClick={() => setEditing({ salon_id: salonId, name: "", category: "", duration_min: 60, buffer_after_min: 0, price: 0, price_max: null, price_type: "fixed", color: "#0ea5e9", is_active: true })}>
            <Plus className="h-4 w-4 mr-1" />Добавить
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Перетаскивайте услуги между категориями и категории между собой. Изменения сохраняются автоматически.</p>

        {services.length === 0 && allCats.length === 0 && <p className="text-muted-foreground text-sm">Пока нет ни категорий, ни услуг</p>}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e: DragStartEvent) => {
            const id = String(e.active.id);
            if (id.startsWith("svc:")) setActiveDrag({ kind: "service", id: id.slice(4) });
            else if (id.startsWith("cat:")) setActiveDrag({ kind: "category", id: id.slice(4) });
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <SortableContext items={allCats.map((c) => `cat:${c}`)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {allCats.map((cat) => {
                const list = groups.get(cat) ?? [];
                const open = openCats.has(cat);
                return (
                  <SortableCategory key={cat} cat={cat} count={list.length} open={open} onToggle={() => toggleCat(cat)}>
                    {open && (
                      <DroppableArea id={`drop:${cat}`}>
                        <SortableContext items={list.map((s) => `svc:${s.id}`)} strategy={verticalListSortingStrategy}>
                          <div className="p-2 space-y-2 border-t min-h-[40px]">
                            {list.length === 0 && <p className="text-xs text-muted-foreground px-2 py-1">Пусто. Перетащите сюда услугу.</p>}
                            {list.map((s) => renderServiceRow(s))}
                          </div>
                        </SortableContext>
                      </DroppableArea>
                    )}
                  </SortableCategory>
                );
              })}
            </div>
          </SortableContext>

          <div className="pt-2">
            <div className="text-xs text-muted-foreground mb-1 px-1">Без категории</div>
            <DroppableArea id={`drop:${UNCATEGORIZED}`}>
              <SortableContext items={(groups.get(UNCATEGORIZED) ?? []).map((s) => `svc:${s.id}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2 min-h-[40px] border border-dashed rounded-lg p-2">
                  {(groups.get(UNCATEGORIZED) ?? []).length === 0 && <p className="text-xs text-muted-foreground px-2 py-1">Перетащите сюда, чтобы убрать из категории</p>}
                  {(groups.get(UNCATEGORIZED) ?? []).map((s) => renderServiceRow(s))}
                </div>
              </SortableContext>
            </DroppableArea>
          </div>

          <DragOverlay>
            {activeService ? (
              <div className="flex items-center justify-between p-3 border rounded-lg bg-card shadow-lg">
                <div className="flex items-center gap-3">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                  <div className="h-3 w-3 rounded-full" style={{ background: activeService.color || "#0ea5e9" }} />
                  <p className="font-medium">{activeService.name}</p>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {editing && (
        <ServiceDialog
          editing={editing}
          setEditing={setEditing}
          salonId={salonId}
          categories={allCats}
          onSaved={(newCat) => {
            if (newCat && !allCats.includes(newCat)) {
              setExtraCats((x) => [...x, newCat]);
              persistCategoryOrder([...allCats, newCat]);
            }
            setEditing(null);
            load();
          }}
        />
      )}
    </Card>
  );
}

function SortableCategory({ cat, count, open, onToggle, children }: { cat: string; count: number; open: boolean; onToggle: () => void; children?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `cat:${cat}` });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="border rounded-lg overflow-hidden bg-card">
      <div className="w-full px-2 py-2 flex items-center gap-1 bg-muted/20">
        <button {...attributes} {...listeners} className="p-1 cursor-grab active:cursor-grabbing touch-none" aria-label="Перетащить категорию">
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </button>
        <button onClick={onToggle} className="flex-1 flex items-center justify-between hover:bg-muted/40 transition rounded px-2 py-1">
          <span className="font-medium text-sm flex items-center gap-2">
            {cat} <span className="text-xs text-muted-foreground">({count})</span>
          </span>
          <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {children}
    </div>
  );
}

function DroppableArea({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} className={isOver ? "bg-primary/5" : ""}>{children}</div>;
}

function ServiceRow({ s, onEdit, onDelete, dragHandle }: { s: any; onEdit: () => void; onDelete: () => void; dragHandle: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `svc:${s.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="flex items-center justify-between p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-3 min-w-0">
        {dragHandle && (
          <button {...attributes} {...listeners} className="p-1 -ml-1 cursor-grab active:cursor-grabbing touch-none" aria-label="Перетащить услугу">
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
        <div className="h-3 w-3 rounded-full shrink-0" style={{ background: s.color || "#0ea5e9" }} />
        <div className="min-w-0">
          <p className="font-medium truncate">{s.name}</p>
          <p className="text-xs text-muted-foreground">{s.duration_min} мин · {formatPrice(s)}</p>
        </div>
      </div>
      <div className="flex gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onEdit}><Edit className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>
    </div>
  );
}


function ServiceDialog({ editing, setEditing, salonId, categories, onSaved }: {
  editing: any; setEditing: (v: any) => void; salonId: string; categories: string[]; onSaved: (newCat?: string) => void;
}) {
  const initialCat = editing.category ?? "";
  const [catMode, setCatMode] = useState<"existing" | "new" | "none">(
    initialCat ? "existing" : "none"
  );
  const [newCat, setNewCat] = useState("");
  const [allMasters, setAllMasters] = useState<any[]>([]);
  const [linkedMasters, setLinkedMasters] = useState<Set<string>>(new Set());
  const selectValue = catMode === "none" ? NO_CATEGORY : catMode === "new" ? NEW_CATEGORY : (editing.category || NO_CATEGORY);

  useEffect(() => {
    supabase.from("masters").select("id, name, specialization").eq("salon_id", salonId).eq("is_active", true).order("sort_order")
      .then(({ data }) => setAllMasters(data ?? []));
    if (editing.id) {
      supabase.from("master_services").select("master_id").eq("service_id", editing.id)
        .then(({ data }) => setLinkedMasters(new Set((data ?? []).map((r: any) => r.master_id))));
    }
  }, [editing.id, salonId]);

  async function save() {
    if (!editing.name?.trim()) return toast.error("Введите название");
    let category: string | null = null;
    if (catMode === "existing" && editing.category) category = editing.category;
    else if (catMode === "new" && newCat.trim()) category = newCat.trim();
    const priceType = editing.price_type === "range" ? "range" : "fixed";
    const priceMax = priceType === "range" && editing.price_max != null && Number(editing.price_max) > Number(editing.price)
      ? Number(editing.price_max) : null;
    const payload = {
      name: editing.name, category, description: editing.description,
      duration_min: editing.duration_min, buffer_after_min: editing.buffer_after_min ?? 0,
      price: editing.price, price_max: priceMax, price_type: priceType, color: editing.color,
    };
    let serviceId = editing.id;
    if (serviceId) {
      const { error } = await supabase.from("services").update(payload).eq("id", serviceId);
      if (error) return toast.error(error.message);
    } else {
      const { data, error } = await supabase.from("services").insert({ salon_id: salonId, ...payload }).select("id").single();
      if (error) return toast.error(error.message);
      serviceId = data.id;
    }
    // bidirectional master_services sync (single source of truth)
    await supabase.from("master_services").delete().eq("service_id", serviceId);
    if (linkedMasters.size > 0) {
      const rows = Array.from(linkedMasters).map((mid) => ({ master_id: mid, service_id: serviceId }));
      const { error } = await supabase.from("master_services").insert(rows);
      if (error) return toast.error(error.message);
    }
    toast.success("Сохранено");
    onSaved(category ?? undefined);
  }

  return (
    <Dialog open onOpenChange={() => setEditing(null)}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing.id ? "Редактировать услугу" : "Новая услуга"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Название</Label><Input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
          <div>
            <Label>Категория</Label>
            <Select
              value={selectValue}
              onValueChange={(v) => {
                if (v === NO_CATEGORY) { setCatMode("none"); setEditing({ ...editing, category: "" }); }
                else if (v === NEW_CATEGORY) { setCatMode("new"); setEditing({ ...editing, category: "" }); }
                else { setCatMode("existing"); setEditing({ ...editing, category: v }); }
              }}
            >
              <SelectTrigger><SelectValue placeholder="Выберите категорию" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>— Без категории —</SelectItem>
                {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                <SelectItem value={NEW_CATEGORY}>+ Создать новую категорию</SelectItem>
              </SelectContent>
            </Select>
            {catMode === "new" && (
              <Input className="mt-2" autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Название новой категории" />
            )}
          </div>
          <div><Label>Описание</Label><Textarea value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Длительность (мин)</Label><Input type="number" value={editing.duration_min} onChange={(e) => setEditing({ ...editing, duration_min: Number(e.target.value) })} /></div>
            <div>
              <Label>Запас после (мин)</Label>
              <Input type="number" min={0} value={editing.buffer_after_min ?? 0} onChange={(e) => setEditing({ ...editing, buffer_after_min: Math.max(0, Number(e.target.value)) })} />
              <p className="text-xs text-muted-foreground mt-1">Только для CRM: клиент видит чистую длительность</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Цена</Label>
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="price_type" checked={(editing.price_type ?? "fixed") !== "range"} onChange={() => setEditing({ ...editing, price_type: "fixed", price_max: null })} />
                Фиксированная
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="price_type" checked={editing.price_type === "range"} onChange={() => setEditing({ ...editing, price_type: "range" })} />
                Диапазон
              </label>
            </div>
            {editing.price_type === "range" ? (
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs">От</Label><Input type="number" value={editing.price ?? 0} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })} /></div>
                <div><Label className="text-xs">До (необязательно)</Label><Input type="number" value={editing.price_max ?? ""} onChange={(e) => setEditing({ ...editing, price_max: e.target.value === "" ? null : Number(e.target.value) })} placeholder="—" /></div>
              </div>
            ) : (
              <Input type="number" value={editing.price ?? 0} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })} />
            )}
            <p className="text-xs text-muted-foreground">{editing.price_type === "range" ? "Если оставить «До» пустым — будет отображаться «от X сом»." : "Цена в сомах."}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Цвет</Label><Input type="color" value={editing.color ?? "#0ea5e9"} onChange={(e) => setEditing({ ...editing, color: e.target.value })} /></div>
          </div>


          <div>
            <Label>Мастера, оказывающие услугу</Label>
            {allMasters.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">Сначала добавьте мастеров во вкладке «Мастера»</p>
            ) : (
              <div className="mt-2 border rounded-md p-2 max-h-44 overflow-y-auto space-y-1">
                {allMasters.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm py-1 px-1 rounded hover:bg-muted/40 cursor-pointer">
                    <Checkbox
                      checked={linkedMasters.has(m.id)}
                      onCheckedChange={(v) => {
                        const n = new Set(linkedMasters);
                        if (v) n.add(m.id); else n.delete(m.id);
                        setLinkedMasters(n);
                      }}
                    />
                    <span className="font-medium">{m.name}</span>
                    {m.specialization && <span className="text-muted-foreground text-xs">— {m.specialization}</span>}
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Изменения автоматически отразятся в профилях мастеров.</p>
          </div>

          <Button className="w-full" onClick={save}>Сохранить</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationsTab({ salon, onSaved }: { salon: any; onSaved: (s: any) => void }) {
  const { isSuperAdmin } = useAuth();
  const [instance, setInstance] = useState("");
  const [token, setToken] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [waEnabled, setWaEnabled] = useState<boolean>(!!salon.whatsapp_enabled);
  const [waBusy, setWaBusy] = useState(false);

  useEffect(() => { setWaEnabled(!!salon.whatsapp_enabled); }, [salon.whatsapp_enabled]);

  const loadSecrets = useServerFn(getSalonSecrets);
  const saveSecrets = useServerFn(upsertSalonSecrets);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadSecrets({ data: { salonId: salon.id } });
        if (cancelled) return;
        setInstance(data?.greenapi_instance ?? "");
        setToken(data?.greenapi_token ?? "");
        setOwnerPhone(data?.owner_notify_phone ?? "");
      } catch (e: any) {
        if (!cancelled) toast.error(e.message ?? "Не удалось загрузить настройки");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [salon.id]);

  async function toggleWa(v: boolean) {
    if (!isSuperAdmin) return;
    setWaBusy(true);
    const prev = waEnabled;
    setWaEnabled(v);
    const { data, error } = await supabase
      .from("salons")
      .update({ whatsapp_enabled: v })
      .eq("id", salon.id)
      .select()
      .single();
    setWaBusy(false);
    if (error) { setWaEnabled(prev); return toast.error(error.message); }
    toast.success(v ? "WhatsApp-уведомления включены" : "WhatsApp-уведомления выключены");
    if (data) onSaved(data);
  }

  async function save() {
    setSaving(true);
    try {
      await saveSecrets({ data: {
        salonId: salon.id,
        greenapi_instance: instance || null,
        greenapi_token: token || null,
        owner_notify_phone: ownerPhone.replace(/[^\d]/g, "") || null,
      }});
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(e.message ?? "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold">WhatsApp-уведомления</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Если выключено — клиенты не увидят упоминаний WhatsApp при бронировании, подтверждения и напоминания не отправляются.
            </p>
            {!isSuperAdmin && (
              <p className="text-xs text-amber-700 mt-2">
                Доступно только владельцу платформы. Свяжитесь с поддержкой, чтобы включить.
              </p>
            )}
          </div>
          <Switch
            checked={waEnabled}
            onCheckedChange={toggleWa}
            disabled={!isSuperAdmin || waBusy}
          />
        </div>
      </Card>

      <Card className={`p-6 space-y-4 ${!waEnabled ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-semibold">GreenAPI (WhatsApp)</h2>
            <p className="text-sm text-muted-foreground">Каждый салон использует свой инстанс GreenAPI. Подтверждения и напоминания клиентам, а также уведомления владельцу будут отправляться с этого номера.</p>
          </div>
          {!waEnabled && (
            <span className="text-[11px] uppercase tracking-wide px-2 py-1 rounded bg-muted text-muted-foreground shrink-0">
              Интеграция выключена
            </span>
          )}
        </div>
        <div><Label>Instance ID</Label><Input value={instance} onChange={(e) => setInstance(e.target.value)} placeholder="1101000001" disabled={loading} /></div>
        <div><Label>API Token</Label><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} disabled={loading} /></div>
        <div>
          <Label>Телефон владельца для уведомлений</Label>
          <Input value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="79991234567" disabled={loading} />
          <p className="text-xs text-muted-foreground mt-1">При каждой новой записи владельцу салона придёт WhatsApp на этот номер. Формат: только цифры с кодом страны.</p>
        </div>
        <Button onClick={save} disabled={saving || loading}>{saving ? "..." : "Сохранить"}</Button>
      </Card>
    </div>
  );
}

function AccessTab({ salonId }: { salonId: string }) {
  const [admins, setAdmins] = useState<any[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [newCreds, setNewCreds] = useState<{ email: string; password: string } | null>(null);

  const list = useServerFn(listSalonAdmins);
  const create = useServerFn(createSalonAdmin);
  const revoke = useServerFn(revokeSalonAdmin);

  async function load() {
    try {
      const data = await list({ data: { salonId } });
      setAdmins(data);
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  useEffect(() => { load(); }, [salonId]);

  async function onCreate() {
    if (!email.trim()) return toast.error("Введите email");
    setBusy(true);
    try {
      const res = await create({ data: { salonId, email: email.trim() } });
      if (res.alreadyExisted) {
        toast.success("Пользователь уже существовал — доступ выдан");
      } else if (res.password) {
        setNewCreds({ email: res.email, password: res.password });
      }
      setEmail("");
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(roleId: string) {
    if (!confirm("Отозвать доступ?")) return;
    try {
      await revoke({ data: { roleId } });
      toast.success("Доступ отозван");
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <Card className="p-6 space-y-4 max-w-2xl">
      <div>
        <h2 className="font-semibold">Доступ владельца салона</h2>
        <p className="text-sm text-muted-foreground">Создай аккаунт для владельца — он сможет логиниться и видеть только свой салон: календарь, записи, мастеров, услуги и статистику.</p>
      </div>
      <div className="flex gap-2">
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@salon.com" type="email" />
        <Button onClick={onCreate} disabled={busy}><UserPlus className="h-4 w-4 mr-1" />{busy ? "..." : "Создать"}</Button>
      </div>

      <div className="space-y-2 pt-2">
        {admins.length === 0 && <p className="text-sm text-muted-foreground">Пока никто не имеет доступа</p>}
        {admins.map((a) => (
          <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
            <div>
              <p className="text-sm font-medium">{a.email}</p>
              <p className="text-xs text-muted-foreground">Доступ с {new Date(a.createdAt).toLocaleDateString("ru-RU")}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onRevoke(a.id)}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        ))}
      </div>

      <Dialog open={!!newCreds} onOpenChange={(o) => !o && setNewCreds(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Аккаунт создан</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Передай эти данные владельцу салона. Пароль показывается один раз!</p>
            <div className="space-y-2">
              <div>
                <Label>Email</Label>
                <div className="flex gap-2">
                  <Input value={newCreds?.email ?? ""} readOnly />
                  <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newCreds?.email ?? ""); toast.success("Скопировано"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label>Временный пароль</Label>
                <div className="flex gap-2">
                  <Input value={newCreds?.password ?? ""} readOnly className="font-mono" />
                  <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newCreds?.password ?? ""); toast.success("Скопировано"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Владелец заходит на страницу /auth и логинится. Рекомендуем сменить пароль после первого входа.</p>
            <Button className="w-full" onClick={() => setNewCreds(null)}>Готово</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AddonsTab({ salonId }: { salonId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("0");
  const [price, setPrice] = useState("0");

  const load = () => {
    supabase.from("service_addons").select("*").eq("salon_id", salonId).order("created_at", { ascending: true })
      .then(({ data }) => setItems(data ?? []));
  };
  useEffect(() => { load(); }, [salonId]);

  const add = async () => {
    if (!name.trim()) return toast.error("Введите название");
    const { error } = await supabase.from("service_addons").insert({
      salon_id: salonId,
      name: name.trim(),
      duration_min: parseInt(duration) || 0,
      price: parseFloat(price) || 0,
    });
    if (error) return toast.error(error.message);
    setName(""); setDuration("0"); setPrice("0"); load();
  };

  const update = async (id: string, patch: any) => {
    const { error } = await supabase.from("service_addons").update(patch).eq("id", id);
    if (error) return toast.error(error.message);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Удалить?")) return;
    const { error } = await supabase.from("service_addons").delete().eq("id", id);
    if (error) return toast.error(error.message);
    load();
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="font-medium mb-3">Новая доп. услуга</div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="sm:col-span-2"><Label className="text-xs">Название</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Напр. Лечебная маска" /></div>
          <div><Label className="text-xs">Длительность (мин)</Label><Input type="number" min="0" value={duration} onChange={(e) => setDuration(e.target.value)} /></div>
          <div><Label className="text-xs">Цена</Label><Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        </div>
        <Button className="mt-3" onClick={add}><Plus className="h-4 w-4 mr-1" />Добавить</Button>
        <p className="text-[11px] text-muted-foreground mt-2">Длительность указывается справочно — доп. услуга выполняется параллельно с основной и не удлиняет запись.</p>
      </Card>


      <Card className="p-4">
        <div className="font-medium mb-3">Список ({items.length})</div>
        {items.length === 0 && <p className="text-sm text-muted-foreground">Пока нет доп. услуг</p>}
        <div className="space-y-2">
          {items.map((a) => (
            <div key={a.id} className="grid grid-cols-1 sm:grid-cols-[1fr_120px_120px_auto_auto] gap-2 items-center border rounded-md p-2">
              <Input value={a.name} onChange={(e) => setItems((p) => p.map((x) => x.id === a.id ? { ...x, name: e.target.value } : x))} onBlur={(e) => update(a.id, { name: e.target.value })} />
              <Input type="number" min="0" value={a.duration_min} onChange={(e) => setItems((p) => p.map((x) => x.id === a.id ? { ...x, duration_min: parseInt(e.target.value) || 0 } : x))} onBlur={(e) => update(a.id, { duration_min: parseInt(e.target.value) || 0 })} />
              <Input type="number" min="0" step="0.01" value={a.price} onChange={(e) => setItems((p) => p.map((x) => x.id === a.id ? { ...x, price: parseFloat(e.target.value) || 0 } : x))} onBlur={(e) => update(a.id, { price: parseFloat(e.target.value) || 0 })} />
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox checked={a.is_active} onCheckedChange={(v) => update(a.id, { is_active: v === true })} />
                Активна
              </label>
              <Button variant="ghost" size="icon" onClick={() => remove(a.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function FaqTab({ salonId }: { salonId: string }) {
  const [items, setItems] = useState<{ id: string; question: string; answer: string; sort_order: number }[]>([]);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("salon_faqs").select("id, question, answer, sort_order").eq("salon_id", salonId).order("sort_order");
    setItems((data ?? []) as any);
  }
  useEffect(() => { load(); }, [salonId]);

  async function add() {
    if (!q.trim() || !a.trim()) return toast.error("Заполните вопрос и ответ");
    const max = items.reduce((m, i) => Math.max(m, i.sort_order), -1);
    const { error } = await supabase.from("salon_faqs").insert({ salon_id: salonId, question: q.trim(), answer: a.trim(), sort_order: max + 1 } as any);
    if (error) return toast.error(error.message);
    setQ(""); setA("");
    load();
    toast.success("Добавлено");
  }

  async function update(id: string, patch: Partial<{ question: string; answer: string }>) {
    setSavingId(id);
    const { error } = await supabase.from("salon_faqs").update(patch as any).eq("id", id);
    setSavingId(null);
    if (error) toast.error(error.message);
  }

  async function remove(id: string) {
    const { error } = await supabase.from("salon_faqs").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setItems(items.filter((i) => i.id !== id));
  }

  async function move(id: string, dir: -1 | 1) {
    const idx = items.findIndex((i) => i.id === id);
    const nb = idx + dir;
    if (idx < 0 || nb < 0 || nb >= items.length) return;
    const a = items[idx], b = items[nb];
    const next = [...items];
    next[idx] = { ...a, sort_order: b.sort_order };
    next[nb] = { ...b, sort_order: a.sort_order };
    next.sort((x, y) => x.sort_order - y.sort_order);
    setItems(next);
    await Promise.all([
      supabase.from("salon_faqs").update({ sort_order: b.sort_order } as any).eq("id", a.id),
      supabase.from("salon_faqs").update({ sort_order: a.sort_order } as any).eq("id", b.id),
    ]);
  }

  return (
    <Card className="p-4 sm:p-6 space-y-4 max-w-2xl">
      <div>
        <h2 className="font-semibold">Часто задаваемые вопросы</h2>
        <p className="text-xs text-muted-foreground">Видны клиентам на странице записи перед бронированием.</p>
      </div>
      <div className="space-y-2 border rounded-md p-3 bg-muted/20">
        <Label>Новый вопрос</Label>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Например: Можно ли отменить запись?" />
        <Label>Ответ</Label>
        <Textarea value={a} onChange={(e) => setA(e.target.value)} placeholder="Краткий понятный ответ" />
        <Button size="sm" onClick={add}><Plus className="h-4 w-4 mr-1" />Добавить</Button>
      </div>
      <div className="space-y-3">
        {items.length === 0 && <p className="text-sm text-muted-foreground">Пока нет вопросов</p>}
        {items.map((it, i) => (
          <div key={it.id} className="border rounded-md p-3 space-y-2">
            <div className="flex items-center gap-1">
              <Input
                defaultValue={it.question}
                onBlur={(e) => e.target.value.trim() && e.target.value !== it.question && update(it.id, { question: e.target.value.trim() })}
                className="font-medium"
              />
              <Button size="icon" variant="ghost" disabled={i === 0} onClick={() => move(it.id, -1)} title="Вверх">↑</Button>
              <Button size="icon" variant="ghost" disabled={i === items.length - 1} onClick={() => move(it.id, 1)} title="Вниз">↓</Button>
              <Button size="icon" variant="ghost" onClick={() => remove(it.id)} title="Удалить"><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
            <Textarea
              defaultValue={it.answer}
              onBlur={(e) => e.target.value.trim() && e.target.value !== it.answer && update(it.id, { answer: e.target.value.trim() })}
              rows={3}
            />
            {savingId === it.id && <p className="text-xs text-muted-foreground">Сохраняем…</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}



