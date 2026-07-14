# Status

Updated: 2026-07-14

## Current state

- Work is isolated on `codex/alert-persistence-config-generation` in `/Users/jay/.codex/worktrees/api-usage-monitor-alert-persistence-config-generation`, based on fetched `origin/main` `2cf8ab0`.
- PR #204 (`56d532ec`) remains the production code path; no branch push, PR, merge, deploy, Render/config/provider/production mutation, provider call, or secret read occurred here.
- Scheduler and OTLP metrics ingest remain disabled while alert persistence and shared writer admission are reviewed separately.

## Implementation

- The relevant corrective source paths were deliberately replayed from `/Users/jay/apps/api-usage-monitor-alert-persistence-corrective`; current-main provider route changes were preserved. Source `PLAN.md`, `STATUS.md`, and `docs/EFFORT-LOG.md` were inspected but not copied.
- Alert delivery uses durable incident, evidence, parent-operation, trigger, and resolve generations with conditional writes around every external boundary.
- Provider configuration changes that can alter alert evaluation without a new snapshot advance `Provider.alertConfigGeneration` atomically. Notifications persist `evidenceConfigGeneration`; comparisons use config revision first, then snapshot/no-snapshot evidence time, then active/clear state.
- Parent and child claims/outcomes verify both the exact operation generation and the live provider config generation. A stale rev0 worker cannot trigger after disable rev1 and re-enable rev2.
- Existing providers and notifications migrate at revision 0. The checked-in pre-change SQL fixture proves both defaults plus legacy uncertainty survive `scripts/migrate-safe.mjs`.
- Existing timestamp monotonicity, provider-loop completion, partial-result, and scheduler-health repairs from the corrective source remain intact.

## Verification so far

- Node `v24.18.0`; `npm ci` completed with 0 vulnerabilities and generated Prisma Client 6.19.3.
- Focused Node 24 Vitest: 8 files / 67 tests passed across alert delivery, maintenance, scheduler health, immutable migration, provider route, renewal, agent-sync, and provider routing.
- Follow-up changed-path Vitest after timestamp hardening: 4 files / 39 tests passed.
- Scoped ESLint passed; `npx tsc --noEmit` passed; Prisma validation passed with an inert local SQLite URL; `git diff --check` passed.
- Full `npm run verify` has not run; root hostile review and serialized-gate coordination remain required.
