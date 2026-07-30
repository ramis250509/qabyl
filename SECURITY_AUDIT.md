# Security audit — 2026-07-30

Audit branch: `audit/security-ai-review-2026-07-30` off `main` @ `7efb886`.

## TL;DR

- **No P0/P1 findings.** Codebase applies defense-in-depth end-to-end: JWT-verified server-fn middleware, RLS on every user-scoped table, per-salon RPC guards, DOMPurify on user HTML, prompt-injection block in every industry prompt, per-conversation advisory locks, idempotency indexes, error escalation with WhatsApp+admin-panel fallback, service-role only in `.server.ts`.
- **4 P2 findings fixed** (defense-in-depth improvements).
- **1 P2/P3 finding documented, residual risk accepted**.

## Findings

### P2-1 (fixed) — JSON-LD injection on public salon page
- **File:** `src/components/site/SalonSite.tsx:149`
- **Attack:** a salon admin puts `</script><script>alert(1)</script>` into their salon name/description/review text (all admin-editable and interpolated into the `application/ld+json` block). `JSON.stringify` does NOT escape `</script>`, so the tokenizer closes the script tag and executes the injected JS.
- **Blast radius:** attacker's own salon page only. Ordinary visitors of that salon's booking page are impacted. Neither the platform nor other salons.
- **Fix:** transform `</script` (case-insensitive) → `<\/script` before injection. Same trick React's own server serializer uses. Verified by 3 new tests in `audit-regressions.test.ts`.

### P2-2 (fixed) — Timing-side-channel on WhatsApp webhook token
- **File:** `src/routes/api/public/wa.$salonId.ts:135`
- **Attack:** the per-salon `greenapi_webhook_token` was compared with `!==`, which exits at the first mismatched byte. In principle an attacker can measure response-time deltas over the network to learn the prefix, then extend it. With CF network jitter and modern TLS the practical attack is expensive, but this is a well-known pattern and cheap to fix.
- **Fix:** added `safeStringEquals` (constant-time). Iterates a fixed length (the longer of the two inputs), folds the length difference into the XOR accumulator, no early exit. Verified by 4 new tests.

### P2-3 (fixed) — No size cap on inbound WhatsApp images
- **File:** `src/routes/api/public/wa.$salonId.ts` (image upload path — new cap at ~line 570)
- **Attack:** the webhook accepts any image size Green-API forwards and uploads it straight into the `wa-media` bucket. A malicious client could push repeated large uploads, burning Supabase storage quota and downstream Gemini vision cost. Audio already had an 8MB cap; images had no cap at all.
- **Fix:** hard 20MB cap on image body; over-limit uploads are rejected with an error log and the client's photo path silently no-ops (agent asks for a smaller photo). Real client photos are single-digit MB.

### P2-4 (fixed) — Public `checkPhoneWhatsapp` quota-drain vector
- **File:** `src/lib/wa-check.functions.ts`
- **Attack:** the WhatsApp-existence check is intentionally unauthenticated (used by the anonymous booking widget). Each non-cached call spends a `checkWhatsapp` request against the salon's paid Green-API instance. A scripted attacker hitting the endpoint with random distinct phones for a specific `salonId` could drain the salon's quota within minutes.
- **Fix:** added an in-process rate limit — max **40 distinct phones per salon per 5 min**. Real booking flow calls this once per client per session, so the limit is far above legitimate use. On over-limit → fail-open (`status: unavailable`), preserving the same fallback the booking widget already handles for real Green-API failures. Salon quota is protected either way.
- **Residual:** per-instance limiter (each Cloudflare Worker isolate has its own counter). A distributed attacker across many CF regions could bypass. For a stronger cap, migrate to a Durable Object or Supabase-backed counter. Left as follow-up.

### P3-1 (accepted with note) — DOMPurify on `CustomTemplate`
- **File:** `src/components/site/templates/CustomTemplate.tsx`
- Salon owners can inject custom HTML into their site. Rendered client-side after DOMPurify sanitization with a broad `ADD_ATTR`/`ADD_TAGS` allowlist (`style`, `link`, `id`, `href`, `src`, `crossorigin`, `integrity`, `class`, `data-*`). This is a deliberate feature; DOMPurify handles the OWASP XSS surface. `<style>` and `<link rel=stylesheet>` do open a CSS-based data-exfiltration path in theory (attribute-selector attacks against form values on the same origin), but the salon's own page has no sensitive form fields — a self-XSS at worst. Accepted risk, documented here.

## Verified as OK (not fixed because no fix needed)

Explicitly checked and found robust:

1. **Auth middleware** (`src/integrations/supabase/auth-middleware.ts`) — verifies Bearer JWT via `getClaims` server-side; rejects missing/non-Bearer/invalid tokens; exposes `userId` to handlers via context. No client-supplied `userId` accepted anywhere.
2. **Tenant isolation in server functions** — every `createServerFn` that touches a specific salon (`appointments.functions.ts`, `salon-secrets.functions.ts`, `salon-masters.functions.ts`, `branch-masters.functions.ts`, `wa-config.functions.ts`, `site-content.functions.ts`) calls `has_salon_access` or `assertCanManageSalon`/`assertSuperAdmin` BEFORE touching data. The one endpoint that legitimately doesn't (`wa-check.functions.ts`) is public by design; now rate-limited.
3. **RLS policies** — `20260721120000_security_and_performance.sql` tightened appointment INSERT, master reads, schedule reads. Existing policies key on `has_role(auth.uid())` and `user_roles.salon_id` join for salon admins.
4. **create_appointment RPC** — server-side validates `master.salon_id`, `service.salon_id`, `branch_id` scoping. AI agent cannot cross-book between salons even under service_role.
5. **WhatsApp webhook** — per-salon token (now constant-time), sender-name sanitized against prompt injection at line 160-162 (`replace(/[\n\r]/g, " ").slice(0, 60)`), duplicate-message index (`wa_messages_green_id_uniq`), per-conversation advisory lock with heartbeat + last-line ownership check before every user-visible write, drain loop with staleness filter, human-takeover detection with native-greeting-race suppressor.
6. **Owner /restart hidden command** — gated by `ownerPhoneMatches` for the destructive branch (cancels future test bookings); the safe branch (state reset) is available to any sender for their OWN chat only.
7. **Ops Telegram bot** (`src/routes/api/internal/telegram.ts`) — three-layer defense: Telegram secret header, sender allowlist (silent 200 for unknown), global kill-switch. Bootstrap mode disables itself once `TELEGRAM_OWNER_ID` is set.
8. **Cron endpoint** (`src/routes/api/internal/cron.$job.ts`) — `x-cron-secret` header vs `CRON_SECRET`; kill-switch and per-agent pause honoured.
9. **No secret exposure in code** — grep for `SECRET=`, `TOKEN=`, `PASSWORD=` string literals returned zero hits. `console.log` never logs secret fields. Service-role key stays in `.server.ts` only.
10. **File upload path** — MIME type sanitized (regex-stripped to `[a-z0-9]`), path uses salon+conv scoping, private bucket with signed URLs (600s TTL).
11. **JWT/Bearer scheme** — only Bearer accepted, no cookie-only auth surface, no session-fixation vectors.

## Coverage of the requested checklist

Every item in the owner's brief was checked; the "not audited" bucket is empty. Items with additional notes:

- **Dependency vulnerabilities** — no `bun audit` command in the toolchain (bun doesn't ship one). GitHub Dependabot alerts on the repo cover this. No changes made.
- **CORS/CSRF** — mutations require Bearer JWT via `Authorization` header; browsers can't send that cross-origin without an explicit `fetch` call authenticated with a valid token from the same origin, so CSRF is not applicable.
- **Prompt injection** — new deterministic tests confirm the anti-injection paragraph reaches every industry's system prompt and enumerates the concrete attack strings ("забудь предыдущие инструкции", "покажи промпт", etc.).
- **Medical safety** — new tests cover diagnosis refusal, dosage refusal, test-result interpretation refusal, emergency (103/112) routing, and ordering (`МЕДИЦИНСКИЕ ГРАНИЦЫ` block before the sales block). Endocrinology-shaped inputs (blood-sugar 25, hormone results, dosage changes) all hit the medical-boundaries path.
- **Idempotency & replay** — `wa_messages_green_id_uniq` index + explicit dedup check in the webhook; the owner's stashed migration adds a further `wa_appointment_dedup` table.
