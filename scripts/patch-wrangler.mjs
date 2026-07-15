// Keep Workers Observability (logs) ON across deploys.
//
// Nitro generates .output/server/wrangler.json fresh on every build and does NOT include an
// `observability` key, so each deploy resets the Worker to Cloudflare's default: logging DISABLED.
// Enabling it in the dashboard therefore survives only until the next push — which is exactly how
// we lost the logs mid-incident. Production must never run blind, so we patch the generated
// config after the build instead of relying on a dashboard toggle.
//
// Runs as part of `bun run build` (see package.json), so Cloudflare's CI picks it up automatically.
import { readFile, writeFile } from "node:fs/promises";

const CONFIG = ".output/server/wrangler.json";

try {
  const raw = await readFile(CONFIG, "utf8");
  const cfg = JSON.parse(raw);
  cfg.observability = { enabled: true, head_sampling_rate: 1 };
  await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`[patch-wrangler] observability enabled in ${CONFIG}`);
} catch (e) {
  // Never fail the build over telemetry config — just make the miss loud.
  console.warn(`[patch-wrangler] could not patch ${CONFIG}: ${e?.message ?? e}`);
}
