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
- `USAGE_INGEST_TOKEN` (auto-generated; copy this into reporting apps as their usage monitor ingest token)
- `DASHBOARD_PASSWORD` (auto-generated; after the first deploy, copy this value from Render's Environment tab to log in at `/login`)

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
   `render.yaml`, provision the new disk, and drop the old `databases:` and
   `cron:` resources. The build's `prisma db push` creates a fresh, EMPTY
   SQLite database on that disk (since nothing has migrated data into it
   yet).
2. **Before deleting the old Postgres database**, run the one-time migration
   script once to copy every row over. Open the Render dashboard's **Shell**
   tab for the `api-usage-monitor` web service and run:
   ```
   SOURCE_DATABASE_URL="<copy the old Postgres connection string from Render's dashboard for api-usage-monitor-db>" node scripts/migrate-postgres-to-sqlite.mjs
   ```
   `DATABASE_URL` is already set correctly in that shell's environment, so
   you only need to supply `SOURCE_DATABASE_URL`. This must be run from
   Render's Shell for the web service - the destination SQLite file lives on
   a disk that's only reachable from that Render instance itself, so this
   cannot be run from a local machine or CI.
3. **Verify in the dashboard UI** that providers, plans, and usage history
   all look correct (visit https://usage.jays.services and check Settings
   and the provider detail pages).
4. **Only after confirming step 3**, delete the `api-usage-monitor-db`
   Postgres database in Render's dashboard (Databases -> select it ->
   Delete) to actually stop that recurring charge.

### Optional follow-up: back up the SQLite file

Render disks aren't automatically backed up the way Render's managed
Postgres is. As an optional follow-up (not implemented here), consider
setting up [Litestream](https://litestream.io/) to continuously replicate
`/data/prod.db` to S3-compatible storage for backup/durability. The
"Agentic Trading" app already uses this exact pattern - see that repo's
`litestream.yml` (and `docs/litestream.md`, `scripts/litestream-restore.sh`)
as prior art to copy from.
