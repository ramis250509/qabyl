import { createFileRoute } from "@tanstack/react-router";

// Served at /sitemap.xml. Lists the marketing landing plus every active public salon page.
// A salon's canonical URL is its custom domain when set, otherwise /book/{slug} on this origin.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry(loc: string, lastmod?: string, changefreq?: string, priority?: string): string {
  return [
    "  <url>",
    `    <loc>${xmlEscape(loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : "",
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : "",
    priority ? `    <priority>${priority}</priority>` : "",
    "  </url>",
  ]
    .filter(Boolean)
    .join("\n");
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const entries: string[] = [
          urlEntry(`${origin}/`, undefined, "weekly", "1.0"),
          urlEntry(`${origin}/privacy`, undefined, "yearly", "0.3"),
          urlEntry(`${origin}/terms`, undefined, "yearly", "0.3"),
        ];

        try {
          // Anon client: salon slug/domain of active salons is public data, and this works in
          // every environment (no service-role key needed).
          const { supabase } = await import("@/integrations/supabase/client");
          const { data } = await supabase
            .from("salons")
            .select("slug, custom_domain, updated_at")
            .eq("is_active", true);

          for (const s of data ?? []) {
            const loc = s.custom_domain
              ? `https://${s.custom_domain}/`
              : `${origin}/book/${s.slug}`;
            const lastmod = s.updated_at
              ? new Date(s.updated_at).toISOString().slice(0, 10)
              : undefined;
            entries.push(urlEntry(loc, lastmod, "weekly", "0.8"));
          }
        } catch (e) {
          // If the DB is unreachable (e.g. no service-role key locally) still return a valid
          // sitemap with just the landing page rather than a 500.
          console.error("[sitemap] failed to list salons", e);
        }

        const body =
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          entries.join("\n") +
          "\n</urlset>\n";

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
