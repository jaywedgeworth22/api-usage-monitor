# API-usage-monitor Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board:
`/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (mirror: this file). As of 2026-07-04.

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
- **Ingest-auth refactor + ESLint setup (MONET) — PR pending, 2026-07-05.** Wired the
  `budget-status` and `ingest/usage` routes onto the shared `@/lib/ingest-auth` helpers
  (`tokenFromRequest`/`safeEqual`/`isUsageIngestAuthorized`), removing duplicated token-auth code.
  Adds flat-config ESLint (`eslint.config.mjs`) + deps + a CI lint step, a rate-limit
  in-process-only caveat note, `.cursor/` gitignore, and a README. Carried from an uncommitted
  Cursor working set, rebased clean onto `main`.
- **Effort-issues sync secondary-rate-limit hardening (CLAUDE) — PR #38, 2026-07-05.** Verbatim propagation of the fleet-standard `scripts/sync-effort-issues.py` hardening from Socratic.Trade: 2.5s creation throttle, Retry-After/exponential-backoff retries under a bounded 300s per-run budget, and exit-0 "PARTIAL SYNC — resume on next run" summary on budget exhaustion (bulk issue creation previously 403'd on GitHub's secondary rate limit and hard-failed the sync workflow; the sync is idempotent, so a partial pass resumes cleanly on the next run). Lands with this PR.
  Review refinements re-propagated via PR #40 (merged 2026-07-05): issue listing inside
  partial handling, server-sent Retry-After honored uncapped, 1s update throttle.
- **Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S) — completed 2026-07-05
  (CLAUDE next-wave correction, moved from Planned).** All five `OTEL_*`/
  `CLAUDE_CODE_ENABLE_TELEMETRY` vars are set in `~/.claude/settings.json`; embedded bearer token
  verified live against prod ingest (empty OTLP POST -> 202 authed, 401 unauthed). Issue #32
  closes with this. Data-flow confirmation (real `ExternalUsageEvent` rows / `anthropic` provider
  actually populated) is tracked separately as a new Planned row below — auth-accepted is not the
  same claim as data-landed.
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
- **Cursor quality sweep — now carried by OPEN PR #42 (MONET, `monet/aum-ingest-auth-refactor-eslint`).**
  _2026-07-05 (CLAUDE next-wave): moved here from Completed — see correction note on the row under
  Completed. #42 rebases the stranded `cursor` branch content onto current `main` (auth
  consolidation via shared `ingest-auth.ts`, ESLint config, CI test step, README, etc.). Move to
  Completed only when #42 merges; issues #22-#26 close then, not before._
- **Litestream backup for the Render SQLite disk (CLAUDE, was AG) — IN PROGRESS 2026-07-05.**
  Branch `claude/litestream-render-backup`. Adapting the Socratic.Trade `litestream.yml`/R2
  pattern to this app's Render deployment: litestream binary fetched at build, startCommand
  wrapper (`litestream replicate -exec` when LITESTREAM_* env set, plain `npm start`
  passthrough otherwise — opt-in, zero behavior change until owner configures R2), restore
  script + docs, render.yaml env plumbing. _2026-07-05 (CLAUDE): picked up from the AG
  reservation per owner-directed session ("work all assigned tasks"); AG inactive in this
  repo since the 2026-07-04 seed — renegotiated in #agent-sync, will yield if AG already started._
  **2026-07-05 (CLAUDE next-wave): CORRECTION — branch does not exist, locally or on origin.**
  The only candidate work sites are two clean MONET worktrees
  (`monet-awesome-pascal-259e1e`, `monet-strange-kare-d779d5`) parked at `16aab87` with zero
  commits and zero dirty files — no visible progress toward this row. Seat attribution also
  conflicts: this row says CLAUDE post-correction, but the worktrees and all recent activity are
  MONET-named. Leaving IN PROGRESS one more cycle per the reassignment threshold below; if still
  no commits next cycle, treat this reservation as dead, release it, and hand it to CODEX (idle
  since PR #33 merged ~24h ago, natural fit for Render/litestream plumbing).
- **Per-adapter resilience review (CLAUDE, was AG) — IN PROGRESS 2026-07-05.** Branch
  `claude/adapter-resilience`. Timeouts + 429/Retry-After-aware bounded backoff centralized in
  `src/lib/adapters/helpers.ts` `fetchJson`, per-provider timeout + partial-failure isolation
  in `fetchAllDueProviders` (today a hung fetch has no timeout and stalls the whole 15-min
  poll loop), sweep all ~33 adapters onto the hardened path, vitest coverage. _Same
  reassignment note as the Litestream row._
  **2026-07-05 (CLAUDE next-wave): CORRECTION — same as the Litestream row above: branch does
  not exist locally or on origin, and the two clean MONET worktrees parked at `16aab87` show zero
  commits toward it.** Seat attribution conflict noted (board says CLAUDE, worktrees say MONET) —
  reconcile per the owner's 2026-07-05 seat-identity directive (local state is not a seat signal)
  before reassigning. If still no commits by next cycle, treat as a dead reservation and release;
  this is a mechanical sweep over a hardened `fetchJson`, suited to a mid-tier lane (CODEX is idle).

## Planned / Reserved

- **End-of-Month Spend Forecasting (unassigned, S)** — IDEA: Add a simple linear extrapolation algorithm based on the `UsageSnapshotDailyRollup` data to project EOM spend and display it on the dashboard as `Projected EOM Spend: $X`.
- **Dark Mode Support (unassigned, S)** — IDEA: Add standard CSS dark mode via media queries to support dark mode on the frontend dashboard without breaking the current UI.
- **Email/PagerDuty Alerting (unassigned, M)** — IDEA: PR #33 added Slack/webhook delivery channels. Expand this to support email alerting (via Resend/SendGrid) or PagerDuty integration for critical budget breaches.
**2026-07-05 (CLAUDE next-wave): CORRECTION — this mirror lagged the live board.** In Progress:
previously showed none, despite the live board having active rows. Because the issues-sync
workflow only closes an issue when the *mirror* row moves to Completed, the lag kept merged
work's issues open and created duplicates: issues #27/#28 plus duplicate #34/#35 (Codex
retention/alerts, actually merged as PR #33) are stale, and #29/#30 (AG rows since reassigned
away) are stale. This PR reconciles the mirror so the push-triggered sync auto-closes completed
issues; #34/#35 should be manually closed as title-drift duplicates of #27/#28 with a note.

- CI standard adoption (cross-app, Claude) — RESERVED: 5-line caller workflow consuming the Socratic.Trade reusable verify gate + Mac runner registration. Blocked by: claude/ci-actions-efficiency landing in the hub repo.

_2026-07-04 backlog exhaustiveness pass (CLAUDE, owner-directed). Tags: CURSOR = Cursor background
agents (DeepSeek v4 Pro), CODEX = Codex, AG = Antigravity/Gemini. Assignments are reservations,
not locks — re-negotiate in #agent-sync._

- **Implement OTLP logs ingestion (unassigned, L, deliberately deferred)** — `/api/otlp/v1/logs`
  is accept-and-drop by design today.

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
- **Monitor the agent-sync relay endpoint from the usage monitor; keep its token docs in fleet infra (AG, M)**
  — `agent-sync.jays.services` (Mac-local PM2 `agent-sync-push`, now with the authed `/post`
  endpoint) is fleet-critical with zero monitoring — add it as a monitored endpoint (custom adapter or
  a lightweight uptime check) with a stale/down alert via the new delivery channels. Documentation
  ruling: `AGENT_SYNC_POST_TOKEN`/`URL` config stays canonical in `/Users/jay/apps/AGENT-SYNC.md`
  (already done by CODEX) — do NOT duplicate secrets/config into this repo; this repo's role is
  watching the endpoint, not documenting it. _(why now: The `/post` endpoint went live on the Mac
  today; every remote agent now depends on it, and an outage would silently break fleet coordination.
  This app is literally the fleet's monitoring surface. Also answers the open question of where the
  token/config should be documented: fleet infra, which already has it. AG is idle in this repo and
  this is self-contained.)_

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
- 2026-07-05 — CLAUDE next-wave (cycle 2): reconciled this mirror against the live board
  (`/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md`), which had drifted ahead. Applied stale-row
  corrections (Cursor sweep Completed->In Progress referencing OPEN PR #42; OTLP env-var owner
  action Planned->Completed, closes issue #32; Litestream/adapter-resilience branches confirmed
  absent, left one more cycle before reassignment to CODEX; Deployed section populated with
  verified prod state; mirror-lag itself flagged with stale-issue list #27/#28/#34/#35/#29/#30).
  Added 6 new Planned rows under "2026-07-05 next-wave (cycle 2)": budget-status middleware 401
  fix (MONET), OTLP data-landing verification (CLAUDE), alert-channel config+test-fire
  (OWNER/CODEX), /api/health commit-SHA stamp (CODEX), long-horizon rollup usage view (CURSOR),
  agent-sync relay monitoring (AG).
