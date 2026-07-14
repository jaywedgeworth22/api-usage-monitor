# Plan

Updated: 2026-07-14

## Objective

Correct PR #204's alert-persistence safety boundary and the disable/re-enable evidence-ordering defect without changing provider polling admission, Render configuration, production data, scheduler enablement, or OTLP enablement.

## Completed locally

1. Imported the relevant tracked and untracked corrective implementation from the idle `codex-alert-persistence-corrective` worktree onto fetched `origin/main` `2cf8ab0`; stale source planning/status/effort text was not copied.
2. Narrowed deferred alert maintenance to an operation-tagged final notification-summary timeout while preserving completed partial results and propagating persistence degradation into scheduler health.
3. Added incident, parent-operation, trigger-channel, and PagerDuty-resolve token/generation/lease fencing around external-call persistence boundaries.
4. Added `Provider.alertConfigGeneration` and `ProviderAlertNotification.evidenceConfigGeneration`; evidence now orders lexicographically by provider config revision, snapshot-or-epoch time, then state (`clear` wins an equal tuple).
5. Incremented the provider revision atomically with API edits to active state, refresh interval, or plan; agent-sync auto-disable; renewal roll-forward; and the Anthropic funding repair.
6. Fenced activation, resolution, channel claims/outcomes, notification summary, and close writes to the live provider revision plus parent operation.
7. Preserved monotonic detection/claim/outcome/close timestamps and immutable pre-change SQL migration coverage.
8. Added exact no-snapshot and unchanged-low-balance disable/re-enable regressions, a two-Prisma-client stale rev0 / disabled rev1 / re-enabled rev2 race, provider-route revision coverage, renewal coverage, and agent-sync auto-disable coverage.

## Remaining

1. Root hostile review of the imported corrective plus config-generation changes.
2. Address any review findings and rerun focused verification.
3. Run the serialized full Node 24 `npm run verify` gate only after review clearance.
4. Keep scheduler and OTLP disabled; do not push, open a PR, merge, deploy, change Render, call providers, read secrets, or write production data in this lane.
