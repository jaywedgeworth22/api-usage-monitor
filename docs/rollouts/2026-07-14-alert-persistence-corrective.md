# Alert-persistence corrective and config-generation fencing

## Summary

PR #204 (`56d532ec`) isolated an exact Prisma model/code timeout, but post-merge review showed that boundary still covered unsafe notification operations and that alert/channel state lacked durable fencing across external calls. A later reproduction found a separate ordering defect: disabling a provider resolved snapshot-based alerts with newer wall-clock evidence, so re-enabling against the same snapshot—or no snapshot—could not reopen them.

This isolated follow-up imports the corrective alert persistence implementation onto current main and adds a monotonic provider alert-config revision. Alert evidence is now the tuple `(config generation, snapshot-or-epoch time, state)`, ordered lexicographically with `clear` winning an exact tie. Deliberate configuration transitions therefore supersede unchanged snapshot evidence without weakening stale-worker suppression.

## Design

- `AlertNotificationSummaryPersistenceTimeout` is emitted only for exact `P1008` at the final CAS-protected notification summary write. Earlier notification/channel failures remain fatal or explicitly degraded according to the precise operation.
- Notification incidents, parent operations, channel triggers, and PagerDuty resolves use durable tokens, generations, incident IDs, and bounded leases. Child claims/outcomes, final summary, and close writes prove the live parent operation and open incident.
- Ambiguous non-idempotent sends remain unknown and are not blindly retried; PagerDuty uses a persisted per-incident dedup key and conservative legacy audit state.
- `Provider.alertConfigGeneration` and `ProviderAlertNotification.evidenceConfigGeneration` default to 0 for additive migration. `operationClaimConfigGeneration` binds each parent lease to the provider revision it evaluated.
- Provider active-state, refresh-interval, and plan writes increment the revision inside the same provider update. Renewal roll-forward uses one Prisma transaction for the conditional plan write plus revision increment. Agent-sync auto-disable and the Anthropic funding repair also increment atomically.
- Activation checks the provider revision before and after first creation; every later notification CAS includes the provider relation revision. Trigger/resolve claims and outcomes, summary, and close writes carry the same fence.
- Evidence time remains the latest snapshot for snapshot-derived alerts and the epoch for no-snapshot observations. Configuration revision outranks that time, while the existing active/clear tie-break and monotonic `lastDetectedAt` prevent stale overwrite.

## Files changed

- `prisma/schema.prisma`
- `src/lib/alert-delivery.ts`
- `src/lib/usage-maintenance.ts`
- `src/lib/usage-recorder.ts`
- `src/app/api/providers/[id]/route.ts`
- `src/lib/provider-renewals.ts`
- `src/lib/ensure-agent-sync-provider.ts`
- `scripts/repair-anthropic-funding.mjs`
- alert, maintenance, migration, provider-route, renewal, agent-sync, and adapter tests/fixtures
- `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, and rollout notes

## Verification

Using Node `v24.18.0` explicitly:

- `npm ci` — completed; 0 vulnerabilities; Prisma Client 6.19.3 generated.
- Focused Vitest — 8 files / 67 tests passed.
- Changed-path follow-up Vitest — 4 files / 39 tests passed.
- Scoped ESLint — passed.
- `npx tsc --noEmit` — passed.
- `DATABASE_URL='file:/tmp/api-usage-monitor-alert-config-validate.db' npx prisma validate` — passed.
- `git diff --check` — passed.
- Full `npm run verify` — pending root hostile review and serialized gate coordination.

## Production impact and follow-ups

None from this local branch. Scheduler and OTLP remain disabled. No push, PR, merge, deploy, Render/config/provider/database mutation, provider call, production write, or secret read occurred. Root review must clear the combined implementation before a serialized full gate or any publication decision.
