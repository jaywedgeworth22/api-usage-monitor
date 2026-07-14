# Litestream WAL Replication (Render)

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams
writes to `/data/prod.db` (the Render disk backing this app) to a Cloudflare R2 bucket
as LTX files. Adapted from the sibling Socratic.Trade app's PM2/macOS setup
(`docs/litestream.md` there) for Render's single-web-service, build-then-run model.

Render's encrypted daily disk snapshots are retained for at least seven days, but
Render explicitly warns against using a disk snapshot to restore a custom database:
the filesystem image might not be transaction-consistent. Litestream is the
SQLite-aware backup/PITR layer; Render snapshots remain last-resort infrastructure
recovery.

**Opt-in, with fail-closed configuration.** With `LITESTREAM_S3_*` unset and
`LITESTREAM_REQUIRED=false` (the initial default), `render.yaml`'s
`startCommand` still creates and integrity-checks a bounded local snapshot of
an existing SQLite database before `migrate-safe.mjs`, then starts without a
litestream process. Setting the four required `LITESTREAM_S3_*` env vars
(BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY; REGION is optional) turns
replication (and restore-on-fresh-disk) on. Partial credentials, an unverified
local pre-migration snapshot, or a configured replica with a missing/unverified
binary stop startup. After the first successful restore drill, set
`LITESTREAM_REQUIRED=true` so an entirely missing replica also stops startup
and makes `/api/ready` fail.

> **0.5.x note:** Litestream 0.5 only supports a **single replica per database**. It
> also replaced the `snapshots`/`generations` model with **LTX files** — inspect them
> with `litestream ltx`, not `litestream snapshots`.

## How it fits into this repo

- `scripts/fetch-litestream.sh` — runs in `render.yaml`'s `buildCommand`. Downloads a
  pinned Litestream release (currently v0.5.13, linux-x86_64) into `./bin/litestream`,
  verifying its sha256 against a pin in the script. Idempotent (skips if the right
  version is already there) and safe to run even when replication is never enabled —
  the binary just sits unused.
- `litestream.yml` — the replica config: `/data/prod.db`, single S3-type replica
  populated entirely from `LITESTREAM_S3_*` env vars, `retention: 720h` /
  `retention-check-interval: 24h` / `snapshot-interval: 24h` (30 days of history),
  copied from Socratic.Trade's config.
- `scripts/start-with-litestream.sh` — `render.yaml`'s `startCommand`. If all four
  required `LITESTREAM_S3_*` vars are set and `bin/litestream` exists: restores from
  R2 first if `/data/prod.db` doesn't exist yet (fresh disk or disaster recovery).
  In both enabled and disabled modes it then runs
  `backup-sqlite-before-migrate.mjs` and `migrate-safe.mjs` in that order.
  Enabled mode finally `exec`s `litestream replicate -exec "npm start"`; disabled
  mode `exec`s `npm start` directly.
- `prisma.config.ts` — declares Litestream's `_litestream_seq` and
  `_litestream_lock` tables as externally managed. Startup schema sync must
  preserve their exact schema and state; `migrate-safe.mjs` never retries with
  Prisma's broad `--accept-data-loss` flag.
- `scripts/backup-sqlite-before-migrate.mjs` — transaction-consistent SQLite
  Online Backup API snapshot plus `PRAGMA integrity_check`, private file modes,
  atomic promotion, and bounded same-disk retention. It is the immediate schema
  rollback layer; Litestream remains the off-disk PITR layer.
- `scripts/litestream-restore.sh` — manual disaster-recovery restore, run from
  Render's Shell tab (see below).

## Setup

### 1. Create an R2 bucket + token

dash.cloudflare.com → R2 → create a bucket (e.g. `api-usage-monitor-backups`) →
**Manage R2 API Tokens** → create a token with **Object Read & Write** scoped to that
bucket. You get an **Access Key ID**, a **Secret Access Key**, and an **endpoint URL**
(`https://<account-id>.r2.cloudflarestorage.com`).

### 2. Add the env vars in the Render dashboard

Go to the `api-usage-monitor` service → **Environment** tab and add (these exist in
`render.yaml` with `sync: false`, so Render won't generate or prompt for them — you set
them manually):

```
LITESTREAM_S3_BUCKET=api-usage-monitor-backups
LITESTREAM_S3_REGION=auto
LITESTREAM_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
LITESTREAM_S3_ACCESS_KEY_ID=...
LITESTREAM_S3_SECRET_ACCESS_KEY=...
LITESTREAM_REQUIRED=false
```

All four of bucket/endpoint/access-key-id/secret-access-key must be set together.
The startup wrapper rejects partial configuration, and it rejects full
configuration when the verified binary is unavailable. `LITESTREAM_S3_REGION`
is optional for R2 and can be left unset: Litestream
expands config env vars with Go's `os.Getenv` (not a shell, so `${VAR:-default}` is not
supported), and with an S3 endpoint set an empty region falls back to `us-east-1`, which
R2 accepts for SigV4. Set it to `auto` only if you prefer to be explicit.

### 3. Deploy

Saving env vars in Render's dashboard triggers a redeploy automatically (or trigger one
manually). The build runs `fetch-litestream.sh` (downloads the pinned binary), then the
new `startCommand` picks up the vars at boot and starts replicating.

### 4. Verify

From Render's **Shell** tab for the `api-usage-monitor` service:

```bash
# Config parses + replica is wired:
bin/litestream databases -config litestream.yml

# LTX files actually landed in R2:
bin/litestream ltx -config litestream.yml /data/prod.db
```

In the service's **Logs**, look for the `[start-with-litestream] replication ENABLED`
line and a `[sqlite-pre-migration-backup] verified ...` line at boot, followed
by litestream's own `replicating to type=s3 bucket=...` and periodic
`ltx file uploaded` / `replica sync` lines. If instead you see
`[start-with-litestream] replication DISABLED`, all required `LITESTREAM_S3_*`
vars are unset and backup is still optional. Partial values or a missing binary
are startup errors; check `fetch-litestream.sh` and startup logs.

After the first successful restore drill, set `LITESTREAM_REQUIRED=true` in
Render and redeploy. Confirm `/api/ready` reports
`checks.backup.required=true` and `checks.backup.active=true`.

## Disaster recovery

`scripts/litestream-restore.sh` restores the latest replica to a scratch file — it
never overwrites the live `/data/prod.db` directly. Run it from Render's **Shell** tab
(R2 creds and the disk are only reachable from there):

```bash
bash scripts/litestream-restore.sh /data/prod.db.restored

# Verify:
sqlite3 /data/prod.db.restored 'PRAGMA integrity_check;'
sqlite3 /data/prod.db.restored 'SELECT count(*) FROM "UsageSnapshot";'

# Activate (keep a timestamped backup of the old file first):
cp /data/prod.db /data/prod.db.bak-$(date +%Y%m%d-%H%M%S)
cp /data/prod.db.restored /data/prod.db
# Then restart the service from the Render dashboard so the running process
# (and litestream) reopen the swapped-in file.
```

Point-in-time restore (0.5.x): pass `-timestamp 2026-06-21T18:00:00Z` or
`-txid <hex>` — see the flags printed at the end of `litestream-restore.sh`'s output,
or `bin/litestream restore -h`.

If the disk is wiped entirely (new disk, service recreated), you don't need to run
this manually at all: `scripts/start-with-litestream.sh` already calls
`litestream restore -if-db-not-exists -if-replica-exists` before `migrate-safe.mjs`
on every boot, so a fresh empty disk recovers from R2 automatically as long as
`LITESTREAM_S3_*` is set.

### Restore-drill guidance

Replication succeeding is not proof restore works — a wrong `-config` path, a stale/
incompatible LTX generation, or an R2 read-permission gap only surfaces at restore
time. Recommend running a restore drill quarterly and after any Litestream version
bump:

1. `bash scripts/litestream-restore.sh /data/prod.db.restore-drill` from Render's Shell.
2. `sqlite3 /data/prod.db.restore-drill 'PRAGMA integrity_check;'` — expect `ok`.
3. Compare `SELECT count(*) FROM "UsageSnapshot";` (or another frequently-written
   table) between the restored file and the live `/data/prod.db` — restored count
   should be close to (at or slightly behind) live, never ahead of it.
4. `rm /data/prod.db.restore-drill` — do not leave the scratch file on the disk, and
   do not `cp` it over the live DB as part of a drill.
5. Record the outcome (date, litestream version, integrity result, count delta) as a
   `docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md` note, matching this repo's
   existing `docs/rollouts/` convention.

Continuous production replication is enabled, but this restore path has **not yet been
exercised against production**. Treat restore as unverified until a drill note exists,
the same caveat as the sibling app's docs before its own first drill.

## Monitoring

```bash
bin/litestream ltx -config litestream.yml /data/prod.db | tail
```

Or just tail the Render service logs and watch for repeated `replica sync` lines
without errors.
