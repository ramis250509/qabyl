// Owner-facing "share catalog" dialog. Opens from the admin services section.
// Three tabs:
//   1. Ссылка   — the canonical URL, WhatsApp + Telegram deep-links, copy button
//   2. PDF      — opens the public /catalog/$slug page and triggers window.print()
//                 (the page's print CSS handles A4 layout + brand colours)
//   3. Текст    — plain-text catalog for one-tap copy → paste into any chat
//
// No new server code required — the underlying /catalog/$slug route is public
// and loads services from the DB via RLS, so nothing here talks to Supabase.

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Copy, ExternalLink, MessageCircle, Send, Printer } from "lucide-react";
import { toast } from "sonner";
import {
  catalogUrl,
  catalogAsText,
  shareBlurb,
  whatsappShareUrl,
  telegramShareUrl,
  type CatalogService,
  type CatalogSalon,
} from "@/lib/catalog-share";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  salon: CatalogSalon;
  services: CatalogService[];
}

export function ServiceExportDialog({ open, onOpenChange, salon, services }: Props) {
  const url = useMemo(() => catalogUrl(salon), [salon]);
  const blurb = useMemo(() => shareBlurb(salon, url), [salon, url]);
  const text = useMemo(
    () =>
      catalogAsText({ name: salon.name, phone: salon.phone, address: salon.address }, services),
    [salon, services],
  );

  // Warn if the salon has zero active services — the shared link would look empty.
  const empty = services.length === 0;

  async function copy(value: string, label = "Скопировано") {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(label);
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  function openPrintView() {
    // Open the catalog in a new tab with ?print=1, then the tab's own onLoad handler triggers
    // window.print(). We don't do it from HERE because a cross-tab print() call is blocked.
    const w = window.open(`${url}?print=1`, "_blank", "noopener");
    if (!w) toast.error("Разрешите открытие вкладок в браузере, чтобы сформировать PDF");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Поделиться прайсом</DialogTitle>
        </DialogHeader>

        {empty ? (
          <p className="text-sm text-muted-foreground">
            В прайсе пока нет активных услуг. Добавьте хотя бы одну услугу — и сможете сразу
            поделиться.
          </p>
        ) : (
          <Tabs defaultValue="link" className="w-full">
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="link">Ссылка</TabsTrigger>
              <TabsTrigger value="pdf">PDF</TabsTrigger>
              <TabsTrigger value="text">Текст</TabsTrigger>
            </TabsList>

            {/* — Ссылка — */}
            <TabsContent value="link" className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">
                Отправьте эту ссылку клиенту — он откроет красивый прайс на телефоне.
                Обновится автоматически, как только вы измените услуги.
              </p>
              <div className="flex gap-2">
                <Input value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
                <Button size="icon" variant="outline" onClick={() => copy(url)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button asChild variant="outline" className="w-full">
                  <a href={whatsappShareUrl(blurb)} target="_blank" rel="noreferrer">
                    <MessageCircle className="h-4 w-4 mr-2" /> WhatsApp
                  </a>
                </Button>
                <Button asChild variant="outline" className="w-full">
                  <a href={telegramShareUrl(url, blurb)} target="_blank" rel="noreferrer">
                    <Send className="h-4 w-4 mr-2" /> Telegram
                  </a>
                </Button>
              </div>
              <Button asChild variant="ghost" className="w-full">
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" /> Открыть страницу
                </a>
              </Button>
            </TabsContent>

            {/* — PDF — */}
            <TabsContent value="pdf" className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">
                Мы откроем прайс в новой вкладке и запустим «Печать». В окне печати выберите
                «Сохранить как PDF» — получится аккуратный A4-документ, готовый к отправке.
              </p>
              <Button className="w-full" onClick={openPrintView}>
                <Printer className="h-4 w-4 mr-2" /> Открыть и напечатать
              </Button>
              <p className="text-xs text-muted-foreground">
                На iPhone: после «Открыть» нажмите «Поделиться» → «Печать» → сведите жестом
                предпросмотр — «Сохранить в файлы».
              </p>
            </TabsContent>

            {/* — Текст — */}
            <TabsContent value="text" className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">
                Простой текстовый прайс — если хочется отправить не ссылку, а сам текст.
              </p>
              <Textarea
                rows={12}
                readOnly
                value={text}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button className="w-full" onClick={() => copy(text, "Прайс скопирован")}>
                <Copy className="h-4 w-4 mr-2" /> Скопировать текст
              </Button>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Auto-print hook for the /catalog page. The page reads the `print` query flag and, if set,
// calls window.print() once services are on screen. Kept here as a helper so both the route
// module and any future callers reuse the same wait-and-print behaviour.
export function useAutoPrintFromQuery() {
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (primed) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("print") !== "1") return;
    setPrimed(true);
    // Wait for fonts + images (logo) so the print snapshot isn't mid-load.
    const start = Date.now();
    const trigger = () => {
      if (Date.now() - start > 3000) return window.print();
      if (document.readyState !== "complete") {
        window.addEventListener("load", () => window.print(), { once: true });
      } else {
        window.setTimeout(() => window.print(), 300);
      }
    };
    trigger();
  }, [primed]);
}
