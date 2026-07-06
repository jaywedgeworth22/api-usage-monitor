# Deployment Guide

## Prerequisites
- Render account (free tier works)
- Cloudflare account managing `jays.services` zone
- Git repository pushed to GitHub

## Step 1: Deploy to Render
1. Go to https://dashboard.render.com
2. Click "New +" > "Blueprint"
3. Connect your GitHub repo
4. Render will read `render.yaml` and create a single resource:
   - `api-usage-monitor` web service, with a 1GB persistent disk mounted at
     `/data` holding a SQLite database file. Usage polling that used to run
     as a separate `fetch-all-usage` cron job now runs in-process inside
     this web service on a 15-minute interval (see
     `src/instrumentation.ts` / `src/lib/usage-recorder.ts`).
5. Wait for the first deploy to complete. The build's `prisma db push` will
   create a fresh, EMPTY SQLite database on the new disk (nothing has
   migrated data into it yet - see "Migrating from the old Postgres +
   cron setup" below if you're moving from that architecture).

## Step 2: Add Custom Domain on Render
1. Go to the `api-usage-monitor` service in Render Dashboard
2. Click "Settings" > "Custom Domain"
3. Add: `usage.jays.services`
4. Render will give you a verification value (e.g., `render-verify=abc123`)

## Step 3: Add DNS CNAME Record on Cloudflare
1. Go to Cloudflare Dashboard > `jays.services` > DNS > Records
2. Add record:
   - Type: CNAME
   - Name: usage
   - Target: api-usage-monitor.onrender.com
   - Proxy status: **DNS only (gray cloud)** — do NOT use proxied
   - TTL: Auto
3. Wait for DNS propagation (~1-5 minutes)

> **Why gray cloud?** Render's IP ranges conflict with Cloudflare's proxy (Error 1000: "DNS points to prohibited IP"). Render provides its own free SSL certificate, so the gray cloud is secure. Cloudflare still handles DNS resolution but passes traffic directly to Render without proxying.

## Step 4: Verify
1. Visit https://usage.jays.services
2. You'll be redirected to `/login`. Go to the `api-usage-monitor` service in Render Dashboard > Environment, copy the auto-generated `DASHBOARD_PASSWORD` value, and use it to log in.
3. You should see the API Usage Monitor dashboard
4. Add your first provider via Settings > Add Provider

## Environment Variables
- `DATABASE_URL` set to a static path on the service's Render disk
  (`file:/data/prod.db`) - not a secret, just a file path
- `ENCRYPTION_KEY` (auto-generated 64-char hex)
- `CRON_SECRET` (auto-generated; the `/api/cron/fetch-all` route still checks
  this, kept as an authenticated manual-trigger/debug endpoint even though
  nothing calls it on a schedule anymore)
- `USAGE_INGEST_TOKEN` (auto-generated; copy this into reporting apps as their usage monitor ingest
  token — this is also the token Claude Code's OTLP exporter authenticates with against
  `POST /api/otlp/v1/metrics`, see AGENTS.md's "Claude Code OTLP ingest" section)
- `DASHBOARD_PASSWORD` (auto-generated; after the first deploy, copy this value from Render's Environment tab to log in at `/login`)
- `SENTRY_READ_TOKEN` (optional; enables the read-only Sentry Health dashboard card, an org-auth
  token or internal integration token with `project:read`/`event:read` scope — never sent to the
  client, absent by default)
- `SENTRY_ORG` (optional; Sentry org slug for the Health card, defaults to `jays-services`)
- `ALERT_SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` (optional; when set, provider
  budget/balance/stale alerts are delivered outside the dashboard after each polling tick)
- `ALERT_MIN_SEVERITY` (optional; `info`, `warning`, or `critical`; defaults to `warning`)
- `ALERT_REMINDER_HOURS` (optional; defaults to `24`, used to dedupe repeated open alerts)
- `USAGE_SNAPSHOT_RAW_RETENTION_DAYS` (optional; defaults to `45`, after which raw snapshots are
  rolled up daily and pruned)
- `EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS` (optional; defaults to `90`; current UTC-month events
  are always retained because `/api/budget-status` reads them directly)
- `EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS` (optional; defaults to `180`, keeping old
  idempotency keys from being reinserted after raw event pruning)

## SSL/TLS
- Cloudflare handles SSL with "Full (strict)" mode
- Render also provides its own SSL certificate
- Both ends are encrypted end-to-end

## Migrating from the old Postgres + cron setup

This app used to run as 3 billed Render resources (web service + a separate
Postgres database + a separate cron job). It now runs as a single web
service with a SQLite database on a Render disk, to cut hosting cost. If
you're moving an existing deployment from the old architecture to this one,
follow these steps IN ORDER - this involves real production data, so don't
skip the verification step before deleting anything.

1. **Merge and deploy this branch to Render.** Render will read the updated
   `render.yaml` and provision the new disk for the `api-usage-monitor` web
   service. **Render Blueprint sync does NOT auto-delete resources that were
   removed from `render.yaml`** - the old `databases:` and `cron:` entries
   are gone from the file, but the actual `api-usage-monitor-db` Postgres
   database and `fetch-all-usage` cron job resources keep existing (and keep
   running/billing) in your Render dashboard until you manually delete/suspend
   them. The build's `prisma db push` creates a fresh, EMPTY SQLite database
   on the new disk (since nothing has migrated data into it yet).
2. **Immediately suspend the old `fetch-all-usage` cron job** (Render
   dashboard -> select the cron job -> Settings -> Suspend, or delete it
   outright). Do this right after step 1, before doing anything else below.
   Until you do, the old cron keeps firing on its own schedule against the
   old Postgres database at the same time the new web service's in-process
   scheduler (see `src/instrumentation.ts` / `src/lib/usage-recorder.ts`)
   starts polling providers from SQLite - two independent pollers hitting
   the same provider APIs concurrently, causing duplicate external API calls
   and, once you cut over, duplicate/conflicting usage data. Do not skip
   this step or delay it until after the migration.
3. **Before deleting the old Postgres database**, run the one-time migration
   script once to copy every row over. Open the Render dashboard's **Shell**
   tab for the `api-usage-monitor` web service and run:
   ```
   SOURCE_DATABASE_URL="<copy the old Postgres connection string from Render's dashboard for api-usage-monitor-db>" node scripts/migrate-postgres-to-sqlite.mjs
   ```
   `DATABASE_URL` is already set correctly in that shell's environment, so
   you only need to supply `SOURCE_DATABASE_URL`. This must be run from
   Render's Shell for the web service - the destination SQLite file lives on
   a disk that's only reachable from that Render instance itself, so this
   cannot be run from a local machine or CI. The script writes to SQLite
   inside a single transaction, so if it fails partway through it's safe to
   just fix the underlying issue and re-run it from the top (see
   "Migration script failure/resume" below).
4. **Verify in the dashboard UI** that providers, plans, and usage history
   all look correct (visit https://usage.jays.services and check Settings
   and the provider detail pages).
5. **Only after confirming step 4**, delete the `api-usage-monitor-db`
   Postgres database in Render's dashboard (Databases -> select it ->
   Delete) to actually stop that recurring charge. If you haven't already
   deleted the `fetch-all-usage` cron resource itself (as opposed to just
   suspending it in step 2), delete it now too.

### Migration script failure/resume

`scripts/migrate-postgres-to-sqlite.mjs` writes all destination rows inside
a single `prisma.$transaction`. If it fails partway through (network blip,
a bad row, etc.), Prisma rolls back every row written so far, so the
destination SQLite database is left exactly as it was before that run (empty,
on a first attempt) - there's no partially-migrated state to clean up.

To retry after a failed run, just fix whatever caused the failure (check the
error output) and re-run the same command again from the top:
```
SOURCE_DATABASE_URL="..." node scripts/migrate-postgres-to-sqlite.mjs
```

### Optional follow-up: back up the SQLite file

Render disks aren't automatically backed up the way Render's managed
Postgres is. [Litestream](https://litestream.io/) is set up in this repo to
continuously replicate `/data/prod.db` to S3-compatible storage (Cloudflare
R2) for backup/durability - but it's **opt-in and disabled by default**.
With the five `LITESTREAM_S3_*` env vars unset, `render.yaml`'s
`startCommand` behaves exactly as it did before (no litestream process).

To enable it: create an R2 bucket + token and set the five `LITESTREAM_S3_*`
vars in the Render dashboard's Environment tab (they already exist in
`render.yaml` with `sync: false` so Render won't prompt for or generate
them). Full setup, verification, and disaster-recovery restore steps
(including a restore-drill runbook) live in `docs/litestream.md`. Relevant
files: `scripts/fetch-litestream.sh` (build-time binary download),
`litestream.yml` (replica config), `scripts/start-with-litestream.sh` (the
new `startCommand`), `scripts/litestream-restore.sh` (manual restore).
