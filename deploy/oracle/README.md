# Oracle A1 deployment

The production candidate is one `VM.Standard.A1.Flex` VM with a separate block
volume mounted at `/data`. `usage-monitor.service` refuses to start unless that
mount exists, preventing SQLite from silently writing to the boot volume. The
unit also sets the mount root to UID/GID `1000:1000`, matching the unprivileged
`node` user in the official Node image; Oracle's Ubuntu login user is normally
UID 1001 and must not own the container's SQLite directory.

Runtime secrets live only in `/etc/usage-monitor/usage-monitor.env` (mode 0600).
Non-secret host settings live in `/etc/usage-monitor/host.env`:

```dotenv
USAGE_MONITOR_HOSTNAME=usage-oracle.132.226.90.164.sslip.io
USAGE_MONITOR_REVISION=<exact-main-sha>
```

Oracle and the Coolify backup host are also Tailscale peers. Keep the Garage
endpoint as its HTTPS hostname so certificate validation remains enabled, and
pin that hostname to the Coolify Tailscale address in Oracle's `/etc/hosts`.
Verify both `tailscale ping <coolify-ip>` and `curl --resolve` against the
Garage endpoint before relying on the private route. Public port 9443 is only a
source-IP-restricted break-glass path; do not expose Garage broadly.

## Backup monitoring

The machine-level singleton at
`/Users/jay/apps/fleet-sentry-monitor/monitor.py` verifies this backup path
without adding another daemon or another alert credential to either server.
Every 15 minutes it:

- SSHes to Oracle and runs authenticated `litestream ltx -level all` plus a
  no-write `litestream restore -dry-run` against the Garage replica.
- Enforces a one-hour maximum replica-object age only after
  `USAGE_SCHEDULER_ENABLED=true`; staging with its scheduler disabled still
  verifies authentication and restorability without false stale alerts.
- Confirms the Garage container is running and healthy and checks free space
  on Coolify's Docker filesystem (warning below 15 GiB, error below 8 GiB).
- Reports a separate Sentry Cron check-in named
  `usage-monitor-garage-backup`; the existing `fleet-host-monitor` check-in
  detects absence when the Mac-side singleton itself stops.

Once a week the same singleton restores to the fixed Oracle scratch path
`/data/.garage-backup-monitor-restore.db` with Litestream's `full` integrity
check, then removes the database and SQLite sidecars in a trap. It never
overwrites `/data/prod.db` or writes backup objects. Persistent failures are
fingerprint-deduplicated to one Sentry event per hour.

The candidate starts with `USAGE_SCHEDULER_ENABLED=false` and a separate
Litestream target. Keep Render live until the candidate passes:

1. `/api/health` and `/api/ready?strict=1` from an external network.
2. Authenticated generic ingest and OTLP retry/idempotency probes.
3. A transaction-consistent Litestream restore into a scratch SQLite file,
   `PRAGMA integrity_check`, and representative row-count comparison.
4. One scheduler tick after the sole-writer cutover; never run both schedulers.

Cutover order: quiesce producer retries, stop the Render scheduler, take the
final backup/restore, start Oracle with its scheduler enabled, verify one healthy
tick, then change DNS. Render remains stopped-but-retained for rollback until the
observation window closes. Rollback reverses that order and restores the last
verified database; never start two SQLite writers or two schedulers against
divergent copies.
