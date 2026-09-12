// Каналы: одно место, где видно, через что салон разговаривает с клиентами.
//
// ЧТО БЫЛО. WhatsApp и Instagram жили двумя отдельными вкладками верхнего уровня, между которыми
// не было ничего общего — ни одинакового заголовка, ни одинакового способа показать «подключено /
// не подключено», ни одинакового места для кнопки. Получалось два продукта в одном кабинете:
// владелец, настроивший WhatsApp, не догадывался, что Instagram настраивается так же, и наоборот.
//
// ЧТО СТАЛО. Один раздел «Каналы», внутри — по каналу на вкладку, и у каждой одинаковый скелет:
//   1. состояние (подключён / не подключён / сломалось) — всегда первым;
//   2. что с этим делать — одной кнопкой;
//   3. настройки канала — ниже, и только когда он подключён.
//
// ГДЕ ЖИВЁТ ВЫКЛЮЧАТЕЛЬ АССИСТЕНТА. Здесь, а не во вкладке «Ассистент». Правило простое: «Каналы»
// отвечают на вопрос «отвечает ли кто-нибудь клиентам и через что», «Ассистент» — на вопрос «как
// именно он разговаривает». Раньше это было перемешано, и выключатель канала стоял среди настроек
// тона голоса.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge, SkeletonBlock, type Tone } from "@/components/ui/status";
import { MessageCircle, Instagram as InstagramIcon, Sparkles } from "lucide-react";
import { WhatsAppCard } from "@/components/admin/WhatsAppCard";
import { InstagramTab } from "@/components/admin/InstagramTab";
import { getSalonSecrets, upsertSalonSecrets } from "@/lib/salon-secrets.functions";
import { getOnboardingProgress } from "@/lib/onboarding.functions";

type Progress = Awaited<ReturnType<typeof getOnboardingProgress>>;

/** Состояние канала одним словом — то же самое на кнопке вкладки и в заголовке панели. */
function channelState(
  connected: boolean,
  level: "ok" | "warn" | "error" | "idle",
): { tone: Tone; text: string } {
  if (!connected) return { tone: "idle", text: "не подключён" };
  if (level === "error") return { tone: "error", text: "не работает" };
  if (level === "warn") return { tone: "warn", text: "нужно внимание" };
  return { tone: "ok", text: "подключён" };
}

export function ChannelsTab({
  salon,
  onSalonSaved,
  initialChannel,
}: {
  salon: any;
  onSalonSaved: (s: any) => void;
  /** С какого канала открыть. Приходит из ссылки ?tab=channels&channel=instagram. */
  initialChannel?: "whatsapp" | "instagram";
}) {
  const salonId = salon.id as string;
  const loadProgress = useServerFn(getOnboardingProgress);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [progressLoading, setProgressLoading] = useState(true);
  const [channel, setChannel] = useState<"whatsapp" | "instagram">(initialChannel ?? "whatsapp");
  const [assistantOn, setAssistantOn] = useState<boolean>(!!salon.ai_assistant_enabled);
  const [assistantBusy, setAssistantBusy] = useState(false);

  useEffect(() => {
    setAssistantOn(!!salon.ai_assistant_enabled);
  }, [salon.ai_assistant_enabled]);

  useEffect(() => {
    let cancelled = false;
    setProgressLoading(true);
    loadProgress({ data: { salonId } })
      .then((p) => {
        if (!cancelled) setProgress(p);
      })
      .catch(() => {
        // Состояние — вспомогательная подсказка. Если её не удалось посчитать, панели каналов
        // всё равно работают: там подключение чинится, здесь оно только называется.
        if (!cancelled) setProgress(null);
      })
      .finally(() => {
        if (!cancelled) setProgressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [salonId, loadProgress]);

  /**
   * Включить или выключить ассистента.
   *
   * ПОЧЕМУ ПИШУТСЯ ДВЕ КОЛОНКИ. Исторически выключателей было два: `salons.ai_assistant_enabled`
   * (платформа подключила салону ассистента) и `salon_ai_assistant.enabled` (владелец его
   * включил). Оба проверяются вебхуками, и любой выключенный означает тишину. Для владельца это
   * был идеальный способ потерять неделю: на одном экране «подключён», на другом «неактивен», а
   * клиенты не получают ответов. Выключатель теперь один, и он приводит обе колонки в одно
   * состояние — расходиться им больше негде.
   */
  async function toggleAssistant(v: boolean) {
    setAssistantBusy(true);
    const prev = assistantOn;
    setAssistantOn(v);
    const [{ data, error }, { error: rowError }] = await Promise.all([
      supabase
        .from("salons")
        .update({ ai_assistant_enabled: v })
        .eq("id", salonId)
        .select()
        .single(),
      supabase
        .from("salon_ai_assistant")
        .upsert({ salon_id: salonId, enabled: v } as any, { onConflict: "salon_id" }),
    ]);
    setAssistantBusy(false);
    if (error || rowError) {
      setAssistantOn(prev);
      return toast.error((error ?? rowError)!.message);
    }
    toast.success(v ? "Ассистент отвечает клиентам" : "Ассистент выключен — отвечаете вы");
    if (data) onSalonSaved(data);
  }

  const wa = channelState(
    Boolean(progress?.whatsapp.connected),
    (progress?.whatsapp.level ?? "idle") as any,
  );
  const igConnected = Boolean(progress?.instagram?.connected);
  const ig = channelState(
    igConnected,
    igConnected && !progress?.instagram?.enabled ? "warn" : "ok",
  );
  const anyConnected = Boolean(progress?.whatsapp.connected) || igConnected;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Каналы</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Через что клиенты пишут вам, и кто им отвечает. Настройка каждого канала — внутри.
        </p>
      </div>

      {/* Выключателей три и они устроены как автомат в щитке: этот общий, и пока он выключен,
          не работает ни один канал, сколько ни щёлкай их собственные. Ставим его отдельно и
          выше, чтобы порядок подчинения читался глазами, а не выяснялся опытом. */}
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">ИИ-ассистент</h3>
              <div className="flex items-center gap-2.5">
                <Switch
                  checked={assistantOn}
                  onCheckedChange={toggleAssistant}
                  disabled={assistantBusy}
                  aria-label="Включить ассистента"
                />
                <Label className="whitespace-nowrap text-sm">
                  {assistantOn ? "Отвечает" : "Выключен"}
                </Label>
              </div>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {assistantOn
                ? anyConnected
                  ? "Главный выключатель. Где именно он отвечает — настраивается отдельно в каждом канале ниже."
                  : "Включён, но пока некуда отвечать — подключите канал ниже."
                : "Выключен целиком: молчит во всех каналах, что бы ни стояло в их настройках. Сообщения клиентов копятся в «Переписках» — отвечать придётся вручную."}{" "}
              Как именно он разговаривает — во вкладке «Ассистент».
            </p>
          </div>
        </div>
      </Card>

      <Tabs value={channel} onValueChange={(v) => setChannel(v as any)}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="h-auto w-max">
            <TabsTrigger value="whatsapp" className="gap-2 py-2">
              <MessageCircle className="h-4 w-4" />
              WhatsApp
              {progressLoading ? null : <StatusBadge tone={wa.tone}>{wa.text}</StatusBadge>}
            </TabsTrigger>
            <TabsTrigger value="instagram" className="gap-2 py-2">
              <InstagramIcon className="h-4 w-4" />
              Instagram
              {progressLoading ? null : <StatusBadge tone={ig.tone}>{ig.text}</StatusBadge>}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="whatsapp" className="mt-4">
          {progressLoading ? (
            <div className="space-y-3">
              <SkeletonBlock className="h-28" />
              <SkeletonBlock className="h-40" />
            </div>
          ) : (
            <WhatsAppChannel salon={salon} onSalonSaved={onSalonSaved} masterOn={assistantOn} />
          )}
        </TabsContent>

        {/* Панель Instagram не переписывается: у неё уже есть и выключатель канала, и
            пошаговая инструкция, и диагностика. Дублировать выключатель обёрткой значило бы
            сделать ровно то, чего мы избегаем, — две кнопки для одного действия. */}
        <TabsContent value="instagram" className="mt-4">
          <InstagramTab salonId={salonId} salonName={salon.name} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

/**
 * Панель канала WhatsApp.
 *
 * Переехала сюда из вкладки «WhatsApp» страницы салона. Порядок блоков — по важности вопроса:
 * отвечает ли здесь ассистент → подключён ли канал → пишем ли клиентам первыми → куда писать вам.
 * Раньше человек, у которого WhatsApp ещё не подключён, сначала видел два переключателя про
 * уведомления, которым некуда отправлять, и только под ними — кнопку, ради которой пришёл.
 */
function WhatsAppChannel({
  salon,
  onSalonSaved,
  masterOn,
}: {
  salon: any;
  onSalonSaved: (s: any) => void;
  /** Общий выключатель салона. Выключен — свой выключатель канала ничего не решает. */
  masterOn: boolean;
}) {
  const [aiOn, setAiOn] = useState<boolean>(salon.whatsapp_ai_enabled !== false);
  const [aiBusy, setAiBusy] = useState(false);
  const [ownerPhone, setOwnerPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifyOn, setNotifyOn] = useState<boolean>(!!salon.whatsapp_enabled);
  const [notifyBusy, setNotifyBusy] = useState(false);

  const loadSecrets = useServerFn(getSalonSecrets);
  const saveSecrets = useServerFn(upsertSalonSecrets);

  useEffect(() => {
    setNotifyOn(!!salon.whatsapp_enabled);
  }, [salon.whatsapp_enabled]);

  useEffect(() => {
    setAiOn(salon.whatsapp_ai_enabled !== false);
  }, [salon.whatsapp_ai_enabled]);

  async function toggleAi(v: boolean) {
    setAiBusy(true);
    const prev = aiOn;
    setAiOn(v);
    const { data, error } = await supabase
      .from("salons")
      .update({ whatsapp_ai_enabled: v } as any)
      .eq("id", salon.id)
      .select()
      .single();
    setAiBusy(false);
    if (error) {
      setAiOn(prev);
      return toast.error(error.message);
    }
    toast.success(
      v ? "Ассистент отвечает в WhatsApp" : "В WhatsApp теперь отвечаете вы — ассистент молчит",
    );
    if (data) onSalonSaved(data);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadSecrets({ data: { salonId: salon.id } });
        if (cancelled) return;
        setOwnerPhone(data?.owner_notify_phone ?? "");
      } catch (e: any) {
        if (!cancelled) toast.error(e.message ?? "Не удалось загрузить настройки");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [salon.id]);

  async function toggleNotify(v: boolean) {
    setNotifyBusy(true);
    const prev = notifyOn;
    setNotifyOn(v);
    const { data, error } = await supabase
      .from("salons")
      .update({ whatsapp_enabled: v })
      .eq("id", salon.id)
      .select()
      .single();
    setNotifyBusy(false);
    if (error) {
      setNotifyOn(prev);
      return toast.error(error.message);
    }
    toast.success(v ? "Уведомления клиентам включены" : "Уведомления клиентам выключены");
    if (data) onSalonSaved(data);
  }

  async function save() {
    setSaving(true);
    try {
      await saveSecrets({
        data: {
          salonId: salon.id,
          owner_notify_phone: ownerPhone.replace(/[^\d]/g, "") || null,
        },
      });
      toast.success("Сохранено");
    } catch (e: any) {
      toast.error(e.message ?? "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* Выключатель канала — первым, ровно как в панели Instagram. Симметрия здесь не
          украшение: человек, настроивший один канал, должен узнавать второй с первого взгляда. */}
      <Card className="space-y-3 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Ассистент отвечает в WhatsApp</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Выключите, если на WhatsApp хотите отвечать сами. Входящие всё равно сохранятся в
              «Переписках», записи и напоминания продолжат работать — молчать будет только ИИ.
            </p>
          </div>
          <Switch
            checked={aiOn && masterOn}
            onCheckedChange={toggleAi}
            disabled={aiBusy || !masterOn}
            aria-label="Ассистент отвечает в WhatsApp"
          />
        </div>
        {!masterOn && (
          <p className="text-xs text-warning">
            Ассистент выключен целиком — переключатель выше. Пока он выключен, этот ничего не
            меняет.
          </p>
        )}
      </Card>

      {/* Подключение. Транспорт один: официальный Cloud API от Meta. */}
      <WhatsAppCard salonId={salon.id} />

      <Card className="space-y-3 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Писать клиентам первыми</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Подтверждение записи, напоминание за два часа, сообщения о переносе и отмене. Если
              выключить, Qabyl перестанет писать клиентам сам, а на странице записи исчезнут
              упоминания WhatsApp. На входящие сообщения ассистент продолжит отвечать.
            </p>
          </div>
          <Switch checked={notifyOn} onCheckedChange={toggleNotify} disabled={notifyBusy} />
        </div>
      </Card>

      <Card className={`space-y-4 p-6 ${!notifyOn ? "opacity-60" : ""}`}>
        <div>
          <h3 className="font-semibold">Куда писать вам</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            На этот номер придёт сообщение о новой записи и о том, что ассистент передал разговор
            живому человеку.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-notify-phone">Ваш номер WhatsApp</Label>
          <Input
            id="owner-notify-phone"
            value={ownerPhone}
            onChange={(e) => setOwnerPhone(e.target.value)}
            placeholder="996700123456"
            inputMode="numeric"
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground">Только цифры, с кодом страны.</p>
          {/* Пустое поле сохраняется как NULL и молча отключает ВСЕ оповещения владельцу —
              включая «ассистент передал разговор человеку». Последствие должно быть видно. */}
          {!loading && !ownerPhone.replace(/[^\d]/g, "") && (
            <p className="text-xs text-warning">
              Номер не указан — вы не узнаете ни о новой записи, ни о том, что клиент ждёт живого
              ответа. Такие случаи будут видны только во вкладке «Уведомления».
            </p>
          )}
        </div>
        <Button onClick={save} disabled={saving || loading}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </Button>
      </Card>
    </div>
  );
}
