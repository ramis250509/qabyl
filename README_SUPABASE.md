Where to get and how to apply Supabase Service Role and publishable keys

1) Copy keys from Supabase
- Open your Supabase project → Settings → API
- Copy the `URL` (project URL) and the `Service Role` key (labelled `service_role`)
- Copy the `anon (public)` key when you need the browser-safe key

2) Update server/runtime secrets (Cloudflare Workers, Node server)
- Cloudflare Workers (wrangler):
  - In PowerShell run:
    ```powershell
    echo "$(Get-Content -Raw -Path supabase_secret.txt)" | wrangler secret put SUPABASE_SERVICE_ROLE_KEY
    wrangler secret put SUPABASE_URL <<< "https://<your>.supabase.co"
    ```
  - Or use the Cloudflare dashboard: Workers → your Worker → Settings → Variables & Secrets → Add secret

- Cloudflare Pages / other hosts: add env vars in the project settings
  - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` go into runtime secrets
  - `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` go into build-time envs (for Vite)

3) Update Supabase Functions (Deno)
- In Supabase dashboard: Project → Settings → Environment
  - Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` so `Deno.env.get(...)` works inside functions

4) Rebuild frontend (important)
- Vite injects `VITE_` envs at build time. After you update `VITE_SUPABASE_PUBLISHABLE_KEY`, rebuild the static frontend.
- Example (project uses Bun):
  ```powershell
  bun install
  bun build
  ```
  or from npm scripts:
  ```powershell
  npm run build
  ```

5) Clear CDN / cache
- If you use Cloudflare in front of the site, purge the cache after deploying the new build so the new bundle is served.

6) Local quick test (service role key)
- Set envs and run the included script `scripts/test-supabase.mjs`:
  ```powershell
  $env:SUPABASE_URL="https://<your>.supabase.co"
  $env:SUPABASE_SERVICE_ROLE_KEY="<service_role_key>"
  node scripts/test-supabase.mjs
  ```
- Expected outcomes:
  - Success prints a sample row
  - Invalid key / auth error means the key is wrong or belongs to a different project

7) Notes & cautions
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser. Keep it only in runtime secrets.
- If you rotate/regenerate the Service Role key, update all services that use it and redeploy.

8) If you want me to run the local test here
- I cannot access your browser or Cloudflare UI from this environment. I can run `scripts/test-supabase.mjs` in the workspace if you paste the values here (NOT recommended), or you can run the test locally and paste output.
