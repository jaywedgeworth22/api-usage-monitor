# Cloudflare legacy Subscription exact handoff

Date: 2026-07-15

## Outcome

Maintenance has a default-off, exact-UUID migration path for the previously
owner-entered Congress.Trade Cloudflare Workers Paid `Subscription`. It adopts
management of the existing row in place rather than creating another recurring
charge or changing the idempotency basis of its materialized history.

## Guarded authority

`CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID` must contain one canonical UUID.
Unset is disabled and malformed values are inert. After taking the SQLite
writer lock and re-reading current state, maintenance requires all of these:

- the target belongs to the active built-in provider named exactly `cloudflare`;
- the link is exactly `cloudflare-subscriptions` plus a present external ID;
- that exact external record is fresh, current, known-live, canonical,
  `paidRecurringAuthoritative`, positive exact-cent USD, and has one complete
  supported cadence period;
- local cents, currency, cadence/count, and current period match the provider;
- no positive ProviderPlan fixed fee, second eligible same-shaped record,
  same-shaped local row, or adoption-guard owner exists; a placeholder plan
  without a positive fixed fee is allowed;
- the legacy guard is null and the active owner row has not already
  relinquished or accepted management;
- its watermark equals the current period and the deterministic subscription
  event exactly matches provider, preserved display name, project, amount,
  complete window, billing fields, and materializer metadata.

Failure returns only a bounded status enum. The result never contains the
configured UUID, provider ID, external ID, raw environment value, or billing
payload. Disabled, handed-off, and already-managed are healthy maintenance
states. Every other configured status marks the scheduler cycle unhealthy so a
bad or obsolete flag cannot persist silently; it does not synthesize a provider
alert or couple the result to PagerDuty delivery.

## In-place mutation and lifecycle

Success changes only `externalBillingManaged=true`, `autoRenew=false`, and the
exact candidate `externalAdoptionGuardKey`. The Subscription ID, source link,
owner display name, description, project, price/currency/cadence, start/current
dates, watermark, status, notes, knobs, event, and all prior history stay
unchanged. Re-running an already managed target is a no-op. If an owner later
sets it unmanaged, the non-null guard is durable relinquishment evidence and
the configured flag cannot retake it.

The normal managed-subscription reconciler preserves this exact legacy display
name while continuing to require money/window exactness. A fresh next provider
period advances the same UUID and materializes one event; current-period and
replay calls remain no-ops under the existing deterministic key and watermark.

## Verification coverage

- default-off and invalid-UUID no-op
- exact live-shaped display-name mismatch with in-place field/history proof
- wrong/inactive provider, wrong identity, stale authority, term mismatch,
  positive fixed ProviderPlan fee, missing event/watermark, and guard/shape
  collision, plus the exact harmless placeholder-plan success shape
- writer-lock re-read of a concurrent owner guard edit
- already-managed idempotency and permanent owner relinquishment
- next provider period writes exactly one event on the same Subscription UUID
- maintenance success/degraded result compatibility
- configured blocked-status scheduler health without provider-alert creation

No production environment, database, provider, PagerDuty, push, merge, or
deployment was changed by this implementation lane.
