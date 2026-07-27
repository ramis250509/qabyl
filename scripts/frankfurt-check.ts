/** Read-only post-migration health check of the Frankfurt project. Env: CREDS_FILE. */
import { SQL } from "bun";

const c = JSON.parse(await Bun.file(process.env.CREDS_FILE!).text()).new;
const url = `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.db}?sslmode=require`;
const sql = new SQL(url);

console.log("=== vault secrets ===");
for (const r of await sql`SELECT name, length(decrypted_secret) AS len FROM vault.decrypted_secrets ORDER BY name`)
  console.log(`  - ${r.name} (len ${r.len})`);

console.log("=== app.settings.service_role_key GUC ===");
const g = await sql`SELECT current_setting('app.settings.service_role_key', true) AS v`;
console.log(`  set: ${g[0].v ? "yes (len " + g[0].v.length + ")" : "NO"}`);

console.log("=== cron jobs ===");
for (const r of await sql`SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname`)
  console.log(`  - [${r.jobid}] ${r.jobname} | ${r.schedule} | active=${r.active}`);

console.log("=== function-invocation URLs referenced in cron commands ===");
const urls = await sql`
  SELECT DISTINCT substring(command FROM 'https?://[a-z0-9.]+') AS host
  FROM cron.job WHERE command ~ 'https?://'`;
for (const r of urls) console.log(`  - ${r.host}`);

console.log("=== salon_secrets (Green-API) present ===");
for (const r of await sql`
  SELECT s.name, (ss.greenapi_instance IS NOT NULL) AS has_instance,
         (ss.greenapi_token IS NOT NULL) AS has_token,
         (ss.greenapi_webhook_token IS NOT NULL) AS has_webhook_token
  FROM public.salon_secrets ss JOIN public.salons s ON s.id = ss.salon_id`)
  console.log(`  - ${r.name}: instance=${r.has_instance} token=${r.has_token} webhook_token=${r.has_webhook_token}`);

await sql.end();
