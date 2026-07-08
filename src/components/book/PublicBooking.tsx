import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Check,
  Clock,
  ChevronRight,
  ArrowLeft,
  ChevronDown,
  Folder,
  Sparkles,
  MapPin,
} from "lucide-react";
import { toast } from "sonner";
import { formatPrice } from "@/lib/price";
import { normalizeWhatsApp } from "@/lib/social";
import { checkPhoneWhatsapp } from "@/lib/wa-check.functions";

type Salon = {
  id: string;
  name: string;
  description?: string | null;
  address?: string | null;
  phone?: string | null;
  brand_primary?: string | null;
  brand_accent?: string | null;
  logo_url?: string | null;
  timezone?: string | null;
  whatsapp_enabled?: boolean | null;
  collapsed_categories?: string[] | null;
};

type Service = {
  id: string;
  name: string;
  duration_min: number;
  price: number;
  price_max?: number | null;
  price_type?: string | null;
  description: string | null;
  category: string | null;
  color: string | null;
};
type Master = {
  id: string;
  name: string;
  specialization: string | null;
  photo_url: string | null;
  branch_id?: string | null;
};
type Branch = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  instagram_url?: string | null;
  whatsapp_url?: string | null;
  telegram_url?: string | null;
  tiktok_url?: string | null;
};
type Faq = { id: string; question: string; answer: string };

export function PublicBooking({
  salon,
  branches = [],
  preselectedServiceId,
  theme = "light",
  onClose,
}: {
  salon: Salon;
  branches?: Branch[];
  preselectedServiceId?: string | null;
  theme?: "light" | "dark" | "vivid";
  onClose?: () => void;
}) {
  const multiBranch = branches.length > 1;
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(
    multiBranch ? null : (branches[0] ?? null),
  );
  const [step, setStep] = useState(multiBranch ? 0 : 1);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Сброс позиции скролла только при ПЕРЕХОДЕ между шагами (не при ре-рендерах
  // внутри шага, чтобы клик по категории не выбрасывал вверх).
  const prevStepRef = useRef<number>(step);
  useEffect(() => {
    if (prevStepRef.current === step) return;
    prevStepRef.current = step;
    const scrollAll = () => {
      try {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {}
      try {
        document.documentElement.scrollTo({ top: 0, behavior: "smooth" });
      } catch {}
      try {
        document.body.scrollTo({ top: 0, behavior: "smooth" });
      } catch {}
      // Walk up from root and scroll any scrollable ancestor.
      let el: HTMLElement | null = rootRef.current;
      while (el) {
        if (el.scrollTop > 0) {
          try {
            el.scrollTo({ top: 0, behavior: "smooth" });
          } catch {
            el.scrollTop = 0;
          }
        }
        el = el.parentElement;
      }
      try {
        rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      } catch {}
    };
    // Run after render so the new step's DOM is in place.
    requestAnimationFrame(scrollAll);
  }, [step]);

  const goHome = () => {
    if (onClose) {
      onClose();
      return;
    }
    setStep(multiBranch ? 0 : 1);
    setSelectedService(null);
    setSelectedMaster(null);
    setSelectedSlot(null);
    if (multiBranch) setSelectedBranch(null);
  };
  const [services, setServices] = useState<Service[]>([]);
  const [masters, setMasters] = useState<Master[]>([]);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [selectedMaster, setSelectedMaster] = useState<Master | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  // Set when the WhatsApp registration check rejected the entered number.
  const [phoneWaError, setPhoneWaError] = useState(false);
  const [clientNotes, setClientNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [addons, setAddons] = useState<
    { id: string; name: string; duration_min: number; price: number }[]
  >([]);
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);

  useEffect(() => {
    if (!selectedService) {
      setAddons([]);
      setSelectedAddonIds([]);
      return;
    }
    supabase
      .rpc("get_addons_for_service", { _service_id: selectedService.id })
      .then(({ data }) => setAddons((data ?? []) as any));
    setSelectedAddonIds([]);
  }, [selectedService?.id]);

  const addonsTotal = useMemo(() => {
    const sel = addons.filter((a) => selectedAddonIds.includes(a.id));
    return {
      price: sel.reduce((s, a) => s + Number(a.price || 0), 0),
    };
  }, [addons, selectedAddonIds]);

  useEffect(() => {
    // If a branch is selected, only show services that have at least one active master at that branch.
    (async () => {
      const { data: allServices } = await supabase
        .from("services")
        .select("*")
        .eq("salon_id", salon.id)
        .eq("is_active", true)
        .order("sort_order");
      let list = (allServices ?? []) as Service[];
      if (selectedBranch) {
        const { data: links } = await supabase
          .from("masters")
          .select("master_services(service_id)")
          .eq("salon_id", salon.id)
          .eq("is_active", true)
          .eq("branch_id", selectedBranch.id);
        const allowed = new Set<string>();
        for (const m of (links ?? []) as any[]) {
          for (const ms of m.master_services ?? []) allowed.add(ms.service_id);
        }
        list = list.filter((s) => allowed.has(s.id));
      }
      setServices(list);
      if (preselectedServiceId) {
        const found = list.find((s) => s.id === preselectedServiceId);
        if (found && (!multiBranch || selectedBranch)) {
          setSelectedService(found);
          setStep(2);
        }
      }
    })();
  }, [salon.id, preselectedServiceId, multiBranch, selectedBranch]);

  useEffect(() => {
    if (!selectedService) return;
    (async () => {
      let q = supabase
        .from("masters")
        .select("id, name, specialization, photo_url, branch_id, master_services!inner(service_id)")
        .eq("salon_id", salon.id)
        .eq("is_active", true)
        .eq("master_services.service_id", selectedService.id)
        .order("sort_order");
      if (selectedBranch) q = q.eq("branch_id", selectedBranch.id);
      const { data } = await q;
      const list = (data ?? []) as Master[];
      if (list.length === 0) {
        setMasters([]);
        return;
      }
      // Hide masters who don't have any working schedule at all — they can't ever be booked.
      const ids = list.map((m) => m.id);
      const todayKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: salon.timezone ?? "UTC",
      }).format(new Date());
      const [{ data: scheds }, { data: ovs }] = await Promise.all([
        supabase.from("master_schedules").select("master_id").in("master_id", ids),
        supabase
          .from("master_day_overrides")
          .select("master_id, intervals, is_off")
          .in("master_id", ids)
          .gte("date", todayKey),
      ]);
      const hasSchedule = new Set<string>((scheds ?? []).map((s: any) => s.master_id));
      for (const o of (ovs ?? []) as any[]) {
        if (!o.is_off && Array.isArray(o.intervals) && o.intervals.length > 0)
          hasSchedule.add(o.master_id);
      }
      setMasters(list.filter((m) => hasSchedule.has(m.id)));
    })();
  }, [selectedService, salon.id, selectedBranch]);

  const primary = salon.brand_primary ?? "#0ea5e9";

  const waOn = !!salon.whatsapp_enabled;

  if (success) {
    const slotTime = selectedSlot
      ? new Date(selectedSlot).toLocaleString("ru-RU", {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: salon.timezone ?? undefined,
        })
      : "";
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ background: `linear-gradient(180deg, ${primary}11, transparent)` }}
      >
        <Card className="p-8 max-w-md text-center">
          <div
            className="mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4"
            style={{ background: primary, color: "white" }}
          >
            <Check className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold">Ваша запись успешно создана!</h1>
          <p className="text-muted-foreground mt-2">
            {waOn ? (
              <>Мы отправили подтверждение в WhatsApp на номер {clientPhone}.</>
            ) : (
              <>
                Ждём вас в <b>{salon.name}</b>
                {slotTime ? (
                  <>
                    {" "}
                    в <b>{slotTime}</b>
                  </>
                ) : null}
                .
              </>
            )}
          </p>
          <Button
            className="mt-6"
            onClick={() => {
              setSuccess(false);
              setStep(multiBranch ? 0 : 1);
              setSelectedService(null);
              setSelectedMaster(null);
              setSelectedSlot(null);
              setClientName("");
              setClientPhone("");
              setClientNotes("");
              setRulesAccepted(false);
              if (multiBranch) setSelectedBranch(null);
            }}
          >
            Записаться ещё раз
          </Button>
        </Card>
      </div>
    );
  }

  const isDark = theme === "dark";
  const isVivid = theme === "vivid";
  const wrapperBg = isDark
    ? { background: `linear-gradient(180deg, ${primary}22, transparent)` }
    : isVivid
      ? { background: `linear-gradient(180deg, ${primary}22, ${salon.brand_accent || primary}11)` }
      : { background: `linear-gradient(180deg, ${primary}11, transparent)` };
  const headerCls = isDark
    ? "border-b border-neutral-800 bg-neutral-950/80 backdrop-blur"
    : "border-b bg-background/80 backdrop-blur";
  const subTextCls = isDark ? "text-neutral-400" : "text-muted-foreground";

  return (
    <div
      ref={rootRef}
      className={`min-h-full overflow-x-hidden w-full ${isDark ? "dark" : ""}`}
      style={wrapperBg}
    >
      <header className={headerCls}>
        <button
          type="button"
          onClick={goHome}
          className="mx-auto w-full max-w-3xl px-3 sm:px-4 py-3 sm:py-4 flex items-center gap-3 text-left hover:opacity-90 transition"
          aria-label="На главную"
        >
          {salon.logo_url && (
            <img
              src={salon.logo_url}
              alt={salon.name}
              className="h-9 w-9 sm:h-10 sm:w-10 rounded-full object-cover shrink-0"
            />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="font-bold text-sm sm:text-lg truncate">{salon.name}</h1>
            {selectedBranch?.address ? (
              <p className={`text-xs truncate ${subTextCls}`}>{selectedBranch.address}</p>
            ) : (
              salon.address && <p className={`text-xs truncate ${subTextCls}`}>{salon.address}</p>
            )}
          </div>
        </button>
        {/* Контакты выбранного филиала (или салона если филиал не выбран) */}
        <BranchContactsBar branch={selectedBranch} salon={salon} primary={primary} />
      </header>

      <div className="mx-auto w-full max-w-3xl px-3 sm:px-4 py-4 sm:py-8">
        <Stepper step={step} primary={primary} multiBranch={multiBranch} />

        {step === 0 && multiBranch && (
          <div className="space-y-3">
            <h2 className="text-xl font-semibold mb-4">Выберите филиал</h2>
            {branches.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  setSelectedBranch(b);
                  setStep(1);
                }}
                className="w-full text-left rounded-xl border bg-card/50 hover:bg-card transition p-4 flex items-start gap-3"
              >
                <div
                  className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${primary}1f`, color: primary }}
                >
                  <MapPin className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{b.name}</div>
                  {b.address && (
                    <div className="text-sm text-muted-foreground mt-0.5">{b.address}</div>
                  )}
                  {b.phone && <div className="text-xs text-muted-foreground mt-0.5">{b.phone}</div>}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {b.instagram_url && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-pink-100 text-pink-900">
                        Instagram
                      </span>
                    )}
                    {b.whatsapp_url && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900">
                        WhatsApp
                      </span>
                    )}
                    {b.telegram_url && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-900">
                        Telegram
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 mt-1" />
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            {multiBranch && (
              <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                <ArrowLeft className="h-4 w-4 mr-1" />К выбору филиала
              </Button>
            )}
            <h2 className="text-xl font-semibold mb-4">Выберите услугу</h2>
            {services.length === 0 && (
              <p className="text-muted-foreground">Услуги пока не добавлены</p>
            )}
            <ServicesList
              services={services}
              primary={primary}
              collapsed={new Set(salon.collapsed_categories ?? [])}
              onPick={(s) => {
                setSelectedService(s);
                setStep(2);
              }}
            />
            <FaqSection salonId={salon.id} primary={primary} />
          </div>
        )}

        {step === 2 && selectedService && (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Назад
            </Button>
            <h2 className="text-xl font-semibold mb-4">Выберите мастера</h2>
            {masters.length === 0 && (
              <p className="text-muted-foreground">
                Нет мастеров для этой услуги
                {selectedBranch ? ` в филиале «${selectedBranch.name}»` : ""}
              </p>
            )}
            {masters.map((m) => (
              <Card
                key={m.id}
                className="p-4 cursor-pointer hover:border-primary transition"
                onClick={() => {
                  setSelectedMaster(m);
                  setStep(3);
                }}
              >
                <div className="flex items-center gap-3">
                  {m.photo_url ? (
                    <img
                      src={m.photo_url}
                      alt={m.name}
                      className="h-12 w-12 rounded-full object-cover"
                    />
                  ) : (
                    <div
                      className="h-12 w-12 rounded-full flex items-center justify-center font-medium"
                      style={{ background: primary, color: "white" }}
                    >
                      {m.name.charAt(0)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{m.name}</h3>
                    {m.specialization && (
                      <p className="text-sm text-muted-foreground truncate">{m.specialization}</p>
                    )}
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </div>
              </Card>
            ))}
          </div>
        )}

        {step === 3 && selectedMaster && selectedService && (
          <SlotPicker
            master={selectedMaster}
            service={selectedService}
            primary={primary}
            tz={salon.timezone ?? undefined}
            onBack={() => setStep(2)}
            onPick={(slot) => {
              setSelectedSlot(slot);
              setStep(4);
            }}
          />
        )}

        {step === 4 && (
          <div className="space-y-4">
            <Button variant="ghost" size="sm" onClick={() => setStep(3)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Назад
            </Button>
            <h2 className="text-xl font-semibold">Ваши контакты</h2>
            <Card className="p-4 bg-muted/50">
              <div className="text-sm space-y-0.5">
                <div>
                  <b>{selectedService?.name}</b> —{" "}
                  {selectedService ? formatPrice(selectedService) : ""}
                </div>
                <div>Мастер: {selectedMaster?.name}</div>
                {selectedBranch && (
                  <div>
                    Филиал: {selectedBranch.name}
                    {selectedBranch.address ? `, ${selectedBranch.address}` : ""}
                  </div>
                )}
                <div>
                  Время:{" "}
                  {selectedSlot &&
                    new Date(selectedSlot).toLocaleString("ru-RU", {
                      dateStyle: "full",
                      timeStyle: "short",
                      timeZone: salon.timezone ?? undefined,
                    })}
                </div>
                {selectedAddonIds.length > 0 && selectedService && (
                  <div className="pt-1 mt-1 border-t border-border/50">
                    <b>Итого:</b> {Number(selectedService.price) + addonsTotal.price} ·{" "}
                    {formatDuration(selectedService.duration_min || 0)}
                  </div>
                )}
              </div>
            </Card>
            {addons.length > 0 && (
              <Card className="p-4">
                <div className="font-medium mb-1">
                  Дополнительно{" "}
                  <span className="text-xs text-muted-foreground font-normal">(по желанию)</span>
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Выполняется одновременно с основной услугой — общее время записи не увеличивается.
                </p>
                <div className="space-y-2">
                  {addons.map((a) => {
                    const checked = selectedAddonIds.includes(a.id);
                    return (
                      <label key={a.id} className="flex items-start gap-2 cursor-pointer">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) =>
                            setSelectedAddonIds((prev) =>
                              v === true ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                            )
                          }
                          className="mt-0.5"
                        />
                        <div className="flex-1 flex items-center justify-between gap-2">
                          <span className="text-sm">{a.name}</span>
                          <span className="text-sm font-medium">+{a.price}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </Card>
            )}

            <div>
              <Label>Имя</Label>
              <Input
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div>
              <Label>{waOn ? "Телефон (WhatsApp)" : "Телефон"}</Label>
              <PhoneInput
                value={clientPhone}
                onChange={(v) => {
                  setClientPhone(v);
                  setPhoneWaError(false);
                }}
                required
              />
              {phoneWaError && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                  Этот номер не зарегистрирован в WhatsApp. Укажите номер, привязанный к WhatsApp —
                  на него придёт подтверждение записи.
                </p>
              )}
            </div>
            <div>
              <Label>Комментарий (необязательно)</Label>
              <Textarea
                value={clientNotes}
                onChange={(e) => setClientNotes(e.target.value)}
                maxLength={500}
              />
            </div>
            <div className="rounded-xl border-2 border-red-500 bg-red-50 dark:bg-red-950/30 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <span className="text-3xl leading-none shrink-0" aria-hidden>
                  ⚠️
                </span>
                <div className="text-red-900 dark:text-red-100">
                  <div className="font-extrabold uppercase tracking-wide text-base">
                    Внимание! Важное правило салона
                  </div>
                  <p className="mt-1 text-sm font-medium leading-snug">
                    Если вы опоздаете более чем на <b>10 минут</b>, ваша запись будет автоматически{" "}
                    <b>АННУЛИРОВАНА</b>, если в салоне будут присутствовать другие клиенты.
                  </p>
                  <p className="mt-1 text-sm font-medium leading-snug">
                    Пожалуйста, уважайте время мастеров и приходите вовремя.
                  </p>
                </div>
              </div>
              <label className="flex items-start gap-3 cursor-pointer rounded-lg bg-white dark:bg-red-950/50 border border-red-300 dark:border-red-800 p-3">
                <Checkbox
                  checked={rulesAccepted}
                  onCheckedChange={(v) => setRulesAccepted(v === true)}
                  className="mt-0.5 h-5 w-5 border-red-600 data-[state=checked]:bg-red-600 data-[state=checked]:text-white"
                />
                <span className="text-sm sm:text-base font-bold text-red-900 dark:text-red-100 leading-snug">
                  Я подтверждаю, что приду вовремя и согласен с правилом отмены при опоздании на 10
                  минут.
                </span>
              </label>
              {waOn && (
                <p className="text-[11px] text-red-900/70 dark:text-red-100/70 leading-snug">
                  Подтверждая запись, вы соглашаетесь на получение уведомлений в WhatsApp по
                  указанному номеру.
                </p>
              )}
            </div>
            <Button
              className="w-full"
              style={{ background: primary }}
              disabled={
                submitting ||
                !rulesAccepted ||
                !clientName.trim() ||
                clientPhone.replace(/\D/g, "").length < 12
              }
              onClick={async () => {
                setSubmitting(true);
                try {
                  // Confirmation goes out via WhatsApp — reject numbers that aren't
                  // registered there. Any check failure ("unavailable", network error)
                  // fails open: the booking must never be blocked by the check itself.
                  if (waOn) {
                    try {
                      const { status } = await checkPhoneWhatsapp({
                        data: { salonId: salon.id, phone: clientPhone },
                      });
                      if (status === "not_registered") {
                        setPhoneWaError(true);
                        toast.error(
                          "Номер не зарегистрирован в WhatsApp. Укажите номер с WhatsApp.",
                        );
                        setSubmitting(false);
                        return;
                      }
                    } catch (checkErr) {
                      console.error("wa check failed", checkErr);
                    }
                  }
                  const { data, error } = await supabase.rpc("create_appointment", {
                    _salon_id: salon.id,
                    _master_id: selectedMaster!.id,
                    _service_id: selectedService!.id,
                    _starts_at: selectedSlot!,
                    _client_name: clientName,
                    _client_phone: clientPhone,
                    _client_notes: clientNotes || undefined,
                    _branch_id: selectedBranch?.id ?? undefined,
                    _addon_ids: selectedAddonIds.length > 0 ? selectedAddonIds : undefined,
                  } as any);
                  if (error) throw error;
                  // WhatsApp confirmation is dispatched server-side via DB trigger.
                  setSuccess(true);
                } catch (err: any) {
                  toast.error(err.message);
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              {submitting ? "Записываем..." : "Подтвердить запись"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stepper({
  step,
  primary,
  multiBranch,
}: {
  step: number;
  primary: string;
  multiBranch: boolean;
}) {
  const steps = multiBranch
    ? ["Филиал", "Услуга", "Мастер", "Время", "Контакты"]
    : ["Услуга", "Мастер", "Время", "Контакты"];
  const offset = multiBranch ? 0 : 1;
  return (
    <div className="flex items-center w-full mb-5 sm:mb-8">
      {steps.map((s, i) => {
        const idx = i + offset;
        const done = idx < step;
        const active = idx <= step;
        const isCurrent = idx === step;
        return (
          <div key={s} className="flex items-center flex-1 min-w-0 last:flex-none">
            <div className="flex flex-col items-center min-w-0">
              <div
                className="w-6 h-6 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-[11px] sm:text-sm font-medium shrink-0"
                style={{
                  background: active ? primary : "#e5e7eb",
                  color: active ? "white" : "#6b7280",
                }}
              >
                {done ? <Check className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> : i + 1}
              </div>
              <span
                className={`text-[10px] sm:text-xs mt-1 truncate max-w-[56px] sm:max-w-[64px] text-center ${
                  isCurrent ? "text-foreground font-medium" : "text-muted-foreground"
                } ${isCurrent ? "" : "hidden sm:block"}`}
              >
                {s}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className="flex-1 h-0.5 mx-1 sm:mx-2"
                style={{ background: done ? primary : "#e5e7eb" }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SlotPicker({
  master,
  service,
  primary,
  tz,
  onBack,
  onPick,
}: {
  master: Master;
  service: Service;
  primary: string;
  tz?: string;
  onBack: () => void;
  onPick: (slotISO: string) => void;
}) {
  const salonTz = tz || "UTC";

  // Build the 14-day strip starting from "today" in the SALON's timezone.
  const dates = useMemo(() => {
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: salonTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [y, m, d] = todayKey.split("-").map(Number);
    const arr: { key: string; label: Date }[] = [];
    for (let i = 0; i < 14; i++) {
      // Anchor at 12:00 UTC so the calendar date never shifts when formatting.
      const dt = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0));
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
      arr.push({ key, label: dt });
    }
    return arr;
  }, [salonTz]);
  const [dayKey, setDayKey] = useState(dates[0].key);
  const [slots, setSlots] = useState<{ slot_start: string; slot_end: string }[]>([]);
  const [loading, setLoading] = useState(false);

  // Compute per-date "is day off" from master_schedules + master_day_overrides.
  const [offDays, setOffDays] = useState<Set<string>>(new Set());
  useEffect(() => {
    (async () => {
      const [{ data: scheds }, { data: ovs }] = await Promise.all([
        supabase.from("master_schedules").select("weekday").eq("master_id", master.id),
        supabase
          .from("master_day_overrides")
          .select("date, is_off, intervals")
          .eq("master_id", master.id)
          .in(
            "date",
            dates.map((d) => d.key),
          ),
      ]);
      const workingWeekdays = new Set<number>((scheds ?? []).map((s: any) => Number(s.weekday)));
      const ovMap = new Map<string, any>();
      for (const o of (ovs ?? []) as any[]) ovMap.set(o.date, o);
      const off = new Set<string>();
      for (const d of dates) {
        const wd = new Date(d.key + "T12:00:00Z").getUTCDay();
        const ov = ovMap.get(d.key);
        if (ov) {
          if (ov.is_off) {
            off.add(d.key);
            continue;
          }
          if (Array.isArray(ov.intervals) && ov.intervals.length > 0) continue; // working override
        }
        if (!workingWeekdays.has(wd)) off.add(d.key);
      }
      setOffDays(off);
      // If the initially selected day is off, jump to the next working day.
      if (off.has(dayKey)) {
        const next = dates.find((d) => !off.has(d.key));
        if (next) setDayKey(next.key);
      }
    })();
  }, [master.id, dates.map((d) => d.key).join("|")]);

  useEffect(() => {
    if (offDays.has(dayKey)) {
      setSlots([]);
      return;
    }
    setLoading(true);
    supabase
      .rpc("get_available_slots", {
        _master_id: master.id,
        _service_id: service.id,
        _date: dayKey,
      })
      .then(({ data }) => {
        setSlots(data ?? []);
        setLoading(false);
      });
  }, [dayKey, master.id, service.id, offDays]);

  // Re-check every 30s so slots that just became "past" disappear without reload.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Hard guarantees on the client (the server already enforces them too):
  // 1) slot belongs to the selected salon-local day; 2) slot is strictly in the future.
  const filteredSlots = slots.filter((s) => {
    const slotDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: salonTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(s.slot_start));
    if (slotDay !== dayKey) return false;
    return new Date(s.slot_start).getTime() > nowMs + 60_000;
  });

  const isCurrentDayOff = offDays.has(dayKey);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Назад
      </Button>
      <h2 className="text-xl font-semibold">Выберите время</h2>

      <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
        {dates.map((d) => {
          const active = d.key === dayKey;
          const isOff = offDays.has(d.key);
          return (
            <button
              key={d.key}
              onClick={() => !isOff && setDayKey(d.key)}
              disabled={isOff}
              title={isOff ? "Выходной у мастера" : undefined}
              className={`flex flex-col items-center px-3 py-2 rounded-lg border min-w-[60px] shrink-0 ${isOff ? "opacity-40 cursor-not-allowed line-through" : ""}`}
              style={{
                background: active && !isOff ? primary : "transparent",
                color: active && !isOff ? "white" : undefined,
                borderColor: active && !isOff ? primary : undefined,
              }}
            >
              <span className="text-xs">
                {d.label.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" })}
              </span>
              <span className="font-bold">{d.label.getUTCDate()}</span>
              <span className="text-xs">
                {d.label.toLocaleDateString("ru-RU", { month: "short", timeZone: "UTC" })}
              </span>
            </button>
          );
        })}
      </div>

      {isCurrentDayOff ? (
        <p className="text-muted-foreground">
          У мастера в этот день выходной — выберите другую дату.
        </p>
      ) : loading ? (
        <p className="text-muted-foreground">Загрузка слотов...</p>
      ) : filteredSlots.length === 0 ? (
        <p className="text-muted-foreground">На этот день свободного времени нет</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {filteredSlots.map((s) => {
            const t = new Date(s.slot_start);
            return (
              <button
                key={s.slot_start}
                onClick={() => onPick(s.slot_start)}
                className="px-3 py-2 rounded-lg border hover:border-primary transition text-sm"
              >
                {t.toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: tz,
                })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ServicesList({
  services,
  primary,
  collapsed,
  onPick,
}: {
  services: Service[];
  primary: string;
  collapsed?: Set<string>;
  onPick: (s: Service) => void;
}) {
  const byCat = new Map<string, Service[]>();
  for (const s of services) {
    const key = (s.category && s.category.trim()) || "";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(s);
  }
  const cats = [...byCat.keys()].filter((k) => k !== "");
  const uncategorized = byCat.get("") ?? [];

  const sections: { id: string; title: string; services: Service[] }[] = [
    ...cats.map((c, i) => ({ id: `c-${i}`, title: c, services: byCat.get(c)! })),
    ...(uncategorized.length > 0
      ? [{ id: "c-other", title: "Прочее", services: uncategorized }]
      : []),
  ];

  const renderCard = (s: Service) => (
    <button
      key={s.id}
      onClick={() => onPick(s)}
      className="w-full text-left rounded-xl border border-border bg-card/50 hover:bg-card transition p-3 sm:p-4 flex items-center justify-between gap-3 sm:gap-4 group"
    >
      <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
        <Sparkles className="h-5 w-5 shrink-0 mt-0.5" style={{ color: primary }} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm sm:text-base">{s.name}</h3>
          {s.description && (
            <p className="text-xs sm:text-sm text-muted-foreground mt-1 line-clamp-2">
              {s.description}
            </p>
          )}
          <div className="flex items-center gap-1 mt-1.5 text-xs sm:text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {formatDuration(s.duration_min)}
          </div>
        </div>
      </div>
      <div
        className="shrink-0 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full font-semibold text-xs sm:text-sm whitespace-nowrap"
        style={{ background: `${primary}26`, color: primary }}
      >
        {formatPrice(s)}
      </div>
    </button>
  );

  if (sections.length <= 1) return <div className="space-y-3">{services.map(renderCard)}</div>;

  return (
    <ServicesFlatList
      sections={sections}
      renderCard={renderCard}
      primary={primary}
      collapsed={collapsed}
    />
  );
}

function FaqSection({ salonId, primary }: { salonId: string; primary: string }) {
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    supabase
      .from("salon_faqs")
      .select("id, question, answer")
      .eq("salon_id", salonId)
      .order("sort_order")
      .then(({ data }) => {
        setFaqs((data ?? []) as Faq[]);
      });
  }, [salonId]);
  if (faqs.length === 0) return null;
  return (
    <section className="mt-10 pt-6 border-t">
      <h3 className="text-lg sm:text-xl font-bold mb-3" style={{ color: primary }}>
        Частые вопросы
      </h3>
      <div className="space-y-2">
        {faqs.map((f) => {
          const isOpen = open === f.id;
          return (
            <div key={f.id} className="rounded-xl border bg-card/50">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : f.id)}
                className="w-full flex items-center justify-between gap-3 text-left p-3 sm:p-4"
              >
                <span className="font-medium text-sm sm:text-base">{f.question}</span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
                />
              </button>
              {isOpen && (
                <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-sm text-muted-foreground whitespace-pre-wrap">
                  {f.answer}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ServicesFlatList({
  sections,
  renderCard,
  primary,
  collapsed,
}: {
  sections: { id: string; title: string; services: Service[] }[];
  renderCard: (s: Service) => any;
  primary: string;
  collapsed?: Set<string>;
}) {
  const [activeId, setActiveId] = useState(sections[0].id);
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of sections) init[s.id] = !(collapsed && collapsed.has(s.title));
    return init;
  });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const isClickScrolling = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      if (isClickScrolling.current) return;
      const refY = (stripRef.current?.getBoundingClientRect().bottom ?? 100) + 40;
      let current = sections[0].id;
      for (const s of sections) {
        const node = sectionRefs.current[s.id];
        if (node && node.getBoundingClientRect().top <= refY) current = s.id;
      }
      setActiveId(current);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true } as any);
  }, [sections.map((s) => s.id).join("|")]);

  // Горизонтальная подсветка активной вкладки — только внутри strip, без вертикального scrollIntoView.
  useEffect(() => {
    const btn = tabRefs.current[activeId];
    const strip = stripRef.current?.querySelector(".no-scrollbar") as HTMLElement | null;
    if (!btn || !strip) return;
    const left = btn.offsetLeft - strip.clientWidth / 2 + btn.clientWidth / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [activeId]);

  const scrollTo = (id: string) => {
    setExpandedMap((m) => (m[id] ? m : { ...m, [id]: true }));
    setActiveId(id);
    isClickScrolling.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const node = sectionRefs.current[id];
        if (!node) {
          isClickScrolling.current = false;
          return;
        }
        let sp: HTMLElement | null = node.parentElement;
        let scroller: HTMLElement | null = null;
        while (sp) {
          const oy = getComputedStyle(sp).overflowY;
          if ((oy === "auto" || oy === "scroll") && sp.scrollHeight > sp.clientHeight) {
            scroller = sp;
            break;
          }
          sp = sp.parentElement;
        }
        const stripH = stripRef.current?.offsetHeight ?? 0;
        const offset = stripH + 8;
        if (scroller) {
          const top =
            node.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop -
            offset;
          scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        } else {
          const top = node.getBoundingClientRect().top + window.scrollY - offset;
          window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
        window.setTimeout(() => {
          isClickScrolling.current = false;
        }, 800);
      });
    });
  };

  return (
    <div ref={wrapRef}>
      <div
        ref={stripRef}
        className="sticky top-0 z-20 -mx-3 sm:-mx-4 px-3 sm:px-4 py-2 mb-4 bg-background/95 backdrop-blur border-b"
      >
        <div className="overflow-x-auto no-scrollbar">
          <div className="flex gap-2 min-w-max">
            {sections.map((s) => {
              const active = s.id === activeId;
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    tabRefs.current[s.id] = el;
                  }}
                  onClick={() => scrollTo(s.id)}
                  className="whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium transition border"
                  style={
                    active
                      ? { background: primary, color: "white", borderColor: primary }
                      : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }
                  }
                >
                  {s.title}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {sections.map((s) => {
          const expanded = expandedMap[s.id];
          return (
            <section
              key={s.id}
              ref={(el: HTMLElement | null) => {
                sectionRefs.current[s.id] = el as unknown as HTMLDivElement | null;
              }}
              className="scroll-mt-24"
            >
              <button
                type="button"
                onClick={() => setExpandedMap((m) => ({ ...m, [s.id]: !m[s.id] }))}
                className="w-full flex items-center justify-between gap-2 mb-3 text-left"
              >
                <h3
                  className="text-lg sm:text-xl font-bold uppercase tracking-wide"
                  style={{ color: primary }}
                >
                  {s.title}{" "}
                  <span className="text-xs font-normal text-muted-foreground normal-case">
                    ({s.services.length})
                  </span>
                </h3>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </button>
              {expanded && <div className="space-y-2">{s.services.map(renderCard)}</div>}
            </section>
          );
        })}
      </div>
      <div aria-hidden className="h-[35vh]" />
    </div>
  );
}

function formatDuration(min: number) {
  if (min >= 60 && min % 60 === 0) return `${min / 60} ч`;
  if (min >= 60) return `${Math.floor(min / 60)} ч ${min % 60} мин`;
  return `${min} мин`;
}

function pluralServices(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "услуга";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "услуги";
  return "услуг";
}

function BranchContactsBar({
  branch,
  salon,
  primary,
}: {
  branch: Branch | null;
  salon: Salon;
  primary: string;
}) {
  const phone = branch?.phone ?? salon.phone ?? null;
  const ig = branch?.instagram_url ?? null;
  const wa = branch?.whatsapp_url ?? null;
  const tg = branch?.telegram_url ?? null;
  const tt = branch?.tiktok_url ?? null;
  if (!phone && !ig && !wa && !tg && !tt) return null;
  return (
    <div className="border-t bg-background/60">
      <div className="mx-auto w-full max-w-3xl px-3 sm:px-4 py-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        {phone && (
          <a
            href={`tel:${phone.replace(/\s/g, "")}`}
            className="px-2 py-0.5 rounded-md bg-muted hover:bg-muted/80"
            style={{ color: primary }}
          >
            {phone}
          </a>
        )}
        {wa && (
          <a
            href={normalizeWhatsApp(wa)}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-900"
          >
            WhatsApp
          </a>
        )}
        {ig && (
          <a
            href={ig}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-0.5 rounded-md bg-pink-100 text-pink-900"
          >
            Instagram
          </a>
        )}
        {tg && (
          <a
            href={tg}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-0.5 rounded-md bg-sky-100 text-sky-900"
          >
            Telegram
          </a>
        )}
        {tt && (
          <a
            href={tt}
            target="_blank"
            rel="noreferrer"
            className="px-2 py-0.5 rounded-md bg-neutral-200 text-neutral-900"
          >
            TikTok
          </a>
        )}
      </div>
    </div>
  );
}
