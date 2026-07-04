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

## In Progress
- Branch claude/budget-status — parked local branch found at bootstrap (owner/state unknown; whoever owns it: claim or close).
- Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — include this app in the standardized Codex bootstrap/audit path; no
  app-runtime changes in this repo.
- GitHub Issues mirror of this board (claude/effort-issues-mirror, CLAUDE) — additive
  `scripts/sync-effort-issues.py` + `.github/workflows/effort-issues-sync.yml`, ported verbatim from
  Socratic.Trade (canonical pattern in `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`). Read-only mirror:
  this board stays the source of truth, only the workflow writes issues.

## Planned / Reserved
- CI standard adoption (cross-app, Claude) — RESERVED: 5-line caller workflow consuming the Socratic.Trade reusable verify gate + Mac runner registration. Blocked by: claude/ci-actions-efficiency landing in the hub repo.

## Changelog of this log
- 2026-07-04 — bootstrapped by CLAUDE (effort-log standardization).
- 2026-07-04 — CLAUDE: OTLP ingest + Sentry health card implementation complete, PR pending.
- 2026-07-04 — CLAUDE: PR #13 merged (OTLP ingest + Sentry health card); moved to Completed.
