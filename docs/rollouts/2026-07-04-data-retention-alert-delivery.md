# 2026-07-04 — data retention + provider alert delivery

## Summary
- Implemented scheduled SQLite retention for `UsageSnapshot` and `ExternalUsageEvent` with daily
  rollups, raw-row pruning, and tombstones for pruned external idempotency keys.
- Added first outbound provider-alert delivery path via optional Slack/webhook env vars with
  reminder dedupe and resolution tracking.
- Updated read paths so `/api/snapshots`, `/api/usage-events`, and budget math stay correct after
  raw history is compacted.

## Why
- The app runs on a single Render web service with a 1 GB SQLite disk and 15-minute polling plus
  pushed telemetry; unbounded raw growth was a real operational risk.
- `provider-alerts.ts` already computed actionable budget/balance/staleness state, but nothing
  delivered it outside the dashboard.

## Files
- `.env.example`
- `DEPLOY.md`
- `docs/EFFORT-LOG.md`
- `render.yaml`
- `prisma/schema.prisma`
- `src/app/api/cron/fetch-all/route.ts`
- `src/app/api/ingest/usage/route.ts`
- `src/app/api/otlp/v1/__tests__/metrics-route.test.ts`
- `src/app/api/otlp/v1/metrics/route.ts`
- `src/app/api/snapshots/route.ts`
- `src/app/api/usage-events/route.ts`
- `src/lib/__tests__/alert-delivery.test.ts`
- `src/lib/__tests__/retention-integration.test.ts`
- `src/lib/__tests__/setup-test-db.ts`
- `src/lib/__tests__/usage-retention.test.ts`
- `src/lib/alert-delivery.ts`
- `src/lib/data-retention.ts`
- `src/lib/external-usage-events.ts`
- `src/lib/budget-status.ts`
- `src/lib/usage-maintenance.ts`
- `src/lib/usage-recorder.ts`
- `src/lib/usage-retention.ts`
- `vitest.config.ts`

## Verification
- `npx prisma generate`
- `npm test -- src/lib/__tests__/usage-retention.test.ts src/lib/__tests__/retention-integration.test.ts src/lib/__tests__/alert-delivery.test.ts`
- `npx tsc --noEmit`
- `npm test`
- `npm run lint`
- `npm run build`

## Notes
- `npm run build` failed once with an `.next` rename/trace collection `ENOENT`; removing the
  generated `.next` directory and rerunning completed cleanly.
- Full-suite Prisma-backed tests now share an atomic cached SQLite schema script so concurrent
  Vitest workers do not race while creating throwaway databases.
- The live effort board mirror at `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` and repo mirror
  both mark the CODEX retention/pruning and alert-delivery rows completed.

## Follow-ups
- Optional later extension: add provider-backed Resend/Pushover delivery channels if env-based
  Slack/webhook delivery is not enough.
