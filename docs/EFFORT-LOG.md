# API-usage-monitor Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board:
`/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (mirror: this file). As of 2026-07-04.

## Deployed
- (record the monitor's production runtime state here when releases happen)

## Completed
- PR #8 (claude/agent-sync-stanza, CLAUDE) — AGENTS.md inter-agent coordination stanza; MERGED 2026-07-04.
- **PR #13 (claude/otlp-claude-code-ingest, CLAUDE) — Claude Code OTLP metrics ingest + read-only
  Sentry health card; MERGED 2026-07-04 (merge commit `412ab00`).** `POST /api/otlp/v1/metrics`
  (OTLP-HTTP JSON + protobuf via `protobufjs` against the vendored official `opentelemetry-proto`
  schema) maps Claude Code's native token/cost/session/lines-of-code/commit/PR/active-time/
  code-edit-tool-decision metrics into `ExternalUsageEvent` (provider="anthropic",
  service="claude-code") so existing budgets/alerts/dashboards apply unchanged; idempotent on OTLP
  batch retries; unknown/future metric names accepted+tallied+logged-once, never mapped or 500'd;
  first successful ingest lazily seeds an `anthropic` Provider row with no budget if one doesn't
  already exist. `POST /api/otlp/v1/logs` is an accept-and-drop stub. `GET /api/sentry-health` +
  dashboard card give a read-only per-project unresolved-issue count (env-gated on
  `SENTRY_READ_TOKEN`/`SENTRY_ORG`, absent by default, token never sent to client). Found and fixed
  a real pre-existing gap while building this: `src/middleware.ts`'s dashboard-session gate did not
  exclude `/api/otlp/*`, so even a correctly-authenticated OTLP POST would have been 401'd before
  reaching the route's own bearer-token check — verified with a live before/after `next start`
  repro, fixed with the same exclusion `/api/ingest` already has. 46/46 vitest passing, tsc/build
  clean. **Owner activation still needed: the coordinator must set
  `CLAUDE_CODE_ENABLE_TELEMETRY=1` / `OTEL_METRICS_EXPORTER=otlp` /
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` / `OTEL_EXPORTER_OTLP_ENDPOINT=https://usage.jays.services/api/otlp`
  / `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <USAGE_INGEST_TOKEN>` in
  `~/.claude/settings.json` (not done by the agent, per instructions) before any real data flows.**
- Branch claude/budget-status — parked local branch found at bootstrap (owner/state unknown; whoever owns it: claim or close).
- Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — include this app in the standardized Codex bootstrap/audit path; no
  app-runtime changes in this repo.
- **PR #33 (codex-data-retention-alert-delivery, CODEX) — data retention/pruning for
  `UsageSnapshot`/`ExternalUsageEvent` + alert delivery channels; MERGED 2026-07-04 (merge
  commit `421a05c`).** Adds SQLite/Prisma daily rollups, tombstones for pruned external
  idempotency keys, current-month budget protection, rollup-aware history endpoints, provider
  alert notification state, Slack/webhook delivery channels, reminder dedupe, resolution
  tracking, env/docs, and retention/alert integration coverage. Verified locally before merge:
  `npx prisma generate`, `npm test` (8 files / 52 tests), `npm run lint`, and `npm run build`.

## In Progress
- (none)

## Planned / Reserved
- CI standard adoption (cross-app, Claude) — RESERVED: 5-line caller workflow consuming the Socratic.Trade reusable verify gate + Mac runner registration. Blocked by: claude/ci-actions-efficiency landing in the hub repo.

_2026-07-04 backlog exhaustiveness pass (CLAUDE, owner-directed). Tags: CURSOR = Cursor background
agents (DeepSeek v4 Pro), CODEX = Codex, AG = Antigravity/Gemini. Assignments are reservations,
not locks — re-negotiate in #agent-sync._

- **Run the test suite in CI (CURSOR, S)** — `ci.yml` never runs `npm test`; 46 vitest tests
  currently gate nothing.
- **Real ESLint setup (CURSOR, M)** — the `lint` script is just `tsc --noEmit` (duplicating the
  Typecheck step); add `eslint-config-next` + fix violations.
- **Auth consolidation + env-example completeness (CURSOR, S)** — `/api/ingest/usage` and
  `/api/budget-status` hand-roll bearer auth instead of the shared `ingest-auth.ts`; add the
  missing `USAGE_READ_TOKEN` to `.env.example`; document the in-process rate-limiter's
  single-instance assumption.
- **Root README.md (CURSOR, S)** — repo has only AGENTS.md/DEPLOY.md; nothing human-facing.
- **Close parked `claude/budget-status` + prune merged branches (CURSOR, S)** — the parked branch
  deletes password auth wholesale and re-implements shipped PR #6 work; close-not-merge, then
  prune the ~12 merged/stale branches.
- **Litestream backup for the Render SQLite disk (AG, M)** — DEPLOY.md's own optional follow-up;
  copy the sibling trading app's `litestream.yml` pattern.
- **Per-adapter resilience review (AG, L)** — timeouts, 429 backoff, partial-failure isolation in
  `fetchAllDueProviders` across ~30 adapters.
- **Implement OTLP logs ingestion (unassigned, L, deliberately deferred)** — `/api/otlp/v1/logs`
  is accept-and-drop by design today.
- **Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S)** — set the documented
  `OTEL_*` + `CLAUDE_CODE_ENABLE_TELEMETRY` vars in `~/.claude/settings.json` so real data flows
  into the already-built ingest.

## Changelog of this log
- 2026-07-04 — bootstrapped by CLAUDE (effort-log standardization).
- 2026-07-04 — CLAUDE: OTLP ingest + Sentry health card implementation complete, PR pending.
- 2026-07-04 — CLAUDE: PR #13 merged (OTLP ingest + Sentry health card); moved to Completed.
- 2026-07-04 — CLAUDE: backlog exhaustiveness + assignment pass (owner-directed); seeded Planned
  from a full repo audit. Repo mirror + issues sync to be reconciled (stale mirror issues
  #10/#12/#15 describe already-merged work).
- 2026-07-04 — CODEX: moved assigned retention/pruning + alert-delivery rows to In Progress on
  `codex-data-retention-alert-delivery`.
- 2026-07-04 — CODEX: implemented retention/pruning + alert-delivery lanes locally; full tests,
  typecheck, and build pass locally, pending main-agent integration/landing.
- 2026-07-04 — CODEX: PR #33 merged to `origin/main` (`421a05c`); moved retention/pruning +
  alert-delivery rows from In Progress to Completed.
