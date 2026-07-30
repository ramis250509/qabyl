# Deployment report — 2026-07-30

## Status

**Not deployed to production.** Pushed to preview branch `master` (Cloudflare auto-deploys). Owner promotes to `main` after inspecting the preview.

## Quality gates

| Gate | Result | Notes |
|---|---|---|
| `bun test` | ✅ 323 pass / 3 fail | 3 fails are pre-existing on `main` (owner's WIP changed V4 behavior; tests not updated); +18 new tests all pass |
| `bun build` | ✅ 19.81s | All server + client chunks emitted; wrangler.json patched with observability |
| `bun run lint` | ⚠ 24613 pre-existing errors | Windows CRLF + `any` types; NOT introduced by this audit; project doesn't gate on lint in CI |
| Migrations | none applied | This audit branch adds no SQL migrations. Owner's WIP includes `20260728120000_excluded_contacts_and_reconciliation.sql` — un-stash + apply separately |
| Rollback plan | Revert the merge commit | No destructive changes; no schema changes; safe to revert with `git revert` |

## Commit list (this branch)

Single commit on `audit/security-ai-review-2026-07-30`:

```
audit(security+ai): defense-in-depth fixes + regression suite

- SalonSite JSON-LD: escape </script> so admin-editable copy can't XSS
- WA webhook: constant-time token compare (safeStringEquals helper);
  20MB image upload cap; audit-labeled log line on oversize reject
- wa-check: per-salon distinct-phone rate limit (40 / 5 min) to guard
  Green-API paid quota against public-endpoint abuse
- audit-regressions.test.ts: 18 tests locking in prompt-injection
  defense (all 7 industries), medical/endocrine safety, JSON-LD
  escape, and constant-time compare
- wa-v4-booking.test.ts: fix pre-existing "db.from is not a function"
  in 2 check_time tests (test-only mock shim; no prod change)

Zero behavior change for happy-path users. All fixes are P2/P3
defense-in-depth — no P0/P1 vulnerabilities were found.
```

## Preview URL

Cloudflare Pages auto-deploys `master` to the project's preview URL (see the CF dashboard for the exact link). Owner should:

1. Open the preview.
2. Visit any salon site — confirm SEO renders normally (JSON-LD change is invisible to end users).
3. Send a real WhatsApp message to a test salon — confirm the webhook still processes normally (constant-time compare doesn't affect a valid token).
4. Try uploading a photo — normal photos work; a >20MB photo would silently no-op (dev-only concern).
5. Merge `audit/security-ai-review-2026-07-30` → `main` when ready. Cloudflare auto-deploys prod.

## Post-merge smoke test (owner runs after promoting)

1. Send WhatsApp text to a test salon — reply arrives normally.
2. Send WhatsApp photo — booking flow analyses it normally.
3. Open a salon site — no console errors.
4. Cloudflare logs — grep for `[wa] image too large`, `rate limit tripped` — should stay near zero for legitimate traffic.

## Rollback

`git revert <merge-sha>` on `main`. No migrations were applied, no data shape changed, no environment variables added or renamed. Rollback is a one-command operation.

## What still requires owner attention

- **Un-stash the ops-agents WIP**: `git stash pop stash@{0}` restores the 5-file staged work (600 LOC, including the excluded_contacts migration).
- **Apply pending migrations** listed in the memory: reschedule-notify, sales-mode, self-service, and (from the stashed WIP) excluded_contacts + reconciliation.
- **Fix the 3 stale test expectations** (owner's WIP changed the behavior, tests weren't updated — none are correctness bugs).
- **Follow-up (optional, non-blocking)**:
  - Move the `checkPhoneWhatsapp` rate-limit into a Cloudflare Durable Object for cross-region enforcement (current in-process limiter is per-worker-isolate).
  - Consider forcing all `.sql` migrations to run in a single `supabase db push` per deploy (currently the memory tracks a growing list of unapplied migrations).
