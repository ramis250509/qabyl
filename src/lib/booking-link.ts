// Canonical public URL of a salon's self-service booking page.
//
// Mirrors catalogUrl() in catalog-share.ts and salonCanonical() in routes/book.$slug.tsx:
// a salon on a custom domain serves the booking widget at the domain root, everything
// else lives under qabyl.com/book/<slug>. Kept UI-free so the WhatsApp/Instagram agent
// can build the same link the admin panel shows.

export type BookingLinkSalon = {
  slug?: string | null;
  custom_domain?: string | null;
};

export function bookingUrl(salon: BookingLinkSalon): string | null {
  if (salon.custom_domain) return `https://${salon.custom_domain}/`;
  const slug = (salon.slug ?? "").trim();
  if (!slug) return null;
  return `https://qabyl.com/book/${slug}`;
}
