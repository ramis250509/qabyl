import { useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, ExternalLink, Download, Share2, QrCode } from "lucide-react";
import { toast } from "sonner";
import { useAdminLang } from "@/lib/admin-lang";

export function SalonShareCard({ slug, name }: { slug: string; name?: string }) {
  const { tr } = useAdminLang();
  const [showQr, setShowQr] = useState(false);
  const qrWrapRef = useRef<HTMLDivElement>(null);

  const url = useMemo(() => {
    if (typeof window === "undefined") return `/book/${slug}`;
    return `${window.location.origin}/book/${slug}`;
  }, [slug]);

  const canShare =
    typeof navigator !== "undefined" && typeof (navigator as any).share === "function";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(tr("Ссылка скопирована", "Link copied"));
    } catch {
      toast.error(tr("Не удалось скопировать", "Could not copy"));
    }
  }

  function open() {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Текст ниже уходит клиентам салона, а не владельцу, — поэтому он не зависит от языка кабинета.
  async function share() {
    try {
      await (navigator as any).share({
        title: name ? `Запись — ${name}` : "Онлайн-запись",
        text: name ? `Запишитесь в ${name} онлайн` : "Запишитесь онлайн",
        url,
      });
    } catch {
      /* user canceled */
    }
  }

  function downloadQr() {
    const canvas = qrWrapRef.current?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `qr-${slug}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (!slug) return null;

  return (
    // Одна строка вместо блока на треть экрана.
    //
    // Было: заголовок, подпись, кнопка QR, поле с адресом и три кнопки — на телефоне это
    // полэкрана над вкладками, которые и есть содержимое страницы. При этом ссылку копируют
    // один раз и потом не вспоминают. Оставлено то, ради чего сюда смотрят: сам адрес и
    // «Копировать». Остальное — иконками, QR раскрывается по нажатию.
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 p-1.5">
        <code
          className="min-w-0 flex-1 cursor-pointer truncate px-2 text-xs text-muted-foreground sm:text-sm"
          onClick={copy}
          title={url}
        >
          {url.replace(/^https?:\/\//, "")}
        </code>
        <Button onClick={copy} size="sm" className="shrink-0">
          <Copy className="h-3.5 w-3.5 sm:mr-1" />
          <span className="hidden sm:inline">{tr("Копировать", "Copy link")}</span>
        </Button>
        <Button
          onClick={() => setShowQr((v) => !v)}
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          aria-label={
            showQr ? tr("Скрыть QR-код", "Hide QR code") : tr("Показать QR-код", "Show QR code")
          }
        >
          <QrCode className="h-4 w-4" />
        </Button>
        <Button
          onClick={open}
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          aria-label={tr("Открыть страницу записи", "Open the booking page")}
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
        {canShare && (
          <Button
            onClick={share}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            aria-label={tr("Поделиться ссылкой", "Share the link")}
          >
            <Share2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {showQr && <QrBlock url={url} qrWrapRef={qrWrapRef} onDownload={downloadQr} />}
    </div>
  );
}

/** QR раскрывается отдельным блоком — печатают его редко, а места он занимает много. */
function QrBlock({
  url,
  qrWrapRef,
  onDownload,
}: {
  url: string;
  qrWrapRef: React.RefObject<HTMLDivElement | null>;
  onDownload: () => void;
}) {
  const { tr } = useAdminLang();
  return (
    <Card className="flex flex-col items-center gap-4 p-4 sm:flex-row sm:p-5">
      <div ref={qrWrapRef} className="rounded-md border bg-white p-3">
        <QRCodeCanvas value={url} size={160} level="M" includeMargin={false} />
      </div>
      <div className="space-y-2 text-center sm:text-left">
        <p className="max-w-xs text-sm text-muted-foreground">
          {tr(
            "Распечатайте и повесьте в салоне — клиент наведёт камеру и сразу окажется на странице записи.",
            "Print it and put it up in the salon — a client points the camera and lands on your booking page.",
          )}
        </p>
        <Button onClick={onDownload} variant="outline" size="sm">
          <Download className="mr-1 h-4 w-4" />
          {tr("Скачать PNG", "Download PNG")}
        </Button>
      </div>
    </Card>
  );
}
