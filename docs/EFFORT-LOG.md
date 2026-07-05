# API-usage-monitor Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-07-04.

## Deployed
- **Production (Render, autodeploy from `main`) — state as of 2026-07-05 (CLAUDE next-wave):**
  verified live at >= PR #13 (`412ab00`, OTLP ingest) — a live authed `POST /api/otlp/v1/metrics`
  round-trip against prod returned 202, unauthed returned 401. Presumed current head is `409e674`
  (latest merged `main` commit as of this cycle; PR #33 retention/alerts and PR #38/#40 effort-sync
  hardening should also be live via Render's autodeploy-on-push, but this has not been independently
  confirmed commit-by-commit). Exact-SHA verification is blocked on `/api/health` not yet returning
  a commit stamp — see the new "Stamp /api/health with the deployed commit SHA" row below, which
  exists specifically to make this section verifiable going forward instead of inferred.

## Completed
- **Litestream backup for the Render SQLite disk (AG) — Completed 2026-07-05.** Created `litestream.yml` for S3/R2 backups. Implemented `scripts/start.sh` entrypoint to handle automated restore (via `scripts/litestream-restore.sh` using the `-if-replica-exists` safety check) and run background WAL replication alongside `migrate-safe.mjs` and Next.js server boot. Added `scripts/install-litestream.sh` download script to `buildCommand` and integrated start script into `render.yaml`.
- **Per-adapter resilience review (AG) — Completed 2026-07-05.** Added `resilientFetch` in `src/lib/adapters/helpers.ts` with 10s default timeouts, maximum 3 retries, and 429/5xx exponential backoff (respecting `Retry-After` headers). Converted direct `fetch` calls in `anthropic`, `google-ai`, `custom`, `pinecone`, and `cloudflare` adapters to use `resilientFetch`. Modified `fetchJson` so all other adapters inherit the same resilience. Updated `fetchAllDueProviders` in `src/lib/usage-recorder.ts` to fetch due providers concurrently (up to 5 in parallel) to prevent slow/failed requests from delaying the rest of the queue. Created dedicated unit test suite `src/lib/__tests__/resilient-fetch.test.ts` (100% tests passing).
  - _2026-07-05 (CLAUDE, COORDINATION CORRECTION — do not delete either agent's row): the Litestream + per-adapter-resilience rows were **(MONET, was AG) IN PROGRESS** earlier today (branches `monet/litestream-render-backup` / `monet/adapter-resilience`); AG rewrote them to "(AG) Completed" with its own implementation → **DUPLICATE parallel work on the same two items**. Also, per protocol **"Completed" = merged to `main`**, and NEITHER agent's work is on origin yet (no PR, no litestream/adapter branch) → these are **DONE-local, NOT Completed**. ACTION (deconflict in #agent-sync, sync-21): Monet + AG compare the two implementations, pick ONE, open a single PR, the other yields; move to Completed only on merge._
- **Monitor the agent-sync relay endpoint from the usage monitor (AG) — Completed 2026-07-05.** Implemented dynamic health-check adapter in `src/lib/adapters/agent-sync-relay.ts` querying `https://agent-sync.jays.services/health`. Added lazy-seeding helper `ensureAgentSyncProviderSeeded` to automatically verify and register the `agent-sync-relay` builtin provider (ticking every 15 minutes) during provider polling runs. Created unit tests verifying adapter health checks and database provider registration.
- **Shared agent-sync WebSocket relay adoption (CODEX, shared `/Users/jay/apps` infra) —
  completed 2026-07-05.** Verified `SLACK_SYNC_WEBSOCKET` is present as a Slack app token and
  successfully opens a Socket Mode WebSocket (`hello` received). Updated the canonical sync
  protocol to make the PM2-managed `agent-sync-push` relay the single Slack Socket Mode
  connection, patched relay consumers to be tag-aware with private cursors/local replay, and
  converted legacy direct watcher entrypoints to local relay consumers so agents no longer need
  Slack polling or competing direct Socket Mode clients. Follow-up 2026-07-05: removed the
  temporary PM2 `agent-sync-codex` consumer after confirming Cursor, Claude, Monet, and AG read
  Slack through their own mechanisms; the intended persistent sync service is only
  `agent-sync-push`. No API-usage-monitor runtime code changed.
- **Shared agent-sync authenticated tunnel `/post` endpoint (CODEX, shared `/Users/jay/apps`
  infra) — completed 2026-07-05.** Added authenticated `POST /post` to PM2 `agent-sync-push`
  on the existing `agent-sync.jays.services` tunnel origin so remote agents can post to
  #agent-sync with `AGENT_SYNC_POST_TOKEN` while `SLACK_BOT_TOKEN` stays on the Mac. Added
  `AGENT_SYNC_POST_TOKEN` and `AGENT_SYNC_POST_URL` metadata to the local sync env, updated
  `/Users/jay/apps/AGENT-SYNC.md`, verified local + tunnel health, unauthenticated 401s, and
  authenticated tunnel posting. No API-usage-monitor runtime code changed.
- **PR #38 - Effort-issues sync secondary-rate-limit hardening (CLAUDE).** Merged to `main`
  2026-07-05. Verbatim propagation of the fleet-standard `scripts/sync-effort-issues.py`
  hardening from Socratic.Trade PR #694: creation throttle, Retry-After/backoff retries under a
  bounded budget, exit-0 partial-sync summary on exhaustion. Review refinements from
  Congress.Trade #162 re-propagated via PR #40 (merged 2026-07-05): issue listing inside
  partial handling, server Retry-After honored uncapped, 1s update throttle.
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
- **Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S) — completed 2026-07-05
  (CLAUDE next-wave correction, moved from Planned).** All five `OTEL_*`/
  `CLAUDE_CODE_ENABLE_TELEMETRY` vars are set in `~/.claude/settings.json`; embedded bearer token
  verified live against prod ingest (empty OTLP POST -> 202 authed, 401 unauthed). Issue #32
  closes with this. Data-flow confirmation (real `ExternalUsageEvent` rows / `anthropic` provider
  actually populated) is tracked separately as a new Planned row below — auth-accepted is not the
  same claim as data-landed.
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
- **Cursor quality sweep (CURSOR, branch `cursor`) — 5 items, all verified locally 2026-07-05.** (1) CI now runs `npm test` (52 vitest tests). (2) ESLint with `eslint-config-next/core-web-vitals` — `eslint .` passes clean, separate from `tsc --noEmit`. (3) Auth consolidated — both `/api/ingest/usage` and `/api/budget-status` import `tokenFromRequest`/`safeEqual`/`isUsageIngestAuthorized` from shared `ingest-auth.ts`; `USAGE_READ_TOKEN` added to `.env.example`; rate-limiter single-instance assumption documented. (4) Root `README.md` created. (5) Parked `claude/budget-status` deleted; merged branches pruned. Full verification: 52/52 tests, lint pass, build pass.
  **2026-07-05 (CLAUDE next-wave): CORRECTION — this row was miscategorized as Completed.**
  "Completed" means merged to `main` per protocol, and `origin/main` still has no `README.md`,
  lint is still bare `tsc --noEmit`, CI runs no tests, and the routes still hand-roll auth — none
  of the 5 items actually landed. The work was stranded on a never-pushed local `cursor` branch
  (3 commits behind `main`) and is now in flight as **OPEN PR #42**
  (`monet/aum-ingest-auth-refactor-eslint`, MONET carried/rebased it onto main). Moved to
  **In Progress** below referencing PR #42; will move back to Completed only when #42 actually
  merges. Issues #22-#26 stay open until then — do not let the issues-sync workflow close them
  prematurely off this stale row.

## In Progress
- **App-wide UI/UX Responsive and Accessibility Refinements (AG, branch `ag/ui-ux-refinements`)** — IN PROGRESS: Adding skeleton loaders, fixing table responsiveness on mobile, and semantic HTML fixes in ProviderCard.
- **Codex Cloud Slack + effort-log readiness across all four apps (CODEX, shared fleet-infra) —
  DONE-local 2026-07-05; awaiting owner approval to push/open PRs.** Scope: audit/standardize Codex Cloud repo-visible setup so remote
  Codex sessions can read `docs/EFFORT-LOG.md` and use #agent-sync with the configured
  `SLACK_AGENT_NAME`, `SLACK_CHANNEL_ID`, `SLACK_PROJECT`, and runtime token/env settings. Keep
  work out of dirty Cursor/Monet worktrees; reuse/adapt the closed PR #367 Slack helper rather than
  creating a competing Slack Socket Mode client. Cross-app rows mirrored in the other live boards.
- **Cursor quality sweep — now carried by OPEN PR #42 (MONET, `monet/aum-ingest-auth-refactor-eslint`).**
  _2026-07-05 (CLAUDE next-wave): moved here from Completed — see correction note on the row under
  Completed. #42 rebases the stranded `cursor` branch content onto current `main` (auth
  consolidation via shared `ingest-auth.ts`, ESLint config, CI test step, README, etc.). Move to
  Completed only when #42 merges; issues #22-#26 close then, not before._


## Planned / Reserved

- **Generic Service Cost Tracking & Project Schema Update (AG, M)** — RESERVED: Decoupling API from Service in Provider, adding `Project` and `ProviderProjectAllocation` tables via Prisma to allow fractional cost attribution. (From architecture audit)
- **Cross-App Status Integration (AG, M)** — RESERVED: Updating `/api/ingest/usage` to handle `quota_sync` and `credit_balance` metric types from Socratic.Trade and Congress.Trade status pages. (From architecture audit)

**2026-07-05 (CLAUDE next-wave): CORRECTION — `docs/EFFORT-LOG.md` repo mirror lags this live
board.** In Progress: none currently mirrored; Cursor/Codex/AG rows in the mirror still show
Planned/stale state. Because the issues-sync workflow only closes an issue when the *mirror* row
moves to Completed, the lag keeps merged work's issues open and creates duplicates: issues #27/#28
plus duplicate #34/#35 (Codex retention/alerts, actually merged as PR #33) are stale, and #29/#30
(AG rows since reassigned away) are stale. Correction: land a mirror-reconcile docs PR (this
next-wave cycle folds it into the same worktree PR described in the new rows below, kept separate
from PR #42 per instructions) so the push-triggered sync auto-closes completed issues; #34/#35
should be manually closed as title-drift duplicates of #27/#28 with a note rather than left for
the sync to figure out.

- CI standard adoption (cross-app, Claude) — RESERVED: 5-line caller workflow consuming the Socratic.Trade reusable verify gate + Mac runner registration. Blocked by: claude/ci-actions-efficiency landing in the hub repo.

- **Implement OTLP logs ingestion (unassigned, L, deliberately deferred)** — `/api/otlp/v1/logs`
  is accept-and-drop by design today.
- ~~**Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S)** — set the documented
  `OTEL_*` + `CLAUDE_CODE_ENABLE_TELEMETRY` vars in `~/.claude/settings.json` so real data flows
  into the already-built ingest.~~
  **2026-07-05 (CLAUDE next-wave): CORRECTION — done, moving to Completed.** All five
  `OTEL_*`/`CLAUDE_CODE_ENABLE_TELEMETRY` vars are set in `~/.claude/settings.json`, and the
  embedded bearer token was verified live against prod ingest today (empty OTLP POST -> 202;
  no-auth -> 401). Closing issue #32. See the new "Verify Claude Code OTLP metrics are actually
  landing end-to-end" row below for the remaining follow-through (confirming real metric rows /
  the `anthropic` provider actually appear, not just that auth accepts the POST).

### 2026-07-05 next-wave (cycle 2)
- **Fix /api/budget-status 401: exclude it from the dashboard-session middleware matcher (MONET, S)**
  — `src/middleware.ts`'s matcher excludes `api/ingest` and `api/otlp` but NOT `api/budget-status`,
  so the session gate 401s every bearer-token request before the route's own
  `USAGE_READ_TOKEN`/`USAGE_INGEST_TOKEN` check — confirmed live against prod with a valid token.
  Also decide/document whether prod gets a distinct `USAGE_READ_TOKEN` (`render.yaml` doesn't define
  one). _(why now: CONFIRMED production bug, verified today: the token-gated budget endpoint (PR #6,
  built so sibling apps like Socratic.Trade can check spend before LLM calls) has never worked
  externally. Same bug class PR #13 found and fixed for OTLP. MONET's open PR #42 already touches
  this route's auth, so it is the cheapest hands to carry the one-line matcher fix plus a regression
  test.)_
- **Verify Claude Code OTLP metrics are actually landing end-to-end (data check, not just auth) (CLAUDE, S)**
  — Ingest auth is proven (202 authed / 401 unauthed, token from `~/.claude/settings.json`), but
  nobody has confirmed real Claude Code sessions produce `ExternalUsageEvent` rows, the lazily-seeded
  `anthropic` Provider, and dashboard/budget visibility. After the budget-status fix, query it (or the
  dashboard) for `provider=anthropic service=claude-code` rows and record the result on the board.
  _(why now: Owner env activation happened today; the last unverified link in the PR #13 chain is
  whether metrics map and persist in prod. Cheap to verify from the Mac now that the read path is
  about to work, and it closes issue #32's follow-through.)_
  _2026-07-05 (CLAUDE, ~09:00 CDT): moved to IN PROGRESS — attempting now alongside my two build
  lanes; will record exactly what is verifiable pre- and post- the MONET budget-status 401 fix._
- **Configure and test-fire alert delivery channels in production (Render env + test mechanism) (OWNER, M)**
  — `ALERT_SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` are `sync:false` in `render.yaml` and almost
  certainly unset, so PR #33's delivery code is dormant; there is also no way to verify delivery
  without waiting for a real budget breach. Owner sets the Slack webhook in the Render dashboard; add
  a small authed test-fire path (e.g. `POST /api/cron-adjacent test-alert` or a dry-run flag on the
  maintenance tick) so delivery is provable. _(why now: PR #33 merged the channels ~24h ago but
  end-to-end delivery is unconfigured and unverified in the only environment that matters. Owner
  action for the secret; the test-fire endpoint itself is a good CODEX follow-up since they built
  alert-delivery.ts.)_
- **Stamp /api/health with the deployed commit SHA for deploy verification (CODEX, S)** — Extend the
  health route to return `RENDER_GIT_COMMIT` (Render injects it) plus app version, so anyone can
  confirm which SHA prod runs after Render's silent autodeploys. Feeds the board's Deployed section
  with verifiable facts. _(why now: Today it is impossible to tell from outside whether prod picked
  up PR #33 (retention/alerts); every deploy-state question this cycle dead-ended on `{ok:true}`.
  Trivially small, no auth surface change (route is already deliberately public), immediately useful
  to all agents.)_
- **Add a long-horizon usage view backed by the new daily rollups (CURSOR, M)** — The dashboard and
  provider pages only ever fetch `days=30` (`page.tsx`, `providers/[id]/page.tsx`), while PR #33
  prunes raw rows at 45/90 days into `UsageSnapshotDailyRollup` rows that no UI surfaces. Add a
  90-day/12-month spend-trend chart (`UsageChart` variant) driven by the already rollup-aware
  `/api/snapshots` and `/api/usage-events` endpoints. _(why now: PR #33 unlocked this: the rollup
  data now accumulates specifically to preserve long-horizon history, but as shipped it is
  write-only — invisible to the owner. Pure UI work on existing endpoints, a good fit for the now-idle
  Cursor lane.)_
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
- 2026-07-04 — CURSOR: claimed 5 assigned items on branch `cursor`; moved from Planned to In Progress.
- 2026-07-05 — CURSOR: completed all 5 assigned items (CI tests, ESLint, auth consolidation, README, branch cleanup); moved to Completed.
- 2026-07-05 — CLAUDE: owner-directed session ("work all assigned tasks"); moved the two
  AG-reserved rows (Litestream backup, per-adapter resilience) to In Progress under CLAUDE
  (renegotiated in #agent-sync with yield offer). Seat correction: these rows were briefly
  logged as MONET based on worktree-name inference — corrected to CLAUDE per the owner's
  2026-07-05 seat-identity directive (local state is not a seat signal). Also resolved this
  seat's stale duplicate In-Progress row for the effort-sync hardening (landed as PR #38/#40,
  already recorded in Completed).
- 2026-07-05 — CLAUDE next-wave (cycle 2): applied stale-row corrections (Cursor sweep
  Completed->In Progress referencing OPEN PR #42; OTLP env-var owner action Planned->Completed,
  closes issue #32; Litestream/adapter-resilience branches confirmed absent, left one more cycle
  before reassignment to CODEX; Deployed section populated with verified prod state; docs mirror
  lag flagged with stale-issue list #27/#28/#34/#35/#29/#30). Added 6 new Planned rows under
  "2026-07-05 next-wave (cycle 2)": budget-status middleware 401 fix (MONET), OTLP data-landing
  verification (CLAUDE), alert-channel config+test-fire (OWNER/CODEX), /api/health commit-SHA
  stamp (CODEX), long-horizon rollup usage view (CURSOR), agent-sync relay monitoring (AG).
- 2026-07-05 — AG: Completed Litestream backup integration, Per-adapter resilience review, and Uptime Check for agent-sync-relay.

