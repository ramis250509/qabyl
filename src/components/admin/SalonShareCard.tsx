import { useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, ExternalLink, Download, Share2, QrCode } from "lucide-react";
import { toast } from "sonner";

export function SalonShareCard({ slug, name }: { slug: string; name?: string }) {
  const [showQr, setShowQr] = useState(false);
  const qrWrapRef = useRef<HTMLDivElement>(null);

  const url = useMemo(() => {
    if (typeof window === "undefined") return `/book/${slug}`;
    return `${window.location.origin}/book/${slug}`;
  }, [slug]);

  const canShare = typeof navigator !== "undefined" && typeof (navigator as any).share === "function";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Ссылка скопирована");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  function open() {
    window.open(url, "_blank", "noopener,noreferrer");
  }

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
    <Card className="p-4 sm:p-5 space-y-3 border-primary/30 bg-primary/5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-base sm:text-lg">Публичная ссылка для клиентов</h2>
          <p className="text-sm text-muted-foreground">Отправьте её клиенту — регистрация не нужна.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowQr((v) => !v)}>
          <QrCode className="h-4 w-4 mr-1" />
          {showQr ? "Скрыть QR" : "Показать QR"}
        </Button>
      </div>

      <div className="flex gap-2 flex-wrap">
        <Input value={url} readOnly className="flex-1 min-w-[200px] bg-background" onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={copy} variant="default" size="sm">
          <Copy className="h-4 w-4 mr-1" />Копировать
        </Button>
        <Button onClick={open} variant="outline" size="sm">
          <ExternalLink className="h-4 w-4 mr-1" />Открыть
        </Button>
        {canShare && (
          <Button onClick={share} variant="outline" size="sm">
            <Share2 className="h-4 w-4 mr-1" />Поделиться
          </Button>
        )}
      </div>

      {showQr && (
        <div className="flex flex-col sm:flex-row items-center gap-4 pt-2 border-t">
          <div ref={qrWrapRef} className="bg-white p-3 rounded-md border">
            <QRCodeCanvas value={url} size={180} level="M" includeMargin={false} />
          </div>
          <div className="space-y-2 text-center sm:text-left">
            <p className="text-sm text-muted-foreground max-w-xs">
              Распечатайте QR-код и разместите в салоне — клиенты смогут отсканировать камерой телефона и сразу записаться.
            </p>
            <Button onClick={downloadQr} variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" />Скачать PNG
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
