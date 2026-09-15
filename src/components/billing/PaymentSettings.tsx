import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { setBillingAutoTopup } from "@/lib/billing.functions";

export function PaymentSettings({
  salonId,
  card,
  enabled,
  threshold,
  packs,
  packMessages,
  packPrice,
  recurring,
  busy,
  run,
}: {
  salonId: string;
  card?: string | null;
  enabled: boolean;
  threshold: number;
  packs: number;
  packMessages: number;
  packPrice: number;
  recurring: boolean;
  busy: boolean;
  run: (key: string, fn: () => Promise<unknown>, okText?: string) => Promise<void>;
}) {
  const [limit, setLimit] = useState(threshold);
  const [quantity, setQuantity] = useState(packs);
  const price = quantity * packPrice;
  return (
    <Card className="p-4 sm:p-5 space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">Автопополнение сообщений</h2>
        <p className="text-sm text-muted-foreground">
          Пополняйте общий баланс салона и всех его филиалов.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="topup-threshold">Когда осталось не больше</Label>
          <select
            id="topup-threshold"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            disabled={busy}
          >
            <option value={500}>500 сообщений</option>
            <option value={1000}>1 000 сообщений</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="topup-package">Пакет</Label>
          <select
            id="topup-package"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            disabled={busy}
          >
            {[1, 2, 4].map((n) => (
              <option key={n} value={n}>
                {(packMessages * n).toLocaleString("ru-RU")} сообщений ·{" "}
                {(packPrice * n).toLocaleString("ru-RU")} сом
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-sm">Карта: {card ?? "не привязана"}</p>
      <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        При включении с выбранной карты будет автоматически списываться{" "}
        {price.toLocaleString("ru-RU")} сом при достижении порога {limit.toLocaleString("ru-RU")}{" "}
        сообщений. Отключение остановит новые покупки; уже отправленный в банк платёж может
        завершиться.
      </p>
      <div className="flex items-center gap-3">
        <Switch
          id="topup-enable"
          checked={enabled}
          disabled={busy || (!enabled && (!recurring || !card))}
          onCheckedChange={(value) => {
            if (value && !window.confirm(`Включить автоматическую покупку пакета за ${price} сом?`))
              return;
            void run(
              "auto-topup",
              () =>
                setBillingAutoTopup({
                  data: {
                    salonId,
                    enabled: value,
                    threshold: limit as 500 | 1000,
                    packs: quantity,
                  },
                }),
              value ? "Автопополнение включено" : "Автопополнение отключено",
            );
          }}
        />
        <Label htmlFor="topup-enable">{enabled ? "Включено" : "Выключено"}</Label>
      </div>
      {!recurring && (
        <p className="text-sm text-muted-foreground">
          Автопополнение станет доступно после подключения автоматических платежей. Сейчас списаний
          не будет; можно сохранить настройки заранее.
        </p>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          if (enabled && !window.confirm(`Изменить сумму автоматической покупки на ${price} сом?`))
            return;
          void run(
            "topup-settings",
            () =>
              setBillingAutoTopup({
                data: {
                  salonId,
                  enabled: enabled && recurring,
                  threshold: limit as 500 | 1000,
                  packs: quantity,
                },
              }),
            "Настройки сохранены",
          );
        }}
      >
        Сохранить настройки
      </Button>
    </Card>
  );
}
