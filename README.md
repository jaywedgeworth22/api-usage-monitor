# API Usage Monitor

Tracks API usage and cost across providers via **poller snapshots**, **pushed telemetry**, and **Claude Code OTLP metrics**, with **per-project cost attribution** and **recurring-subscription tracking**. Deployed at `usage.jays.services`.

## Key endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/ingest/usage` | Ingest telemetry events from sibling apps (bearer token); optional `project` field attributes cost to a project |
| `GET` | `/api/budget-status` | Per-provider and per-project month-to-date spend vs monthly budget (read token) |
| `POST` | `/api/otlp/v1/metrics` | Receive OTLP metrics from Claude Code (same bearer token as ingest); reads the `project` resource attribute |
| `GET` | `/api/usage-events` | Usage summary grouped by source/provider/**project** (`?projectId=` filter) |
| `GET` `POST` | `/api/subscriptions` | List / create recurring subscriptions (fixed fee + renewal cycle) |
| `PUT` `DELETE` | `/api/subscriptions/:id` | Update / delete a subscription |
| `GET` | `/api/sentry-health` | Per-project unresolved-issue counts from Sentry (dashboard-gated) |

## Per-project attribution & subscriptions

- **Per-project cost:** tag usage with a project so spend rolls up per project. Claude Code:
  `OTEL_RESOURCE_ATTRIBUTES=project=<name>` (per-repo via direnv). Other apps: a top-level `project`
  field on the ingest contract. Names resolve case-insensitively to a `Project`; create the Project
  (with a budget) in Settings → Projects.
- **Subscriptions:** track recurring fixed fees (e.g. a Claude plan) with an interval and renewal
  date in Settings → Subscriptions. A maintenance job materializes each billing period's fee as a
  usage event, so subscriptions count toward provider and project budgets automatically.

## Quick start

```bash
npm install
cp .env.example .env          # fill in required values
npx prisma migrate dev
npm run dev
```

## Verify

```bash
npm run lint   # tsc --noEmit
npm test       # vitest run
npm run build  # next build
```

## Tech stack

- **Next.js** (App Router) — web framework
- **Prisma** (SQLite) — ORM + database (persistent disk on Render)
- **Render** — deployment (see `DEPLOY.md`)
- **Sentry** — error monitoring (Sentry Health card)

## Docs

- **[AGENTS.md](AGENTS.md)** — agent-facing guide (schema, auth, ingest flows, env vars)
- **[DEPLOY.md](DEPLOY.md)** — Render deployment instructions
