# Oracle Always Free migration candidate

## Summary

- Adds an ARM64-compatible, checksum-pinned Litestream install path.
- Adds a Docker Compose + Caddy deployment for the Oracle Ampere A1 host. The
  app refuses to start unless the separate `/data` block volume is mounted.
- Adds strict readiness transport semantics at `/api/ready?strict=1` for an
  external monitor while preserving the historical HTTP 200 liveness contract.
- Moves ingest admission ahead of request-body decoding so concurrent retry
  storms are rejected before allocating or parsing multi-megabyte payloads.
- Splits comma-delimited LlamaParse credentials into independently encrypted,
  stable provider rows with per-key previews and server-only fingerprints.
- Defines the Coolify Garage service used as the Oracle database's separate
  Litestream S3 replica. It does not share Render's R2 replica.

## Infrastructure

- Oracle shape: `VM.Standard.A1.Flex`, 2 OCPU, 12 GB RAM.
- Persistent data: separate 100 GB block volume mounted at `/data`.
- Candidate URL: `https://usage-oracle.132.226.90.164.sslip.io`.
- Coolify backup endpoint: the Garage S3 hostname managed by the
  `usage-monitor-backups` service; credentials remain only in protected runtime
  configuration.
- Production `usage.jays.services` and its Render service remain the rollback
  source until the sole-writer cutover and restore drill are complete.

## Verification

1. Run `npm run verify` on the exact branch revision.
2. Run `docker compose -f deploy/oracle/compose.yaml config` and build the image
   on the ARM64 Oracle host.
3. Start with `USAGE_SCHEDULER_ENABLED=false` and confirm `/api/health` and
   `/api/ready?strict=1` externally.
4. Exercise authenticated generic ingest and OTLP idempotent retries against the
   candidate only.
5. Restore the Coolify Litestream replica to a scratch SQLite file, run
   `PRAGMA integrity_check`, and compare representative row counts.
6. During cutover, stop the incumbent writer before the final restore and
   enable exactly one scheduler. Confirm one healthy scheduler tick before DNS.

## Follow-ups

- Keep Render stopped-but-retained for the observation window; rollback requires
  restoring the latest verified Oracle replica before restarting it.
- Oracle may reclaim an Always Free A1 instance classified as idle. External
  monitoring detects an outage but does not provide an SLA or automatic failover.
- Rotate the independently identified credentials that were exposed during
  infrastructure discovery; no exposed value is stored in this repository.
