# Plan

Updated: 2026-07-14

## Objective

Correct PR #204's alert-persistence safety boundary and the disable/re-enable evidence-ordering defect without changing provider polling admission, Render configuration, production data, scheduler enablement, or OTLP enablement.

## Completed locally

1. Imported the relevant tracked and untracked corrective implementation from the idle `codex-alert-persistence-corrective` worktree onto fetched `origin/main` `2cf8ab0`; stale source planning/status/effort text was not copied.
2. Narrowed deferred alert maintenance to an operation-tagged final notification-summary timeout while preserving completed partial results and propagating persistence degradation into scheduler health.
3. Added incident, parent-operation, trigger-channel, and PagerDuty-resolve token/generation/lease fencing around external-call persistence boundaries.
4. Added `Provider.alertConfigGeneration` and versioned notification evidence. Evidence now orders lexicographically by provider config revision, source observation time, transition time, then state (`clear` wins an exact tie). `stale_snapshot` therefore records both the source snapshot and its deterministic stale deadline.
5. Incremented the provider revision atomically with API edits to active state, refresh interval, or plan; agent-sync auto-disable; renewal roll-forward; and the Anthropic funding repair.
6. Fenced activation, resolution, channel claims/outcomes, notification summary, and close writes to the live provider revision plus parent operation.
7. Preserved monotonic detection/claim/outcome/close timestamps and immutable pre-change SQL migration coverage.
8. Added exact no-snapshot and unchanged-low-balance disable/re-enable regressions, a two-Prisma-client stale rev0 / disabled rev1 / re-enabled rev2 race, provider-route revision coverage, renewal coverage, and agent-sync auto-disable coverage.
9. Atomically paired activation refresh/reopen with the parent operation lease; exact child claims block parent preemption across the external boundary, while newer evidence can safely preempt a parent before any child claim.
10. Separated raw alert activity from minimum-severity delivery eligibility, repaired aggregate summary state from complete durable channel success, and floored reopen timestamps against prior resolution, evidence, and actual clock.
11. Added hostile regressions for resolver S2 versus newer active S3, stale trigger payload, stale-snapshot recurrence, severity-policy raise/lower, summary repair without resend, and delayed newer-evidence reopen.
12. Rebased onto `origin/main` `0420eb0`, retained #209's `providerPollSnapshotExpected` behavior, and added atomic revision bumps for API-key, public/secret config, and secret-clear edits that can change snapshot capability.
13. Added an Anthropic Admin-capability true -> false -> true regression proving the unchanged no-snapshot epoch resolves and reopens at config generation 2.

## Remaining

1. Commit the reviewed current-main integration without behavior drift.
2. Run the claimed serialized full Node 24 `npm run verify` gate.
3. Publish through a PR, require hosted checks, squash-merge, and verify the exact Render production revision plus health.
4. Keep scheduler and OTLP disabled throughout; do not call providers, read secrets, or write production data in this lane.
