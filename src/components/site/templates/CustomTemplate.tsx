import { useEffect, useRef, useState } from "react";
import type { SalonSiteData } from "../SalonSite";
import { formatPrice } from "@/lib/price";
import { normalizeWhatsApp } from "@/lib/social";

/**
 * Renders user-provided HTML with placeholder substitution.
 * Client-only — DOMPurify is loaded after mount to avoid SSR/Worker crashes.
 */
export function CustomTemplate({ data, onBook }: { data: SalonSiteData; onBook: (sid?: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { salon, services, masters, reviews } = data;
  const primary = salon.brand_primary || "#0ea5e9";
  const [safeHtml, setSafeHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import("dompurify");
      if (cancelled) return;
      const raw = renderTemplate(salon.custom_html || "", { salon, services, masters, reviews, primary });
      const clean = mod.default.sanitize(raw, {
        ADD_ATTR: [
          "data-zb-book", "data-rambook-book", "target", "rel", "loading",
          "class", "style", "id", "href", "src", "alt", "title",
          "crossorigin", "integrity", "media", "type",
        ],
        ADD_TAGS: ["style", "link"],
        FORCE_BODY: true,
        WHOLE_DOCUMENT: false,
        ALLOW_DATA_ATTR: true,
      });
      setSafeHtml(clean);
    })();
    return () => { cancelled = true; };
  }, [salon, services, masters, reviews, primary]);

  useEffect(() => {
    if (!ref.current) return;
    const buttons = ref.current.querySelectorAll<HTMLElement>("[data-zb-book],[data-rambook-book]");
    const handlers: Array<[HTMLElement, (e: Event) => void]> = [];
    buttons.forEach((btn) => {
      const handler = (e: Event) => {
        e.preventDefault();
        const sid = btn.getAttribute("data-zb-book") || btn.getAttribute("data-rambook-book") || undefined;
        onBook(sid || undefined);
      };
      btn.addEventListener("click", handler);
      handlers.push([btn, handler]);
    });
    return () => handlers.forEach(([el, h]) => el.removeEventListener("click", h));
  }, [safeHtml, onBook]);

  return (
    <div
      ref={ref}
      style={{ ["--site-primary" as any]: primary, ["--site-accent" as any]: salon.brand_accent || "#f59e0b" }}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}

function renderTemplate(
  raw: string,
  ctx: { salon: any; services: any[]; masters: any[]; reviews: any[]; primary: string }
) {
  if (!raw.trim()) {
    return `<div style="padding:4rem;text-align:center;color:#888">
      Вставьте свой HTML в поле «Кастомный HTML» в админке.<br/>
      Используйте плейсхолдеры: {{booking_button}}, {{services}}, {{gallery}} и т.д.
    </div>`;
  }
  const { salon, services, masters, reviews, primary } = ctx;
  const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const replacements: Record<string, string> = {
    hero_title: esc(salon.hero_title || salon.name),
    hero_subtitle: esc(salon.hero_subtitle || ""),
    hero_image: esc(salon.hero_image_url || ""),
    salon_name: esc(salon.name),
    about: esc(salon.about_text || ""),
    phone: esc(salon.phone || ""),
    address: esc(salon.address || ""),
    instagram: esc(salon.instagram_url || ""),
    tiktok: esc(salon.tiktok_url || ""),
    whatsapp: esc(normalizeWhatsApp(salon.whatsapp_url || "")),
    telegram: esc(salon.telegram_url || ""),
    booking_button: `<button data-zb-book="" style="padding:.75rem 1.5rem;border-radius:.5rem;background:${primary};color:#fff;border:none;cursor:pointer;font-weight:500">Записаться</button>`,
    services: services
      .map(
        (s) => `<div style="border:1px solid #e5e5e5;padding:1rem;border-radius:.5rem">
          <div style="font-weight:600">${esc(s.name)}</div>
          ${s.description ? `<div style="font-size:.875rem;color:#666;margin-top:.25rem">${esc(s.description)}</div>` : ""}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.75rem">
            <span style="font-size:.875rem;color:#666">${esc(s.duration_min)} мин · ${esc(formatPrice(s))}</span>
            <button data-zb-book="${esc(s.id)}" style="padding:.375rem .75rem;border-radius:.375rem;background:${primary};color:#fff;border:none;cursor:pointer;font-size:.875rem">Выбрать</button>
          </div>
        </div>`
      )
      .join(""),
    masters: masters
      .map(
        (m) => `<div style="text-align:center;padding:1rem">
          ${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="${esc(m.name)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;margin:0 auto"/>` : ""}
          <div style="font-weight:600;margin-top:.5rem">${esc(m.name)}</div>
          ${m.specialization ? `<div style="font-size:.875rem;color:#666">${esc(m.specialization)}</div>` : ""}
        </div>`
      )
      .join(""),
    gallery: (salon.gallery_images || [])
      .map((url: string) => `<img src="${esc(url)}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:.5rem" loading="lazy"/>`)
      .join(""),
    reviews: reviews
      .map(
        (r) => `<div style="border:1px solid #e5e5e5;padding:1rem;border-radius:.5rem">
          <div style="color:#f59e0b">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</div>
          ${r.text ? `<p style="margin-top:.5rem">${esc(r.text)}</p>` : ""}
          <div style="font-size:.875rem;color:#666;margin-top:.5rem">— ${esc(r.client_name)}</div>
        </div>`
      )
      .join(""),
    contacts: `
      ${salon.address ? `<div>📍 ${esc(salon.address)}</div>` : ""}
      ${salon.phone ? `<div>📞 <a href="tel:${esc(salon.phone)}">${esc(salon.phone)}</a></div>` : ""}
      <div style="display:flex;gap:.5rem;margin-top:.5rem">
        ${salon.instagram_url ? `<a href="${esc(salon.instagram_url)}" target="_blank" rel="noopener">Instagram</a>` : ""}
        ${salon.tiktok_url ? `<a href="${esc(salon.tiktok_url)}" target="_blank" rel="noopener">TikTok</a>` : ""}
        ${salon.whatsapp_url ? `<a href="${esc(normalizeWhatsApp(salon.whatsapp_url))}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
        ${salon.telegram_url ? `<a href="${esc(salon.telegram_url)}" target="_blank" rel="noopener">Telegram</a>` : ""}
      </div>
    `,
  };

  return raw.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key) => replacements[key.toLowerCase()] ?? "");
}
