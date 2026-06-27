import { useEffect, useRef, useState } from "react";
import { Instagram, MapPin, Phone, Clock, Star, Music2, MessageCircle, Send, ChevronDown } from "lucide-react";
import { formatPrice } from "@/lib/price";
import { useT, LanguageSwitcher } from "@/lib/i18n";
import type { SalonSiteData } from "./SalonSite";
import { normalizeWhatsApp } from "@/lib/social";

const DAYS_RU: Record<string, string> = {
  mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Вс",
};

const NAV_LABEL_KEYS: Record<string, "services" | "masters" | "gallery" | "reviews" | "contacts" | "about"> = {
  services: "services", masters: "masters", gallery: "gallery", reviews: "reviews", contacts: "contacts", about: "about",
};

function ServiceCard({ s, onBook, cardClass, titleClass }: any) {
  const { t } = useT();
  return (
    <div className={`p-5 flex flex-col ${cardClass}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className={`font-semibold ${titleClass}`}>{s.name}</h3>
      </div>
      {s.description && <p className="text-sm opacity-70 mt-2 line-clamp-3">{s.description}</p>}
      <div className="flex items-center justify-between mt-4 pt-4 border-t border-current/10">
        <div className="text-sm opacity-70">{s.duration_min} {t("min")}</div>
        <div className="font-bold">{formatPrice(s)}</div>
      </div>
      <button
        onClick={() => onBook(s.id)}
        className="mt-3 w-full py-2 rounded-lg text-sm font-medium transition hover:opacity-90"
        style={{ background: "var(--site-primary)", color: "white" }}
      >
        {t("book")}
      </button>
    </div>
  );
}

export function SiteServices({ data, onBook, cardClass = "", titleClass = "" }: { data: SalonSiteData; onBook: (sid?: string) => void; cardClass?: string; titleClass?: string }) {
  if (data.services.length === 0) return null;

  const byCat = new Map<string, any[]>();
  for (const s of data.services) {
    const key = (s.category && s.category.trim()) || "";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(s);
  }
  const present = [...byCat.keys()].filter((k) => k !== "");
  const savedOrder: string[] = (data.salon?.category_order as string[]) ?? [];
  const orderedCats = [
    ...savedOrder.filter((c) => present.includes(c)),
    ...present.filter((c) => !savedOrder.includes(c)),
  ];
  const { t } = useT();
  const uncategorized = byCat.get("") ?? [];
  const sections: { id: string; title: string; services: any[] }[] = [
    ...orderedCats.map((c) => ({ id: slugify(c), title: c, services: byCat.get(c)! })),
    ...(uncategorized.length > 0 ? [{ id: "__other", title: t("other") || "Прочее", services: uncategorized }] : []),
  ];

  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? "");
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const isClickScrolling = useRef(false);
  const userInteractedRef = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      if (isClickScrolling.current) return;
      const offset = 140;
      let current = sections[0]?.id ?? "";
      for (const s of sections) {
        const el = sectionRefs.current[s.id];
        if (el && el.getBoundingClientRect().top - offset <= 0) current = s.id;
      }
      setActiveId(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sections.map((s) => s.id).join("|")]);

  // Center the active tab horizontally only after the user interacts.
  // Doing it on first mount caused the page to jump down on preview open.
  useEffect(() => {
    if (!userInteractedRef.current) return;
    const btn = tabRefs.current[activeId];
    const strip = tabStripRef.current;
    if (!btn || !strip) return;
    const target = btn.offsetLeft - strip.clientWidth / 2 + btn.clientWidth / 2;
    strip.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [activeId]);

  const scrollTo = (id: string) => {
    const el = sectionRefs.current[id];
    if (!el) return;
    userInteractedRef.current = true;
    isClickScrolling.current = true;
    setActiveId(id);
    // scrollIntoView scrolls whichever ancestor actually scrolls and
    // respects the section's scroll-margin-top (scroll-mt-32).
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => { isClickScrolling.current = false; }, 800);
  };

  const showTabs = sections.length >= 2;

  return (
    <div className="space-y-8">
      {showTabs && (
        <div className="sticky top-16 z-30 -mx-4 px-4 py-2 backdrop-blur-md bg-[color-mix(in_oklab,var(--site-bg,white)_85%,transparent)] border-b border-current/10">
          <div ref={tabStripRef} className="overflow-x-auto no-scrollbar -mx-1">
            <div className="flex gap-2 px-1 min-w-max">
              {sections.map((s) => {
                const active = s.id === activeId;
                return (
                  <button
                    key={s.id}
                    ref={(el) => { tabRefs.current[s.id] = el; }}
                    onClick={() => scrollTo(s.id)}
                    className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium transition border ${active ? "text-white border-transparent" : "border-current/15 opacity-70 hover:opacity-100"}`}
                    style={active ? { background: "var(--site-primary)" } : undefined}
                  >
                    {s.title}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {sections.map((s) => (
        <section
          key={s.id}
          ref={(el: HTMLElement | null) => { sectionRefs.current[s.id] = el as unknown as HTMLDivElement | null; }}
          id={`svc-${s.id}`}
          className="scroll-mt-32"
        >
          {!(sections.length === 1 && s.id === "__other") && (
            <h3 className="text-2xl sm:text-3xl font-bold mb-4 tracking-tight">{s.title}</h3>
          )}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {s.services.map((svc: any) => (
              <ServiceCard key={svc.id} s={svc} onBook={onBook} cardClass={cardClass} titleClass={titleClass} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}


function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "") || "cat";
}


export function SiteMasters({ data, cardClass = "" }: { data: SalonSiteData; cardClass?: string }) {
  if (data.masters.length === 0) return null;
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {data.masters.map((m) => (
        <div key={m.id} className={`p-4 text-center ${cardClass}`}>
          {m.photo_url ? (
            <img src={m.photo_url} alt={m.name} className="w-32 h-32 mx-auto rounded-full object-cover" />
          ) : (
            <div className="w-32 h-32 mx-auto rounded-full flex items-center justify-center text-3xl font-bold" style={{ background: "var(--site-primary)", color: "white" }}>
              {m.name[0]}
            </div>
          )}
          <h3 className="font-semibold mt-3">{m.name}</h3>
          {m.specialization && <p className="text-sm opacity-70 mt-1">{m.specialization}</p>}
        </div>
      ))}
    </div>
  );
}

export function SiteGallery({ images }: { images: string[] }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {images.map((url, i) => (
        <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="aspect-square overflow-hidden rounded-lg group">
          <img src={url} alt={`Работа ${i + 1}`} className="w-full h-full object-cover group-hover:scale-105 transition duration-500" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

export function SiteReviews({ reviews, cardClass = "" }: { reviews: any[]; cardClass?: string }) {
  if (reviews.length === 0) return null;
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {reviews.map((r) => (
        <div key={r.id} className={`p-5 ${cardClass}`}>
          <div className="flex gap-0.5 mb-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className="h-4 w-4" fill={i < r.rating ? "currentColor" : "none"} style={{ color: "var(--site-accent)" }} />
            ))}
          </div>
          {r.text && <p className="text-sm opacity-90 leading-relaxed">{r.text}</p>}
          <p className="text-xs opacity-60 mt-3">— {r.client_name}</p>
        </div>
      ))}
    </div>
  );
}

export function SiteContacts({ salon, accentClass = "" }: { salon: any; accentClass?: string }) {
  const { t } = useT();
  const hours = salon.working_hours as Record<string, string> | null;
  return (
    <div className="grid md:grid-cols-2 gap-8">
      <div className="space-y-4">
        {salon.address && (
          <div className="flex gap-3">
            <MapPin className={`h-5 w-5 flex-shrink-0 mt-0.5 ${accentClass}`} />
            <div>
              <div className="text-xs opacity-60 uppercase tracking-wide">{t("address")}</div>
              <div className="font-medium">{salon.address}</div>
            </div>
          </div>
        )}
        {salon.phone && (
          <div className="flex gap-3">
            <Phone className={`h-5 w-5 flex-shrink-0 mt-0.5 ${accentClass}`} />
            <div>
              <div className="text-xs opacity-60 uppercase tracking-wide">{t("phone")}</div>
              <a href={`tel:${salon.phone}`} className="font-medium hover:underline">{salon.phone}</a>
            </div>
          </div>
        )}
        {hours && Object.keys(hours).length > 0 && (
          <div className="flex gap-3">
            <Clock className={`h-5 w-5 flex-shrink-0 mt-0.5 ${accentClass}`} />
            <div>
              <div className="text-xs opacity-60 uppercase tracking-wide">{t("hours")}</div>
              <div className="text-sm space-y-0.5 mt-1">
                {Object.entries(DAYS_RU).map(([k, label]) => (
                  hours[k] ? <div key={k}><span className="opacity-60 w-8 inline-block">{label}:</span> {hours[k]}</div> : null
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="flex gap-3 pt-2">
          {salon.instagram_url && <a href={salon.instagram_url} target="_blank" rel="noopener noreferrer" className={`p-2 rounded-full border hover:scale-110 transition ${accentClass}`}><Instagram className="h-5 w-5" /></a>}
          {salon.tiktok_url && <a href={salon.tiktok_url} target="_blank" rel="noopener noreferrer" className={`p-2 rounded-full border hover:scale-110 transition ${accentClass}`}><Music2 className="h-5 w-5" /></a>}
          {salon.whatsapp_url && <a href={normalizeWhatsApp(salon.whatsapp_url)} target="_blank" rel="noopener noreferrer" className={`p-2 rounded-full border hover:scale-110 transition ${accentClass}`}><MessageCircle className="h-5 w-5" /></a>}
          {salon.telegram_url && <a href={salon.telegram_url} target="_blank" rel="noopener noreferrer" className={`p-2 rounded-full border hover:scale-110 transition ${accentClass}`}><Send className="h-5 w-5" /></a>}
        </div>
      </div>
      {salon.address && (
        <div className="aspect-video rounded-lg overflow-hidden border border-current/10">
          <iframe
            title="Карта"
            src={`https://maps.google.com/maps?q=${encodeURIComponent(salon.address)}&output=embed`}
            className="w-full h-full"
            loading="lazy"
          />
        </div>
      )}
    </div>
  );
}

export function SiteFaq({ faqs }: { faqs: any[] }) {
  if (!faqs || faqs.length === 0) return null;
  return (
    <div className="max-w-3xl mx-auto divide-y divide-current/10 border border-current/10 rounded-2xl overflow-hidden">
      {faqs.map((f) => (
        <FaqItem key={f.id} q={f.question} a={f.answer} />
      ))}
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 text-left px-5 py-4 hover:bg-current/5 transition"
      >
        <span className="font-medium">{q}</span>
        <ChevronDown className={`h-5 w-5 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm opacity-80 whitespace-pre-line leading-relaxed">{a}</div>
      )}
    </div>
  );
}

export function SiteFooter({ salon }: { salon: any }) {
  return (
    <footer className="py-8 text-center text-xs opacity-50 border-t border-current/10">
      © {new Date().getFullYear()} {salon.name}
    </footer>
  );
}

export function NavLinks({ onBook, items }: { onBook: () => void; items: { id: string; label: string }[] }) {
  const { t } = useT();
  return (
    <nav className="flex items-center gap-4 sm:gap-6 text-sm">
      <div className="hidden md:flex items-center gap-6">
        {items.map((it) => {
          const key = NAV_LABEL_KEYS[it.id];
          return (
            <a key={it.id} href={`#${it.id}`} className="opacity-70 hover:opacity-100 transition">
              {key ? t(key) : it.label}
            </a>
          );
        })}
      </div>
      <LanguageSwitcher />
      <button onClick={onBook} className="px-3 sm:px-4 py-2 rounded-lg font-medium text-white transition hover:opacity-90 text-xs sm:text-sm" style={{ background: "var(--site-primary)" }}>
        {t("book")}
      </button>
    </nav>
  );
}
