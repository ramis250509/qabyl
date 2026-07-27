/** Probe Frankfurt PostgREST to reproduce the 503 pattern. Env: ANON (anon key). */
const base = "https://bfxexnpyfslfuelfkhzr.supabase.co/rest/v1";
const anon = process.env.ANON!;
if (!anon) { console.error("ANON env missing"); process.exit(1); }

const salon = "3aa42b19-b38a-4fb1-9d43-d9f258786b35";
const cases: [string, string, Record<string, string>][] = [
  ["GET  user_roles", `/user_roles?select=role&limit=1`, {}],
  ["GET  services",   `/services?select=id&salon_id=eq.${salon}`, {}],
  ["HEAD services",   `/services?select=id&salon_id=eq.${salon}`, { Prefer: "count=exact" }],
  ["HEAD masters",    `/masters?select=id&salon_id=eq.${salon}`, { Prefer: "count=exact" }],
  ["GET  salons",     `/salons?select=id&limit=1`, {}],
];

for (const [label, path, extra] of cases) {
  const method = label.startsWith("HEAD") ? "HEAD" : "GET";
  try {
    const r = await fetch(base + path, {
      method,
      headers: { apikey: anon, Authorization: `Bearer ${anon}`, Origin: "https://qabyl.com", ...extra },
    });
    const body = method === "HEAD" ? "" : (await r.text()).slice(0, 200);
    console.log(`${label.padEnd(18)} -> ${r.status}  cr=${r.headers.get("content-range") ?? "-"}  ${body}`);
  } catch (e: any) {
    console.log(`${label.padEnd(18)} -> ERROR ${e.message}`);
  }
}
