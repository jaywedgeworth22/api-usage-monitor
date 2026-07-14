# Status

Updated: 2026-07-14

## Current state

- Work is isolated on `codex/alert-persistence-config-generation` in `/Users/jay/.codex/worktrees/api-usage-monitor-alert-persistence-config-generation`, rebased onto fetched `origin/main` `0420eb0` (#209, Anthropic individual-account boundary).
- The branch has two unpublished commits (`c7f79a4`, `2c8ae64`) plus an uncommitted current-main integration correction frozen for fresh hostile review.
- Fresh hostile review of frozen diff `b1061e12b11c4078e048832d4a81e14423619e4a0a22140c65624b5a77bf8b0c` returned LAND with no P0-P2. CODEX claimed the idle API Usage Monitor serialized full-gate slot in `#agent-sync`.
- PR #204 (`56d532ec`) remains the production code path; no branch push, PR, merge, deploy, Render/config/provider/production mutation, provider call, or secret read occurred here.
- Scheduler and OTLP metrics ingest remain disabled while alert persistence and shared writer admission are reviewed separately.

## Implementation

- The relevant corrective source paths were deliberately replayed from `/Users/jay/apps/api-usage-monitor-alert-persistence-corrective`; current-main provider route changes were preserved. Source `PLAN.md`, `STATUS.md`, and `docs/EFFORT-LOG.md` were inspected but not copied.
- Alert delivery uses durable incident, evidence, parent-operation, trigger, and resolve generations with conditional writes around every external boundary. Activation refresh/reopen now mutates evidence and payload only in the same CAS that owns the parent lease.
- Provider configuration changes that can alter alert evaluation without a new snapshot advance `Provider.alertConfigGeneration` atomically. Notifications persist config generation, source observation time, transition time, and state. For `stale_snapshot`, a newer source snapshot wins even if an older snapshot has a later stale deadline; the unchanged snapshot can still recur when it crosses its own deadline.
- Alert delivery retains #209's `providerPollSnapshotExpected` capability calculation. API-key, public/secret config, and secret-clear updates now advance the same provider revision atomically, so Anthropic Admin capability false -> true cannot leave an equal-generation no-snapshot clear suppressing recurrence.
- Parent and child claims/outcomes verify exact config, source/transition evidence, severity/message, parent generation, and child generation. A stale rev0 worker cannot trigger after disable rev1 and re-enable rev2; a newer activation can preempt a resolver/trigger parent only before that parent owns a live child claim.
- Severity policy controls delivery eligibility without falsely resolving raw active incidents. Complete durable per-channel success repairs a later missing aggregate summary without resending. Reopen detection times cannot precede prior resolution, evidence, or the actual claim clock.
- Existing providers and notifications migrate at revision 0. The checked-in pre-change SQL fixture proves both defaults plus legacy uncertainty survive `scripts/migrate-safe.mjs`.
- Existing timestamp monotonicity, provider-loop completion, partial-result, and scheduler-health repairs from the corrective source remain intact.

## Verification so far

- Node `v24.18.0`; `npm ci` completed with 0 vulnerabilities and generated Prisma Client 6.19.3.
- Focused Node 24 Vitest after rebase and capability integration: 9 files / 75 tests passed across alert delivery, provider alerts, maintenance, timeout budget, immutable migration, provider route, renewal, agent-sync, and provider routing. The core alert/provider integration subset is 4 files / 46 tests.
- Scoped ESLint passed; `npm run typecheck` passed; Prisma validation passed with an inert local SQLite URL; `git diff --check` passed.
- Full `npm run verify` is the active next gate; publication and exact Render production verification remain after it passes.
