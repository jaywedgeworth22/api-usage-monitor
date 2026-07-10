# 2026-07-10 — fix deploy-blocking `migrate-safe.mjs` `--dry-run` crash

## Summary
- `scripts/migrate-safe.mjs` ran `npx prisma db push --dry-run` as a pre-check before every
  schema push once the Render disk already had a DB file. `--dry-run` is not a supported flag on
  the pinned Prisma version (`6.19.3`; `npx prisma db push --help` lists only `-h/--help`,
  `--config`, `--schema`, `--accept-data-loss`, `--force-reset`, `--skip-generate`), so that
  pre-check crashed unconditionally — before it ever checked whether there was an actual schema
  diff. `scripts/start-with-litestream.sh` runs `migrate-safe.mjs` unconditionally on every deploy
  once the disk has a DB file, so this would have broken the *next* Render autodeploy of this app
  regardless of whether that deploy touched `prisma/schema.prisma`. Only the very-first-deploy
  (`dbExists === false`) path was unaffected.
- Fixed by dropping the broken dry-run pre-check and its destructive-pattern text parsing
  entirely, and trusting a plain `npx prisma db push` (no `--accept-data-loss`) directly. Verified
  locally that Prisma's own built-in guard already implements the intended safety behavior more
  precisely than the removed heuristic: it checks actual row counts, not schema-shape text
  patterns, so it applies additive changes and no-diff pushes cleanly (exit 0) and refuses any
  change that would genuinely drop or truncate non-empty data (exit non-zero, `--accept-data-loss`
  required, nothing applied) — regardless of whether that change is "structurally" a table/column
  recreation. The old regex-based parser would have flagged *any* SQLite table recreation as
  destructive even when the recreated table was empty, which is a strictly worse (more false
  positives) approximation of the same thing Prisma already does correctly.
- Added `scripts/test-migrate-safe-repro.mjs`, a self-contained manual repro/integration test that
  exercises the real (unmodified) `scripts/migrate-safe.mjs` against real SQLite DB files for three
  scenarios: additive-only diff (old-shape DB, built from `schema.prisma` at an earlier git
  revision, pushed against current `schema.prisma`), already-in-sync no-op, and a destructive diff
  against a DB seeded with real rows in the dropped table/column. Run with:
  `node scripts/test-migrate-safe-repro.mjs`. It temporarily overwrites the real
  `prisma/schema.prisma` for the destructive scenario only, restores it from a backup in a
  `try`/`finally`, and refuses to run at all if that file has uncommitted changes going in.

## Why
- Discovered while verifying PR #83 (subscription→knob linkage): confirmed the additive schema
  change in that PR applies cleanly via plain `prisma db push` against an old-shape DB, then found
  the pre-existing `--dry-run` crash while checking the actual deploy path this repo uses. Flagged
  prominently in PR #83's description as a separate, pre-existing, deploy-blocking bug (dates to
  the script's introduction on 2026-07-04) rather than fixed there, since it was out of that PR's
  scope. This PR is the dedicated follow-up.
- Urgency: this blocks *any* future Render autodeploy of the app once the disk already has a DB —
  not just schema-touching ones — so it needed to land ahead of / independently from PR #83.

## Files
- `scripts/migrate-safe.mjs`
- `scripts/test-migrate-safe-repro.mjs` (new)
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-10-migrate-safe-dry-run-fix.md` (this file)

## Verification
- Reproduced the original bug: `npx prisma db push --dry-run` against a real SQLite DB prints
  `unknown or unexpected option: --dry-run` and exits 1, confirmed against the exact pinned
  version (`prisma@6.19.3`, confirmed in `package-lock.json` and `npx prisma db push --help`).
- `node scripts/test-migrate-safe-repro.mjs` — all three scenarios (additive, no-op, destructive)
  pass against the fixed script.
- `npm run lint` (`tsc --noEmit`) — clean.
- `npm test` — 84 passed / 30 skipped across the files runnable in this sandbox; 6 files that
  depend on a `sqlite3` CLI binary for test-DB setup (`src/lib/__tests__/setup-test-db.ts`) failed
  with `spawnSync sqlite3 ENOENT` — confirmed via `git stash` that this failure is pre-existing on
  unmodified `main` (the sandbox has no `sqlite3` binary installed and couldn't install one via
  `apt-get` due to a network 404), unrelated to this change.
- `npm run build` — clean.

## Notes
- Working from a cloud sandbox (`/home/user/api-usage-monitor`), not the owner's local
  `/Users/jay/Code/API-usage-monitor` checkout, so the live effort board at
  `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` was not reachable from this session — only the
  in-repo mirror (`docs/EFFORT-LOG.md`) was updated. Reconcile the live board against this entry
  next time an agent with access to `/Users/jay/apps` picks this up.
- This PR is independent of and does not depend on PR #83 — it should be safe to land first.

## Follow-ups
- None expected. This restores `migrate-safe.mjs` to a working, arguably more-correct-than-before
  safety gate; no further action needed once merged and deployed.
