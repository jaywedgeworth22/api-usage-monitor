# 2026-07-11 — app-wide hardening and direct billing integrations

Branch: `codex-app-wide-hardening`

Status at handoff: implemented and fully verified in the isolated worktree. No production database write, merge, or deploy was performed.

## What changed

- Replaced cumulative-OTLP overcount with durable cumulative-to-delta checkpoints, strict temporality/timestamp/non-negative validation, bounded request bodies, collision-safe attribution backfill, permanent rollup tombstones, streaming summaries, bounded raw snapshot responses, and a hard cumulative-series capacity limit that preserves replay protection.
- Made provider cost snapshots period-aware. Budget math carries the latest compatible non-null current-month total through partial polls, excludes prior-month/daily windows, includes inactive push-provider spend, forecasts known subscription renewals through month-end, reports unassigned project spend, and exposes fixed-cost conflicts rather than hiding them.
- Added explicit local `Subscription` -> provider billing identity links. Provider and manual fixed costs are additive unless `(source, externalId)`, amount, and cadence prove they are the same charge. Paused/canceled subscriptions now offer distinct `repurchase` and `resume paid-through term` activation paths.
- Added or hardened official direct billing/account integrations for OpenAI, Anthropic, xAI, Mistral, Cloudflare, Twilio, Apify, Stripe, GitHub, Vercel, Render, and Hetzner. Complete feeds fail closed on malformed or truncated responses; independent xAI/Mistral capabilities reconcile separately. See `docs/direct-billing-integrations.md` for credentials and authoritative boundaries.
- Encrypted secondary provider credentials, removed credential-shaped config from client DTOs, denied redirects/private-network SSRF targets, bounded adapter responses/timeouts/retries, and prevented timed-out/superseded provider attempts from committing stale billing state.
- Persisted alert delivery per destination, added bounded retry/timeout behavior, and added stable PagerDuty trigger/resolve correlation so one failed channel does not replay successful channels.
- Hardened runtime/deploy safety: Node 24 pin, additive migration guard, readiness that detects stalls/staleness/repeated failures without restart-looping on one transient failure, startup/backup enforcement, security headers, CI/CodeQL/Dependabot, and deploy-safe Render configuration.
- Improved desktop/mobile UX, accessibility, dialogs, responsive tables/navigation, stale external-billing indicators, UTC billing dates, canonical dashboard/project totals, and subscription/provider setup help.
- Added stable producer delivery IDs and retry-safe payload/timestamps in the separate Socratic.Trade branch `codex-usage-telemetry-idempotency`.

## Direct-connection boundaries

Authoritative costs/status are read only from official provider APIs. External billing records never create charges on their own. Local subscriptions remain the charge source of truth unless explicitly identity-linked for deduplication.

No safe non-billable account API was found for Voyage AI, FMP, Finnhub, Alpha Vantage, Tiingo, Marketstack, Massive/Polygon, Fintech Studios, or Robinhood retail. Their adapters now avoid fake usage probes and use pushed telemetry or manual plans/subscriptions. Google Cloud Billing requires a separate Cloud identity/billing-export integration; a Gemini API key is insufficient. Pinecone exposes console usage-report downloads rather than a documented billing API.

## Verification

Final serialized `npm run verify` under Node 24.14.0:

- ESLint: pass
- TypeScript: pass
- Vitest: 45 files / 251 tests pass
- additive/no-op/destructive migration harness: all three scenarios pass
- startup configuration checks: pass
- Next.js 15 production build: pass

Focused direct-adapter/accounting/retention/alert suites also passed throughout integration. Browser QA passed on a temporary SQLite database for login, desktop dashboard, 390px mobile dashboard/navigation, Settings/subscription modal, explicit external-billing linkage, repurchase/resume behavior, UTC renewal rendering, and console errors (none).

## Production follow-through

Before deployment, review the PR and Render environment/disk backup state. Provider integrations become active only when their documented provider config and encrypted credentials are supplied. Keep `OTLP_MAX_CUMULATIVE_SERIES` at its default unless observed series cardinality justifies a deliberate increase. The production database repair command for historical Claude cumulative cost remains a separate dry-run-first operator action (`npm run repair:claude-cost`).
