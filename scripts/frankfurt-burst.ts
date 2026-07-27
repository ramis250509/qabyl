/** Fire concurrent HEAD count + GET requests to test free-tier concurrency limits. Env: ANON. */
const anon = process.env.ANON!;
const base = "https://bfxexnpyfslfuelfkhzr.supabase.co/rest/v1";
const salon = "3aa42b19-b38a-4fb1-9d43-d9f258786b35";

async function one(kind: string) {
  const isHead = kind === "HEAD";
  const path = kind === "GET-svc"
    ? `/services?select=*&salon_id=eq.${salon}`
    : `/${kind === "HEAD-m" ? "masters" : "services"}?select=id&salon_id=eq.${salon}`;
  const r = await fetch(base + path, {
    method: kind.startsWith("HEAD") ? "HEAD" : "GET",
    headers: {
      apikey: anon, Authorization: `Bearer ${anon}`, Origin: "https://qabyl.com",
      ...(kind.startsWith("HEAD") ? { Prefer: "count=exact" } : {}),
    },
  });
  let body = "";
  if (r.status >= 400) body = (await r.text()).slice(0, 120);
  return { kind, status: r.status, server: r.headers.get("server"), body };
}

// Fire 12 concurrent, mixing count HEADs and GETs, a few rounds.
for (let round = 1; round <= 3; round++) {
  const batch = ["HEAD", "HEAD-m", "HEAD", "HEAD-m", "GET-svc", "GET-svc", "HEAD", "HEAD-m", "GET-svc", "HEAD", "HEAD-m", "HEAD"];
  const results = await Promise.all(batch.map(one));
  const codes = results.map((r) => r.status);
  const n503 = codes.filter((c) => c === 503).length;
  console.log(`round ${round}: ${n503}/${codes.length} were 503  | statuses=${codes.join(",")}`);
  const anyErr = results.find((r) => r.status >= 400);
  if (anyErr) console.log(`   sample error body (${anyErr.status}, server=${anyErr.server}): ${anyErr.body}`);
}
