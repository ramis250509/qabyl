// Helpers for rendering social-network links safely.
// - Some networks/domains are blocked in some countries (e.g. api.whatsapp.com in KG).
//   We normalize to safer/canonical forms (wa.me) where possible.
// - All links should open in a new tab so the salon page itself doesn't get replaced
//   by a "site blocked" page in the user's browser.

export function normalizeWhatsApp(url: string | null | undefined): string {
  if (!url) return "";
  const s = String(url).trim();
  if (!s) return "";
  // api.whatsapp.com/send?phone=996... → https://wa.me/996...
  const m = s.match(/api\.whatsapp\.com\/send\?[^#]*\bphone=(\+?\d+)/i);
  if (m) return `https://wa.me/${m[1].replace(/^\+/, "")}`;
  // chat.whatsapp.com is fine (group invites); leave as-is
  return s;
}

export function normalizeSocial(kind: "instagram" | "tiktok" | "whatsapp" | "telegram", url: string | null | undefined): string {
  if (!url) return "";
  if (kind === "whatsapp") return normalizeWhatsApp(url);
  return String(url).trim();
}

export const socialLinkProps = {
  target: "_blank" as const,
  rel: "noopener noreferrer" as const,
};
