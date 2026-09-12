// Оплата переводом через MBANK.
//
// ПОЧЕМУ ЭТОТ ЭКРАН ВЫГЛЯДИТ ИМЕННО ТАК. Автоматического списания с карты у Qabyl пока нет.
// Раньше на экране оплаты стояла кнопка «Оплатить тариф», а настоящая инструкция — номер, на
// который переводить, — лежала абзацем мелкого серого текста под ней. Владелец видел кнопку,
// нажимал, ничего не происходило, и он писал в поддержку «у вас оплата не работает».
//
// Врать про то, чего нет, дороже, чем честно сказать, что сейчас перевод руками. Поэтому здесь
// нет ни одной кнопки, которая притворяется оплатой: есть сумма, номер, кнопки «скопировать» и
// три шага словами. Всё, что человеку нужно, чтобы заплатить с телефона за минуту.
//
// КНОПКА «ОТПРАВИТЬ ЧЕК» — не форма загрузки, а переход в WhatsApp с уже написанным текстом.
// Чек всё равно смотрит человек; заводить ради этого хранилище файлов и очередь модерации до
// первых десяти платящих салонов — работа, которая никому не нужна.
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Copy, Check, Smartphone, MessageCircle } from "lucide-react";
import { useState } from "react";
import { formatNumber } from "@/lib/billing-logic";

export type ManualPayment = {
  bank: string;
  phone: string | null;
  recipient: string | null;
};

function digits(v: string): string {
  return v.replace(/[^\d]/g, "");
}

/** Одна строка реквизита: подпись, значение и кнопка «скопировать». */
function CopyLine({
  label,
  value,
  display,
  big,
}: {
  label: string;
  value: string;
  display?: string;
  big?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} скопирован${label.endsWith("а") ? "а" : ""}`);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Не получилось скопировать — выделите и скопируйте вручную");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={`truncate font-semibold tabular-nums ${big ? "text-xl sm:text-2xl" : "text-base"}`}
        >
          {display ?? value}
        </div>
      </div>
      <Button
        variant="outline"
        size="icon"
        onClick={copy}
        aria-label={`Скопировать: ${label}`}
        className="shrink-0"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export function MbankPayment({
  manual,
  amountKgs,
  planName,
  salonName,
  supportContact,
}: {
  manual: ManualPayment;
  amountKgs: number;
  planName?: string | null;
  salonName?: string | null;
  supportContact: string;
}) {
  const phone = manual.phone;
  const receiptText = encodeURIComponent(
    `Здравствуйте! Оплатил${salonName ? ` тариф для салона «${salonName}»` : " тариф Qabyl"}` +
      `${planName ? ` (${planName})` : ""} — ${formatNumber(amountKgs)} сом. Отправляю чек.`,
  );
  const waLink = phone ? `https://wa.me/${digits(phone)}?text=${receiptText}` : null;

  return (
    <Card className="space-y-4 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Smartphone className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold">Оплата переводом через {manual.bank}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Списания с карты пока нет — оплата переводом с телефона. Тариф включаем после того, как
            увидим перевод: обычно в течение пары часов.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <CopyLine
          label="Сумма"
          value={String(amountKgs)}
          display={`${formatNumber(amountKgs)} сом`}
          big
        />
        {phone ? (
          <CopyLine label={`Номер ${manual.bank}`} value={phone} big />
        ) : (
          <div className="rounded-lg border bg-background px-3 py-2.5 text-sm text-muted-foreground">
            Номер для перевода не настроен — напишите нам: {supportContact}
          </div>
        )}
      </div>

      {manual.recipient && (
        <p className="text-sm text-muted-foreground">
          Получатель: <span className="font-medium text-foreground">{manual.recipient}</span>
          {planName ? ` · Тариф: ${planName}` : ""}
        </p>
      )}

      <ol className="space-y-2 text-sm">
        {[
          `Откройте ${manual.bank} и переведите ${formatNumber(amountKgs)} сом на номер выше.`,
          salonName
            ? `В комментарии к переводу напишите: ${salonName}.`
            : "В комментарии к переводу напишите название вашего салона.",
          "Отправьте нам чек — кнопкой ниже. Тариф включится автоматически после проверки.",
        ].map((step, i) => (
          <li key={step} className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-2 sm:flex-row">
        {waLink && (
          <Button asChild className="w-full sm:w-auto">
            <a href={waLink} target="_blank" rel="noreferrer">
              <MessageCircle className="mr-1.5 h-4 w-4" />
              Отправить чек в WhatsApp
            </a>
          </Button>
        )}
        <Button variant="outline" asChild className="w-full sm:w-auto">
          <a href={`mailto:${supportContact}`}>Написать на почту</a>
        </Button>
      </div>
    </Card>
  );
}
