import { createServerFn } from "@tanstack/react-start";

// The platform's own marketing hosts. On these the "/" route renders the landing during SSR
// so JS-light crawlers (notably Yandex) get the full page instead of an empty loader. Every
// other host (salon custom domains, dev/preview) resolves on the client exactly as before, so
// this can never change what a client's salon site renders.
const MARKETING_HOSTS = new Set(["qabyl.com", "www.qabyl.com"]);

// Reads the request Host header on the server. Returns false on the client / on any error, so
// the caller always falls back to the existing client-side host resolution.
export const getSsrLanding = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const host = getRequest()?.headers.get("host");
    if (!host) return false;
    return MARKETING_HOSTS.has(host.split(":")[0].toLowerCase());
  } catch {
    return false;
  }
});
