# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Qabyl** — an online booking platform for beauty salons targeting CIS markets (Kyrgyzstan, Kazakhstan, Russia). The UI language in admin panels and most strings is Russian, with Kyrgyz and English also supported via the i18n layer.

## Commands

```bash
bun dev          # dev server with HMR
bun build        # production build
bun lint         # ESLint
bun format       # Prettier
```

There is no test suite. There is no single-file test runner command.

## Stack

- **TanStack Start** (SSR React framework) + **TanStack Router** (file-based routing)
- **Supabase** — auth, database (Postgres), storage
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **shadcn/ui** components under `src/components/ui/`
- **Bun** as package manager and runtime
- **Vite 7** as bundler via `@lovable.dev/vite-tanstack-config`

## Architecture

### File-based routing (`src/routes/`)

Every `.tsx` file is a route. `routeTree.gen.ts` is **auto-generated** — never edit it. Key conventions from `src/routes/README.md`:
- Dynamic params use bare `$`: `users/$id.tsx` → `/users/:id`
- Layouts use `_layout.tsx` and render children via `<Outlet />`
- `__root.tsx` is the single app shell — wraps every page

Current routes:
- `/` → landing / index
- `/auth` → sign-in/sign-up
- `/book/$slug` → public booking widget (slug = salon)
- `/admin` → admin layout (sidebar, auth guard, role dispatch)
- `/admin/salons/$salonId` → full salon config (services, masters, branches, site, etc.)
- `/admin/calendar`, `/admin/stats`, `/admin/notifications`
- `/api/public/wa/$salonId` → WhatsApp webhook receiver (POST only, secured by per-salon token)
- `/preview/salon.$salonId` → salon site preview

### Server functions (`src/lib/*.functions.ts`)

Business logic exposed to the client uses `createServerFn` from `@tanstack/react-start`. Pattern:
```ts
export const myFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({...}).parse(input))
  .handler(async ({ data, context }) => { ... });
```
`context.userId` is the authenticated user's ID, injected by `requireSupabaseAuth` middleware.

### Supabase clients

| Import | When to use |
|---|---|
| `import { supabase } from "@/integrations/supabase/client"` | Client-side (browser), respects RLS |
| `import { supabaseAdmin } from "@/integrations/supabase/client.server"` | Server-only, **bypasses RLS** — service role key |

`client.server.ts` uses a lazy Proxy; only import it inside server code (`.server.ts` files, `createServerFn` handlers, route `server.handlers`).

### Auth and roles

`useAuth()` from `src/lib/auth-client.ts` returns: `{ user, loading, rolesLoading, isSuperAdmin, isSalonAdmin, isMaster, salonId, branchId }`.

Roles stored in `public.user_roles`:
- `super_admin` — platform-wide access; manages all salons
- `salon_admin` — access to one salon
- `master` — calendar-only, scoped to a branch

The `/admin` layout gate reads these flags and redirects masters straight to `/admin/calendar`.

### WhatsApp AI assistant

`src/lib/wa-agent.server.ts` + `src/routes/api/public/wa.$salonId.ts` implement a stateful booking assistant over WhatsApp (via Green-API).

Key design decisions:
- **State machine** in TypeScript (not tool-loop): Gemini classifies intent, deterministic TS code drives slot/master selection
- **Direct Gemini REST** (`gemini-2.5-flash`), not Lovable AI Gateway, for this path
- Per-conversation **advisory lock** via Supabase RPC (`wa_try_acquire_lock` / `wa_release_lock`) to serialize parallel Green-API webhooks
- State persisted in `wa_conversations.state` + `state_data` columns
- Unprocessed inbound messages drained in a loop (max 3 iterations) inside the lock window

States: `idle → awaiting_branch → collecting → awaiting_photo → awaiting_price_confirm → awaiting_part_of_day → awaiting_slot_choice → awaiting_master_choice → awaiting_name → booking → done`

### i18n

`src/lib/i18n.tsx` — flat DICT with `ru | ky | en` keys. Use `useT()` hook to get `{ t, lang, setLang }`. Language is stored in `localStorage`. Pass `forceLang` to `<I18nProvider>` to override (used in public salon pages). Adding a new string: add it to `DICT` in this file.

### Vite config

`vite.config.ts` imports `defineConfig` from `@lovable.dev/vite-tanstack-config`, which **already bundles**: TanStack Start, React plugin, Tailwind, tsconfig paths, Nitro, componentTagger, `@` path alias, and env injection. **Do not add these plugins manually** — doing so breaks the build with duplicate plugin errors.

### Environment variables

Client-side vars are prefixed `VITE_`. Server-side vars (no prefix) are read via `process.env`. Key vars:
- `VITE_SUPABASE_URL` / `SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, not in `.env` by default (set in Lovable Cloud)
- `GEMINI_API_KEY` — used by the WA agent (`src/lib/wa-agent.server.ts`)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — web push notifications
