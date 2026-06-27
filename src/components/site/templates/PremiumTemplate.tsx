import type { SalonSiteData } from "../SalonSite";
import { NavLinks, SiteServices, SiteMasters, SiteGallery, SiteReviews, SiteContacts, SiteFooter, SiteFaq } from "../sections";

function isDark(hex: string) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

export function PremiumTemplate({ data, onBook }: { data: SalonSiteData; onBook: (sid?: string) => void }) {
  const { salon } = data;
  const primary = salon.brand_primary || "#c9a84c";
  const rawAccent = salon.brand_accent || "#f0d78c";
  // On the dark Premium background, a dark accent makes the CTA invisible.
  // Fall back to gold automatically so the button always stands out.
  const accent = isDark(rawAccent) ? "#f0d78c" : rawAccent;


  const navItems = [
    data.services.length && { id: "services", label: "Услуги" },
    data.masters.length && { id: "masters", label: "Мастера" },
    salon.gallery_images?.length && { id: "gallery", label: "Галерея" },
    data.reviews.length && { id: "reviews", label: "Отзывы" },
    data.faqs.length && { id: "faq", label: "FAQ" },
    { id: "contacts", label: "Контакты" },
  ].filter(Boolean) as { id: string; label: string }[];

  return (
    <div
      className="min-h-screen bg-neutral-950 text-neutral-100"
      style={{
        ["--site-primary" as any]: primary,
        ["--site-accent" as any]: accent,
        fontFamily: "'Cormorant Garamond', 'Playfair Display', Georgia, serif",
      }}
    >
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Inter:wght@300;400;500&display=swap" rel="stylesheet" />
      <header className="sticky top-0 z-30 bg-neutral-950/85 backdrop-blur border-b border-neutral-800">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <a href="#top" className="flex items-center gap-2">
            {salon.logo_url && <img src={salon.logo_url} alt={salon.name} className="h-9 w-9 rounded-full object-cover" />}
            <span className="font-medium text-lg tracking-wide" style={{ color: accent }}>{salon.name}</span>
          </a>
          <NavLinks onBook={() => onBook()} items={navItems} />
        </div>
      </header>

      <section id="top" className="relative overflow-hidden">
        {salon.hero_image_url && (
          <div className="absolute inset-0">
            <img src={salon.hero_image_url} alt="" className="w-full h-full object-cover opacity-40" />
            <div className="absolute inset-0 bg-gradient-to-b from-neutral-950/40 via-neutral-950/70 to-neutral-950" />
          </div>
        )}
        <div className="relative max-w-4xl mx-auto px-6 py-32 md:py-44 text-center">
          <div className="text-xs uppercase tracking-[0.4em] mb-6" style={{ color: accent }}>Beauty Atelier</div>
          <h1 className="text-5xl md:text-7xl font-light leading-[1.05]" style={{ fontFamily: "'Cormorant Garamond', serif" }}>
            {salon.hero_title || salon.name}
          </h1>
          {salon.hero_subtitle && (
            <p className="text-xl text-neutral-300 mt-8 leading-relaxed max-w-2xl mx-auto" style={{ fontFamily: "Inter, sans-serif" }}>
              {salon.hero_subtitle}
            </p>
          )}
          <div className="mt-10 flex flex-wrap gap-3 justify-center" style={{ fontFamily: "Inter, sans-serif" }}>
            <button
              onClick={() => onBook()}
              className="px-10 py-4 font-semibold tracking-wider uppercase text-sm shadow-2xl transition hover:brightness-110"
              style={{ background: accent, color: "#0a0a0a" }}
            >
              Записаться онлайн
            </button>
            {salon.phone && (
              <a
                href={`tel:${salon.phone}`}
                className="px-8 py-4 font-medium tracking-wider uppercase text-sm border-2 transition hover:bg-white/10"
                style={{ borderColor: accent, color: accent }}
              >
                Позвонить
              </a>
            )}
          </div>
        </div>
      </section>

      {salon.about_text && (
        <section className="max-w-3xl mx-auto px-6 py-24 text-center">
          <div className="text-xs uppercase tracking-[0.4em] mb-4" style={{ color: accent }}>О нас</div>
          <p className="text-2xl md:text-3xl font-light leading-relaxed whitespace-pre-line text-neutral-200">{salon.about_text}</p>
        </section>
      )}

      {data.services.length > 0 && (
        <section id="services" className="max-w-6xl mx-auto px-6 py-20">
          <Header eyebrow="Прайс-лист" title="Услуги" accent={accent} />
          <SiteServices data={data} onBook={onBook} cardClass="bg-neutral-900 border border-neutral-800 rounded-sm" titleClass="text-lg" />
        </section>
      )}

      {data.masters.length > 0 && (
        <section id="masters" className="max-w-6xl mx-auto px-6 py-20">
          <Header eyebrow="Команда" title="Наши мастера" accent={accent} />
          <SiteMasters data={data} cardClass="bg-neutral-900/50 border border-neutral-800 rounded-sm" />
        </section>
      )}

      {salon.gallery_images?.length > 0 && (
        <section id="gallery" className="max-w-6xl mx-auto px-6 py-20">
          <Header eyebrow="Портфолио" title="Галерея работ" accent={accent} />
          <SiteGallery images={salon.gallery_images} />
        </section>
      )}

      {data.reviews.length > 0 && (
        <section id="reviews" className="max-w-6xl mx-auto px-6 py-20">
          <Header eyebrow="Отзывы" title="Слова наших клиентов" accent={accent} />
          <SiteReviews reviews={data.reviews} cardClass="bg-neutral-900 border border-neutral-800 rounded-sm" />
        </section>
      )}

      {data.faqs.length > 0 && (
        <section id="faq" className="max-w-6xl mx-auto px-6 py-20">
          <Header eyebrow="FAQ" title="Частые вопросы" accent={accent} />
          <SiteFaq faqs={data.faqs} />
        </section>
      )}

      <section id="contacts" className="max-w-6xl mx-auto px-6 py-20">
        <Header eyebrow="Контакты" title="Найдите нас" accent={accent} />
        <SiteContacts salon={salon} accentClass="text-current" />
      </section>

      <div className="max-w-6xl mx-auto px-6">
        <SiteFooter salon={salon} />
      </div>
    </div>
  );
}

function Header({ eyebrow, title, accent }: { eyebrow: string; title: string; accent: string }) {
  return (
    <div className="mb-12 text-center">
      <div className="text-xs uppercase tracking-[0.4em]" style={{ color: accent }}>{eyebrow}</div>
      <h2 className="text-4xl md:text-5xl font-light tracking-tight mt-3" style={{ fontFamily: "'Cormorant Garamond', serif" }}>{title}</h2>
    </div>
  );
}
