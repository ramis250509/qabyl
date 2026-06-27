import type { SalonSiteData } from "../SalonSite";
import { NavLinks, SiteServices, SiteMasters, SiteGallery, SiteReviews, SiteContacts, SiteFooter, SiteFaq } from "../sections";

export function VividTemplate({ data, onBook }: { data: SalonSiteData; onBook: (sid?: string) => void }) {
  const { salon } = data;
  const primary = salon.brand_primary || "#e84393";
  const accent = salon.brand_accent || "#6c5ce7";

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
      className="min-h-screen bg-white text-neutral-900"
      style={{ ["--site-primary" as any]: primary, ["--site-accent" as any]: accent }}
    >
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <a href="#top" className="flex items-center gap-2">
            {salon.logo_url && <img src={salon.logo_url} alt={salon.name} className="h-9 w-9 rounded-2xl object-cover" />}
            <span className="font-extrabold text-lg tracking-tight">{salon.name}</span>
          </a>
          <NavLinks onBook={() => onBook()} items={navItems} />
        </div>
      </header>

      <section id="top" className="relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-90"
          style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}
        />
        <div className="absolute inset-0 opacity-30 mix-blend-overlay" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, white, transparent 50%)" }} />
        <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32 grid md:grid-cols-2 gap-10 items-center text-white">
          <div>
            <h1 className="text-5xl md:text-7xl font-black tracking-tight leading-[0.95]">
              {salon.hero_title || salon.name}
            </h1>
            {salon.hero_subtitle && (
              <p className="text-xl mt-6 leading-relaxed opacity-95">{salon.hero_subtitle}</p>
            )}
            <div className="flex flex-wrap gap-3 mt-8">
              <button onClick={() => onBook()} className="px-7 py-4 rounded-2xl font-bold bg-white text-neutral-900 shadow-xl hover:scale-105 transition">
                Записаться онлайн →
              </button>
              {salon.phone && (
                <a href={`tel:${salon.phone}`} className="px-7 py-4 rounded-2xl font-bold border-2 border-white/60 hover:bg-white/10 transition">
                  Позвонить
                </a>
              )}
            </div>
          </div>
          {salon.hero_image_url && (
            <div className="aspect-square rounded-3xl overflow-hidden shadow-2xl rotate-2 hover:rotate-0 transition duration-500">
              <img src={salon.hero_image_url} alt={salon.name} className="w-full h-full object-cover" />
            </div>
          )}
        </div>
      </section>

      {salon.about_text && (
        <section className="max-w-4xl mx-auto px-6 py-20 text-center">
          <Tag color={primary}>О салоне</Tag>
          <p className="text-2xl md:text-3xl font-bold leading-tight mt-4 whitespace-pre-line">{salon.about_text}</p>
        </section>
      )}

      {data.services.length > 0 && (
        <section id="services" className="max-w-6xl mx-auto px-6 py-16">
          <Header eyebrow="Прайс" title="Услуги" primary={primary} />
          <SiteServices data={data} onBook={onBook} cardClass="rounded-3xl bg-white shadow-lg hover:shadow-2xl hover:-translate-y-1 transition" />
        </section>
      )}

      {data.masters.length > 0 && (
        <section id="masters" className="py-20" style={{ background: `linear-gradient(135deg, ${primary}15, ${accent}15)` }}>
          <div className="max-w-6xl mx-auto px-6">
            <Header eyebrow="Команда" title="Наши мастера" primary={primary} />
            <SiteMasters data={data} cardClass="rounded-3xl bg-white shadow-md" />
          </div>
        </section>
      )}

      {salon.gallery_images?.length > 0 && (
        <section id="gallery" className="max-w-6xl mx-auto px-6 py-16">
          <Header eyebrow="Работы" title="Галерея" primary={primary} />
          <SiteGallery images={salon.gallery_images} />
        </section>
      )}

      {data.reviews.length > 0 && (
        <section id="reviews" className="py-20" style={{ background: `linear-gradient(135deg, ${primary}15, ${accent}15)` }}>
          <div className="max-w-6xl mx-auto px-6">
            <Header eyebrow="Отзывы" title="Что говорят клиенты" primary={primary} />
            <SiteReviews reviews={data.reviews} cardClass="rounded-3xl bg-white shadow-md" />
          </div>
        </section>
      )}

      {data.faqs.length > 0 && (
        <section id="faq" className="max-w-6xl mx-auto px-6 py-16">
          <Header eyebrow="FAQ" title="Частые вопросы" primary={primary} />
          <SiteFaq faqs={data.faqs} />
        </section>
      )}

      <section id="contacts" className="max-w-6xl mx-auto px-6 py-16">
        <Header eyebrow="Контакты" title="Как нас найти" primary={primary} />
        <SiteContacts salon={salon} />
      </section>

      <div className="max-w-6xl mx-auto px-6">
        <SiteFooter salon={salon} />
      </div>
    </div>
  );
}

function Tag({ children, color }: { children: any; color: string }) {
  return (
    <span className="inline-block px-4 py-1 rounded-full text-xs font-bold uppercase tracking-wider text-white" style={{ background: color }}>
      {children}
    </span>
  );
}

function Header({ eyebrow, title, primary }: { eyebrow: string; title: string; primary: string }) {
  return (
    <div className="mb-10 text-center">
      <Tag color={primary}>{eyebrow}</Tag>
      <h2 className="text-4xl md:text-5xl font-black tracking-tight mt-3">{title}</h2>
    </div>
  );
}
