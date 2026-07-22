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
USAGE_MONITOR_HOSTNAME=usage.jays.services
USAGE_MONITOR_REVISION=<exact-main-sha>
```

`usage.jays.services` is the public Cloudflare-proxied hostname. Caddy keeps
ports 80 and 443 reachable for its public ACME certificate and disables the
TLS-ALPN challenge because Cloudflare terminates public TLS; renewal therefore
uses HTTP-01. Do not restore the deleted IP-derived fallback.

## Automatic production deployment

Oracle polls GitHub once per minute and deploys only when all of these are true:

1. the target is still the exact `main` SHA;
2. GitHub marks the commit signature/verification as valid;
3. the commit belongs to a merged PR whose base is `main`;
4. the exact SHA's GitHub Actions `verify`, `gitleaks`, and
   `Analyze JavaScript and TypeScript` checks all completed successfully under
   the official GitHub Actions app;
5. the current Oracle database, sole scheduler, Garage v3 replica, separate
   `/data` block volume, disk headroom, and public readiness all pass preflight;
6. the root-owned Render retirement proof records a user-suspended service,
   disabled auto-deploy, and `USAGE_SCHEDULER_ENABLED=false`, while the former
   public health endpoint remains unavailable. Oracle also verifies those
   service and environment settings live through Render's API on every deploy.

This pull model intentionally stores no production SSH key or cloud credential
in GitHub. `.github/workflows/oracle-production-deploy.yml` is an independent
public receipt: after exact-main CI succeeds, it waits for production to report
that exact revision and fails visibly if the deployment does not arrive.

The root-owned installation is separate from every fetched release:

```bash
sudo install -o root -g root -m 0644 deploy/oracle/compose.production.yaml /etc/usage-monitor/compose.yaml
sudo install -o root -g root -m 0644 deploy/oracle/Caddyfile /etc/usage-monitor/Caddyfile
sudo install -o root -g root -m 0600 deploy/oracle/render-retired.production.json /etc/usage-monitor/render-retired.json
sudo install -o root -g root -m 0755 deploy/oracle/deploy-production.sh /usr/local/sbin/usage-monitor-deploy
sudo install -o root -g root -m 0755 deploy/oracle/auto-deploy.sh /usr/local/sbin/usage-monitor-auto-deploy
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor.service /etc/systemd/system/usage-monitor.service
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-auto-deploy.service /etc/systemd/system/usage-monitor-auto-deploy.service
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-auto-deploy.timer /etc/systemd/system/usage-monitor-auto-deploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now usage-monitor-auto-deploy.timer
```

`/etc/usage-monitor/render-api.curl.conf` is a root-owned mode-0600 curl config
containing the Render authorization header. Provision it through the protected
secret handoff, never Git or GitHub Actions. A missing/revoked token defers the
deployment without touching production; a live service, enabled auto-deploy,
or scheduler value other than exactly `false` fails the sole-writer gate.

Keep `/etc/usage-monitor/auto-deploy.paused` present during bootstrap or a
planned freeze. Removing it enables the next timer pass. A failed revision is
retried at most three times, then recorded in
`/var/lib/usage-monitor-deploy/blocked-sha`; a new main revision resets that
circuit automatically. A failed required GitHub check is re-evaluated every
five minutes so a successful same-SHA rerun can recover without a new PR. After
an operator fixes a transient external condition,
`sudo /usr/local/sbin/usage-monitor-auto-deploy --retry-blocked` explicitly
rearms the same SHA.

The app container permanently keeps Docker restart policy `no`. This prevents
the Docker daemon from starting the SQLite writer against a boot-disk `/data`
directory before the block volume mounts. Only `usage-monitor.service` starts
the app, with mount conditions enforced; the timer can recover a stopped
accepted revision through that unit even while new deployments are paused.
Recovery and deployment use the same host lock, so the timer cannot revive the
previous writer during a manual transaction's intentional cutover stop.

Each transaction builds in a root-owned exact-SHA release checkout while the
old app remains live. It validates a target-image migration against a
transaction-consistent scratch database before stopping anything. The brief
cutover stops and replaces only the app container, never Caddy. Acceptance
requires exact-revision strict readiness, a fresh scheduler tick, three public
readiness samples, Garage TXID advancement beyond a stable watermark captured
only after the previous writer has fully stopped,
and a full authenticated Garage restore whose SQLite integrity, foreign keys,
and schema match production.

The previous full-SHA image and up to five verified offline SQLite snapshots
are retained. Automatic rollback changes code/image only and never replaces
SQLite: restoring an older database after traffic resumes could discard writes
and fork the Litestream lineage. If both candidate and prior images fail, the
transaction stops every app writer instead of risking a second or divergent
writer. Inspect receipts and logs with:

```bash
sudo cat /var/lib/usage-monitor-deploy/current.json
sudo journalctl -u usage-monitor-auto-deploy.service --since today
systemctl list-timers usage-monitor-auto-deploy.timer
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

The pre-cutover candidate started with `USAGE_SCHEDULER_ENABLED=false` and a
separate Litestream target. The completed production migration verified:

1. `/api/health` and `/api/ready?strict=1` from an external network.
2. Authenticated generic ingest and OTLP retry/idempotency probes.
3. A transaction-consistent Litestream restore into a scratch SQLite file,
   `PRAGMA integrity_check`, and representative row-count comparison.
4. One scheduler tick after the sole-writer cutover; never run both schedulers.

The one-time cutover quiesced Render, restored its terminal backup into Oracle,
enabled the sole Oracle scheduler, and then changed DNS. Render remains
suspended as a rollback host. Never reverse DNS to its stale database: a host
rollback requires quiescing Oracle and restoring the latest verified Garage
lineage before transferring scheduler/writer authority.
