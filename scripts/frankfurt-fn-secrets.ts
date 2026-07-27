/**
 * Build the edge-function secrets .env for the Frankfurt project.
 *  - CRON_SECRET: read from the NEW project's vault so it matches the x-cron-secret the cron jobs send
 *  - VAPID_*: copied from the repo .env
 *  - PUBLIC_APP_URL: the production site
 * Writes to SECRETS_OUT (path in env). Values are never printed.
 * Env: CREDS_FILE, SECRETS_OUT
 */
import { SQL } from "bun";

const creds = JSON.parse(await Bun.file(process.env.CREDS_FILE!).text()).new;
const url = `postgresql://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${creds.host}:${creds.port}/${creds.db}?sslmode=require`;
const sql = new SQL(url);
const [{ decrypted_secret: cronSecret }] =
  await sql`SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1`;
await sql.end();
if (!cronSecret) throw new Error("cron_secret not found in Frankfurt vault");

// Parse repo .env for the VAPID values.
const env = await Bun.file(".env").text();
const get = (k: string) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, "");
};
const vapidPub = get("VAPID_PUBLIC_KEY");
const vapidPriv = get("VAPID_PRIVATE_KEY");
const vapidSub = get("VAPID_SUBJECT");
const missing = [
  ["VAPID_PUBLIC_KEY", vapidPub],
  ["VAPID_PRIVATE_KEY", vapidPriv],
  ["VAPID_SUBJECT", vapidSub],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) throw new Error("Missing in .env: " + missing.join(", "));

const lines = [
  `CRON_SECRET=${cronSecret}`,
  `PUBLIC_APP_URL=https://qabyl.com`,
  `VAPID_PUBLIC_KEY=${vapidPub}`,
  `VAPID_PRIVATE_KEY=${vapidPriv}`,
  `VAPID_SUBJECT=${vapidSub}`,
];
await Bun.write(process.env.SECRETS_OUT!, lines.join("\n") + "\n");
console.log(`Wrote ${lines.length} secrets to SECRETS_OUT (CRON_SECRET len=${cronSecret.length}, VAPID present, PUBLIC_APP_URL=https://qabyl.com)`);
