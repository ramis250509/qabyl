/**
 * Cleanup for the Frankfurt migration: an `on auth.users insert` trigger auto-assigns super_admin
 * to the seeded email, which duplicated the super_admin row we also copied. This removes exact
 * duplicate user_roles (same user_id + role + salon_id), keeping one of each. Idempotent.
 *
 * Env: CREDS_FILE -> JSON { new: { host, port, user, password, db } }
 */
import { SQL } from "bun";

const c = JSON.parse(await Bun.file(process.env.CREDS_FILE!).text()).new;
const url = `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.db}?sslmode=require`;
const sql = new SQL(url);

const before = (await sql`SELECT count(*)::int AS n FROM public.user_roles`)[0].n;

const deleted = await sql`
  DELETE FROM public.user_roles ur
  USING (
    SELECT id, row_number() OVER (
      PARTITION BY user_id, role, salon_id ORDER BY created_at, id
    ) AS rn
    FROM public.user_roles
  ) dup
  WHERE ur.id = dup.id AND dup.rn > 1
  RETURNING ur.id`;

const after = (await sql`SELECT count(*)::int AS n FROM public.user_roles`)[0].n;
console.log(`user_roles: ${before} -> ${after} (removed ${deleted.length} duplicate(s))`);

await sql.end();
