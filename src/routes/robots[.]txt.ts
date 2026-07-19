import { createFileRoute } from "@tanstack/react-router";

// Served at /robots.txt. Allows public pages, keeps crawlers out of the admin app,
// auth, API and internal preview routes, and points at the dynamic sitemap.
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const body = [
          "User-agent: *",
          "Allow: /",
          "Disallow: /admin",
          "Disallow: /auth",
          "Disallow: /api/",
          "Disallow: /preview/",
          "",
          `Sitemap: ${origin}/sitemap.xml`,
          "",
        ].join("\n");

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
