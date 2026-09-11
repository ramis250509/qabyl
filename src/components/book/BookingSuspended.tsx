// Страница салона, чья подписка Qabyl не оплачена.
//
// Два читателя. Клиент должен понять, что запись не сломалась у него, и получить способ связаться
// с салоном напрямую. Владелец, открыв свою страницу, должен понять, что сделать, — поэтому
// строка для него внизу, мелко: клиенту она не мешает, владелец её найдёт.
import { Link } from "@tanstack/react-router";
import { CalendarOff, Phone } from "lucide-react";

export function BookingSuspended({
  salon,
}: {
  salon: { name: string; phone?: string | null; logo_url?: string | null };
}) {
  const tel = salon.phone ? salon.phone.replace(/[^\d+]/g, "") : null;
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full text-center space-y-5 animate-in fade-in-0 zoom-in-95 duration-300">
        {salon.logo_url ? (
          <img
            src={salon.logo_url}
            alt=""
            className="mx-auto h-16 w-16 rounded-full object-cover"
          />
        ) : (
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center">
            <CalendarOff className="h-7 w-7 text-muted-foreground" aria-hidden />
          </div>
        )}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">{salon.name}</h1>
          <p className="text-muted-foreground">
            Онлайн-запись временно недоступна. Чтобы записаться, свяжитесь с салоном напрямую.
          </p>
        </div>
        {tel && (
          <a
            href={`tel:${tel}`}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2.5 text-primary-foreground font-medium hover:opacity-90 transition"
          >
            <Phone className="h-4 w-4" aria-hidden /> Позвонить {salon.phone}
          </a>
        )}
        <p className="text-xs text-muted-foreground pt-6 border-t">
          Владельцу салона: подписка Qabyl не оплачена.{" "}
          <Link to="/admin/billing" className="underline underline-offset-2">
            Оплатить в кабинете
          </Link>
        </p>
      </div>
    </main>
  );
}
