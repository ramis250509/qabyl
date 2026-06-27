import type { SalonSiteData } from "../SalonSite";
import { NavLinks, SiteServices, SiteMasters, SiteGallery, SiteReviews, SiteContacts, SiteFooter, SiteFaq } from "../sections";

export function MinimalTemplate({ data, onBook }: { data: SalonSiteData; onBook: (sid?: string) => void }) {
  const { salon } = data;
  const primary = salon.brand_primary || "#0ea5e9";
  const accent = salon.brand_accent || "#f59e0b";

  const navItems = [
    data.services.length && { id: "services", label: "Услуги" },
    data.masters.length && { id: "masters", label: "Мастера" },
    salon.gallery_images?.length && { id: "gallery", label: "Галерея" },
    data.reviews.length && { id: "reviews", label: "Отзывы" },
    data.faqs.length && { id: "faq", label: "FAQ" },
    { id: "contacts", label: "Контакты" },
  ].filter(Boolean) as { id: string; label: string }[];

  return (
    <div className="min-h-screen bg-white text-neutral-900" style={{ ["--site-primary" as any]: primary, ["--site-accent" as any]: accent }}>
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-neutral-200">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <a href="#top" className="flex items-center gap-2">
            {salon.logo_url && <img src={salon.logo_url} alt={salon.name} className="h-8 w-8 rounded-full object-cover" />}
            <span className="font-semibold tracking-tight">{salon.name}</span>
          </a>
          <NavLinks onBook={() => onBook()} items={navItems} />
        </div>
      </header>

      <section id="top" className="max-w-6xl mx-auto px-6 py-20 md:py-32">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <h1 className="text-5xl md:text-6xl font-light tracking-tight leading-[1.05]">
              {salon.hero_title || salon.name}
            </h1>
            {salon.hero_subtitle && (
              <p className="text-lg text-neutral-600 mt-6 leading-relaxed">{salon.hero_subtitle}</p>
            )}
            <div className="flex gap-3 mt-8">
              <button onClick={() => onBook()} className="px-6 py-3 rounded-full font-medium text-white" style={{ background: primary }}>
                Записаться онлайн
              </button>
              {salon.phone && (
                <a href={`tel:${salon.phone}`} className="px-6 py-3 rounded-full font-medium border border-neutral-300 hover:bg-neutral-50">
                  Позвонить
                </a>
              )}
            </div>
          </div>
          {salon.hero_image_url && (
            <div className="aspect-[4/5] rounded-2xl overflow-hidden">
              <img src={salon.hero_image_url} alt={salon.name} className="w-full h-full object-cover" />
            </div>
          )}
        </div>
      </section>

      {salon.about_text && (
        <section className="max-w-3xl mx-auto px-6 py-16 text-center">
          <div className="text-xs uppercase tracking-widest opacity-60 mb-3">О салоне</div>
          <p className="text-xl md:text-2xl font-light leading-relaxed whitespace-pre-line">{salon.about_text}</p>
          <div className="grid grid-cols-3 gap-4 mt-10 text-center">
            <Metric value={data.masters.length} label="мастеров" />
            <Metric value={data.services.length} label="услуг" />
            <Metric value={data.reviews.length || "★"} label="отзывов" />
          </div>
        </section>
      )}

      {data.services.length > 0 && (
        <section id="services" className="max-w-6xl mx-auto px-6 py-16">
          <SectionHeader eyebrow="Прайс" title="Услуги" />
          <SiteServices data={data} onBook={onBook} cardClass="border border-neutral-200 rounded-2xl bg-white" />
        </section>
      )}

      {data.masters.length > 0 && (
        <section id="masters" className="max-w-6xl mx-auto px-6 py-16">
          <SectionHeader eyebrow="Команда" title="Наши мастера" />
          <SiteMasters data={data} />
        </section>
      )}

      {salon.gallery_images?.length > 0 && (
        <section id="gallery" className="max-w-6xl mx-auto px-6 py-16">
          <SectionHeader eyebrow="Работы" title="Галерея" />
          <SiteGallery images={salon.gallery_images} />
        </section>
      )}

      {data.reviews.length > 0 && (
        <section id="reviews" className="max-w-6xl mx-auto px-6 py-16">
          <SectionHeader eyebrow="Отзывы" title="Что говорят клиенты" />
          <SiteReviews reviews={data.reviews} cardClass="border border-neutral-200 rounded-2xl bg-white" />
        </section>
      )}

      {data.faqs.length > 0 && (
        <section id="faq" className="max-w-6xl mx-auto px-6 py-16">
          <SectionHeader eyebrow="FAQ" title="Частые вопросы" />
          <SiteFaq faqs={data.faqs} />
        </section>
      )}

      <section id="contacts" className="max-w-6xl mx-auto px-6 py-16">
        <SectionHeader eyebrow="Контакты" title="Как нас найти" />
        <SiteContacts salon={salon} />
      </section>

      <div className="max-w-6xl mx-auto px-6">
        <SiteFooter salon={salon} />
      </div>
    </div>
  );
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-8">
      <div className="text-xs uppercase tracking-widest opacity-60">{eyebrow}</div>
      <h2 className="text-3xl md:text-4xl font-light tracking-tight mt-1">{title}</h2>
    </div>
  );
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <div className="text-3xl font-light">{value}</div>
      <div className="text-xs uppercase tracking-wider opacity-60 mt-1">{label}</div>
    </div>
  );
}
