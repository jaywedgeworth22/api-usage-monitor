# Oracle A1 deployment

The production candidate is one `VM.Standard.A1.Flex` VM with a separate block
volume mounted at `/data`. `usage-monitor.service` refuses to start unless that
mount exists, preventing SQLite from silently writing to the boot volume.

Runtime secrets live only in `/etc/usage-monitor/usage-monitor.env` (mode 0600).
Non-secret host settings live in `/etc/usage-monitor/host.env`:

```dotenv
USAGE_MONITOR_HOSTNAME=usage-oracle.132.226.90.164.sslip.io
USAGE_MONITOR_REVISION=<exact-main-sha>
```

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
