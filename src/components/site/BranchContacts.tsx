import { MapPin, Phone, Instagram, MessageCircle, Send, Music2 } from "lucide-react";
import { normalizeWhatsApp } from "@/lib/social";

type Branch = {
  id: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  instagram_url?: string | null;
  whatsapp_url?: string | null;
  telegram_url?: string | null;
  tiktok_url?: string | null;
};

export type BranchVariant = "light" | "dark" | "vivid";

const VARIANT_STYLES: Record<BranchVariant, { section: string; card: string; sub: string; chip: string }> = {
  light: {
    section: "bg-background text-foreground border-t",
    card: "rounded-xl border bg-card",
    sub: "text-muted-foreground",
    chip: "bg-muted hover:bg-muted/80",
  },
  dark: {
    section: "bg-neutral-950 text-neutral-100 border-t border-neutral-800",
    card: "rounded-sm border border-neutral-800 bg-neutral-900",
    sub: "text-neutral-400",
    chip: "bg-neutral-800 hover:bg-neutral-700 text-neutral-100",
  },
  vivid: {
    section: "text-white border-t border-white/10",
    card: "rounded-3xl bg-white/10 backdrop-blur border border-white/20",
    sub: "text-white/80",
    chip: "bg-white/15 hover:bg-white/25 text-white",
  },
};

export function BranchContactCard({ branch, accent, variant = "light" }: { branch: Branch; accent?: string; variant?: BranchVariant }) {
  const primary = accent ?? "#0ea5e9";
  const styles = VARIANT_STYLES[variant];
  return (
    <div className={`${styles.card} p-4 space-y-2`}>
      <div className="flex items-start gap-2">
        <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${primary}33`, color: primary }}>
          <MapPin className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold">{branch.name}</div>
          {branch.address && <div className={`text-sm ${styles.sub}`}>{branch.address}</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {branch.phone && (
          <a href={`tel:${branch.phone.replace(/\s/g, "")}`} className={`inline-flex items-center gap-1 text-sm px-2 py-1 rounded-md ${styles.chip}`}>
            <Phone className="h-3.5 w-3.5" />{branch.phone}
          </a>
        )}
        {branch.whatsapp_url && (
          <a href={normalizeWhatsApp(branch.whatsapp_url)} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 text-sm px-2 py-1 rounded-md ${styles.chip}`}>
            <MessageCircle className="h-3.5 w-3.5" />WhatsApp
          </a>
        )}
        {branch.instagram_url && (
          <a href={branch.instagram_url} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 text-sm px-2 py-1 rounded-md ${styles.chip}`}>
            <Instagram className="h-3.5 w-3.5" />Instagram
          </a>
        )}
        {branch.telegram_url && (
          <a href={branch.telegram_url} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 text-sm px-2 py-1 rounded-md ${styles.chip}`}>
            <Send className="h-3.5 w-3.5" />Telegram
          </a>
        )}
        {branch.tiktok_url && (
          <a href={branch.tiktok_url} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 text-sm px-2 py-1 rounded-md ${styles.chip}`}>
            <Music2 className="h-3.5 w-3.5" />TikTok
          </a>
        )}
      </div>
    </div>
  );
}

export function BranchesContactsBlock({
  branches,
  accent,
  title = "Наши филиалы",
  variant = "light",
  bgStyle,
}: {
  branches: Branch[];
  accent?: string;
  title?: string;
  variant?: BranchVariant;
  bgStyle?: React.CSSProperties;
}) {
  if (!branches || branches.length === 0) return null;
  const styles = VARIANT_STYLES[variant];
  return (
    <section className={`py-10 px-4 ${styles.section}`} style={bgStyle}>
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl font-bold mb-4">{title}</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {branches.map((b) => <BranchContactCard key={b.id} branch={b} accent={accent} variant={variant} />)}
        </div>
      </div>
    </section>
  );
}
