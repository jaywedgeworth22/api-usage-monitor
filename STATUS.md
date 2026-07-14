# Status

Updated: 2026-07-14

## Current state

- Work is isolated on `codex/alert-persistence-config-generation` in `/Users/jay/.codex/worktrees/api-usage-monitor-alert-persistence-config-generation`, based on fetched `origin/main` `2cf8ab0`.
- Fetched `origin/main` has since advanced to `0420eb0` (#209, Anthropic individual-account boundary). The branch is ahead 1 / behind 1 and must be deliberately rebased after hostile re-review while preserving #209's snapshot-capability behavior.
- PR #204 (`56d532ec`) remains the production code path; no branch push, PR, merge, deploy, Render/config/provider/production mutation, provider call, or secret read occurred here.
- Scheduler and OTLP metrics ingest remain disabled while alert persistence and shared writer admission are reviewed separately.

## Implementation

- The relevant corrective source paths were deliberately replayed from `/Users/jay/apps/api-usage-monitor-alert-persistence-corrective`; current-main provider route changes were preserved. Source `PLAN.md`, `STATUS.md`, and `docs/EFFORT-LOG.md` were inspected but not copied.
- Alert delivery uses durable incident, evidence, parent-operation, trigger, and resolve generations with conditional writes around every external boundary. Activation refresh/reopen now mutates evidence and payload only in the same CAS that owns the parent lease.
- Provider configuration changes that can alter alert evaluation without a new snapshot advance `Provider.alertConfigGeneration` atomically. Notifications persist config generation, source observation time, transition time, and state. For `stale_snapshot`, a newer source snapshot wins even if an older snapshot has a later stale deadline; the unchanged snapshot can still recur when it crosses its own deadline.
- Parent and child claims/outcomes verify exact config, source/transition evidence, severity/message, parent generation, and child generation. A stale rev0 worker cannot trigger after disable rev1 and re-enable rev2; a newer activation can preempt a resolver/trigger parent only before that parent owns a live child claim.
- Severity policy controls delivery eligibility without falsely resolving raw active incidents. Complete durable per-channel success repairs a later missing aggregate summary without resending. Reopen detection times cannot precede prior resolution, evidence, or the actual claim clock.
- Existing providers and notifications migrate at revision 0. The checked-in pre-change SQL fixture proves both defaults plus legacy uncertainty survive `scripts/migrate-safe.mjs`.
- Existing timestamp monotonicity, provider-loop completion, partial-result, and scheduler-health repairs from the corrective source remain intact.

## Verification so far

- Node `v24.18.0`; `npm ci` completed with 0 vulnerabilities and generated Prisma Client 6.19.3.
- Focused Node 24 Vitest after hostile remediation: 8 files / 72 tests passed across alert delivery, maintenance, scheduler health, immutable migration, provider route, renewal, agent-sync, and provider routing; alert delivery plus migration is 40/40.
- Scoped ESLint passed; `npm run typecheck` passed; Prisma validation passed with an inert local SQLite URL; `git diff --check` passed.
- Full `npm run verify` has not run; root hostile re-review and serialized-gate coordination remain required.
