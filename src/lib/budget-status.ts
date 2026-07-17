import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  classifyCostCoverage,
  sumMonthToDateExternalCostByProvider,
  sumMonthToDateExternalCostAttribution,
  sumMonthToDateReceiptCashByProviderId,
  type CostCoverage,
  type ProviderPushedCost,
} from "@/lib/external-usage-events";
import {
  canonicalProviderKey,
  canonicalProjectKey,
  resolveProviderIdentity,
} from "@/lib/provider-identity";
import { buildCanonicalProjectIdMap } from "@/lib/project-resolver";
import { buildProviderAlertState, type ProviderAlert } from "@/lib/provider-alerts";
import { getExternalEventRawCutoff } from "@/lib/data-retention";
import { calculateEomForecast } from "@/lib/forecasting";
import { advancePeriod, isSubscriptionInterval } from "@/lib/subscriptions";
import {
  canLinkSubscriptionToExternalBilling,
  externalBillingFreshnessWindowMs,
  isExternalBillingLinkCandidate,
  resolveExternalBillingPeriod,
} from "@/lib/external-billing-link";
import { deriveGeminiBillingStatus } from "@/lib/gemini-key-status";
import { providerConfigForServer } from "@/lib/provider-secret-config";
import { subscriptionChargeIdempotencyKey } from "@/lib/subscription-charge-identity";

// Budget-status computation for the read endpoint (GET /api/budget-status).
//
// Consuming apps (e.g. Socratic Trade's cost-aware feedback loop) poll this to decide whether to
// throttle spend. Spend is combined across BOTH channels the monitor tracks:
//   - poll snapshots  (UsageSnapshot.totalCost — cumulative cost the poll adapter reported)
//   - pushed telemetry (ExternalUsageEvent.costUsd — month-to-date, the ONLY signal for providers
//     the poll adapters are blind to: Anthropic, Voyage, Robinhood)
// Exact Claude Code OTLP rows are analytics-only API-equivalent estimates and
// are excluded before this cash-spend calculation.
// To avoid double-counting a provider that reports through both channels, per-provider spend uses
// max(snapshotCost, pushedMonthToDate) + fixedMonthlyCost — matching the existing alert convention
// in provider-alerts.ts (which treats fixedMonthlyCost + snapshot.totalCost as the monthly figure).

const WARNING_RATIO = 0.8;

export type BudgetStatusLevel = "ok" | "warning" | "exceeded" | "unconfigured";

export interface ProviderBudgetStatus {
  id: string;
  name: string;
  displayName: string;
  monthlyBudgetUsd: number | null;
  fixedMonthlyCostUsd: number;
  snapshotCostUsd: number | null;
  snapshotCostFetchedAt: string | null;
  snapshotFixedCostIncludedUsd: number;
  snapshotCostIncludesUnknownFixed: boolean;
  pushedMonthToDateUsd: number;
  /** Exact provider-receipt cash paid this UTC month. */
  receiptCashPaidUsd: number;
  receiptCashEventCount: number;
  /** Provider snapshot/pushed variable cost before receipt max-reconciliation. */
  observedVariableUsageUsd: number;
  /** Claude Code's analytics-only API-equivalent estimate; never cash spend. */
  estimatedApiEquivalentUsd: number;
  pushedCostCoverage: CostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  spendCoverage: CostCoverage;
  subscriptionMonthToDateUsd: number;
  fixedAccruedUsd: number;
  linkedFixedDedupeUsd: number;
  fixedCostConflict: boolean;
  forecastedSubscriptionRenewalsUsd: number;
  spentUsd: number;
  projectedEomUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: BudgetStatusLevel;
  alerts: ProviderAlert[];
}

export interface BudgetStatusResponse {
  ok: true;
  generatedAt: string;
  month: string; // YYYY-MM (UTC)
  providers: ProviderBudgetStatus[];
  summary: {
    totalBudgetUsd: number;
    budgetedSpentUsd: number;
    unbudgetedSpentUsd: number;
    totalSpentUsd: number;
    estimatedApiEquivalentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function serverConfig(
  config: unknown,
  encryptedSecretConfig: string | null
): Record<string, unknown> | null {
  try {
    return providerConfigForServer(config, encryptedSecretConfig);
  } catch {
    return null;
  }
}

function monthLabel(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function forecastSubscriptionRenewals(
  subscriptions: Array<{
    costUsd: number;
    currency: string;
    interval: string;
    intervalCount: number;
    nextRenewalAt: Date;
    autoRenew: boolean;
  }>,
  now: Date
): number {
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  let total = 0;
  for (const subscription of subscriptions) {
    if (
      !subscription.autoRenew ||
      subscription.currency.toUpperCase() !== "USD" ||
      !isSubscriptionInterval(subscription.interval)
    ) {
      continue;
    }
    let renewal = subscription.nextRenewalAt;
    let guard = 0;
    while (renewal < monthEnd && guard < 240) {
      if (renewal > now) total += subscription.costUsd;
      renewal = advancePeriod(
        renewal,
        subscription.interval,
        Math.max(1, Math.trunc(subscription.intervalCount))
      );
      guard += 1;
    }
  }
  return total;
}

export async function computeBudgetStatus(now: Date = new Date()): Promise<BudgetStatusResponse> {
  const monthStart = monthStartUtc(now);
  const rawCutoff = getExternalEventRawCutoff(now);

  const [
    providers,
    pushedByProvider,
    receiptCashByProviderId,
    latestCostTimes,
    materializedSubscriptionEvents,
  ] = await Promise.all([
    prisma.provider.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        type: true,
        config: true,
        secretConfig: true,
        isActive: true,
        refreshIntervalMin: true,
        plan: {
          select: {
            billingMode: true,
            fixedMonthlyCostUsd: true,
            monthlyBudgetUsd: true,
            monthlyRequestLimit: true,
            lowBalanceUsd: true,
            lowCredits: true,
            renewalDate: true,
            billingInterval: true,
            mustKeepFunded: true,
          },
        },
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: {
            balance: true,
            totalCost: true,
            fixedCostIncludedUsd: true,
            costWindowStart: true,
            costWindowEnd: true,
            costScope: true,
            costIncludesUnknownFixed: true,
            totalRequests: true,
            credits: true,
            // rawData is deliberately NOT selected here: nothing in this
            // function reads p.snapshots[0].rawData - the two places that
            // need Gemini rawData (geminiStatusSnapshots and
            // latestCostSnapshots below) fetch it themselves, scoped to only
            // the google-ai provider(s). Selecting it here pulled the full
            // adapter raw-response blob for all 39 providers on every call
            // for no reason and was a major contributor to the OOM crash on
            // the 512MB instance (see #392).
            fetchedAt: true,
          },
        },
        subscriptions: {
          where: {
            OR: [
              { status: "active" },
              {
                externalBillingManaged: true,
                lastChargedPeriodStart: { not: null },
              },
            ],
          },
          select: {
            id: true,
            costUsd: true,
            currency: true,
            interval: true,
            intervalCount: true,
            nextRenewalAt: true,
            autoRenew: true,
            externalBillingSource: true,
            externalBillingId: true,
            externalBillingManaged: true,
            currentPeriodStart: true,
            lastChargedPeriodStart: true,
            status: true,
          },
        },
        externalBillingChargeCorrections: {
          where: {
            originalPeriodStart: { gte: monthStart, lte: now },
          },
          orderBy: { observedAt: "desc" },
          select: {
            managedSubscriptionId: true,
            originalPeriodStart: true,
            originalPeriodEnd: true,
            originalAmountUsd: true,
            correctedAmountUsd: true,
            observedAt: true,
          },
        },
        externalBilling: {
          select: {
            source: true,
            externalId: true,
            kind: true,
            status: true,
            amountUsd: true,
            currency: true,
            billingInterval: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            rollupRole: true,
            syncedAt: true,
          },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(monthStart, rawCutoff),
    sumMonthToDateReceiptCashByProviderId(monthStart, rawCutoff, now),
    prisma.usageSnapshot.groupBy({
      by: ["providerId"],
      where: {
        fetchedAt: { gte: monthStart, lte: now },
        totalCost: { not: null },
        AND: [
          {
            OR: [
              { costScope: null },
              { costScope: { not: "daily" } },
            ],
          },
          {
            OR: [
              { costWindowStart: null },
              { costWindowStart: { gte: monthStart } },
            ],
          },
        ],
      },
      _max: { fetchedAt: true },
    }),
    prisma.externalUsageEvent.findMany({
      where: {
        sourceApp: "subscription",
        metricType: "subscription",
        occurredAt: { gte: monthStart, lte: now },
      },
      select: {
        idempotencyKey: true,
        costUsd: true,
        metadata: true,
        occurredAt: true,
        windowStart: true,
        windowEnd: true,
      },
    }),
  ]);

  const geminiProviders = providers.filter(
    (provider) =>
      provider.type.trim().toLowerCase() === "builtin" &&
      canonicalProviderKey(provider.name) === "google-ai"
  );
  // Batched (not per-provider N+1): under the app's single SQLite connection
  // (connection_limit=1, see prisma.ts), N per-provider findFirst calls
  // serialize into N round trips even though they're all issued via
  // Promise.all. One findMany ordered by fetchedAt desc, deduped to the
  // first (=latest) row per providerId in JS, gets the same "latest
  // non-null-rawData snapshot per provider" result in a single query.
  const geminiProviderIds = geminiProviders.map((provider) => provider.id);
  const geminiRawSnapshots = geminiProviderIds.length
    ? await prisma.usageSnapshot.findMany({
        where: {
          providerId: { in: geminiProviderIds },
          rawData: { not: Prisma.DbNull },
        },
        orderBy: { fetchedAt: "desc" },
        select: { providerId: true, rawData: true, fetchedAt: true },
      })
    : [];
  const geminiStatusSnapshots = new Map<
    string,
    { rawData: unknown; fetchedAt: Date }
  >();
  for (const snapshot of geminiRawSnapshots) {
    if (!geminiStatusSnapshots.has(snapshot.providerId)) {
      geminiStatusSnapshots.set(snapshot.providerId, snapshot);
    }
  }

  const materializedChargeByIdempotencyKey = new Map<
    string,
    {
      subscriptionId: string;
      costUsd: number;
      occurredAt: Date;
      windowStart: Date;
      windowEnd: Date;
    }
  >();
  for (const event of materializedSubscriptionEvents) {
    if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      continue;
    }
    const subscriptionId = (event.metadata as Record<string, unknown>).subscriptionId;
    if (
      typeof subscriptionId !== "string" ||
      !event.idempotencyKey ||
      event.costUsd == null ||
      !event.windowStart ||
      !event.windowEnd
    ) {
      continue;
    }
    materializedChargeByIdempotencyKey.set(event.idempotencyKey, {
      subscriptionId,
      costUsd: event.costUsd,
      occurredAt: event.occurredAt,
      windowStart: event.windowStart,
      windowEnd: event.windowEnd,
    });
  }

  const latestCostSnapshots = latestCostTimes.length
    ? await prisma.usageSnapshot.findMany({
        where: {
          OR: latestCostTimes.flatMap((row) =>
            row._max.fetchedAt
              ? [{ providerId: row.providerId, fetchedAt: row._max.fetchedAt }]
              : []
          ),
        },
        orderBy: { fetchedAt: "desc" },
        select: {
          id: true,
          providerId: true,
          fetchedAt: true,
          totalCost: true,
          fixedCostIncludedUsd: true,
          costIncludesUnknownFixed: true,
          // rawData is NOT selected here (see geminiCostRawDataById below) -
          // this query runs for every provider with a cost snapshot this
          // month (typically close to all 39), and rawData is only ever
          // consulted for the google-ai provider's billing-config identity
          // check. Pulling the full blob for every provider just to read it
          // for one was the other half of this endpoint's OOM (see #392).
        },
      })
    : [];
  const latestCostByProviderId = new Map<
    string,
    (typeof latestCostSnapshots)[number]
  >();
  for (const snapshot of latestCostSnapshots) {
    if (!latestCostByProviderId.has(snapshot.providerId)) {
      latestCostByProviderId.set(snapshot.providerId, snapshot);
    }
  }
  // Fetch rawData for only the Gemini provider(s)' picked cost snapshot -
  // the sole consumer is geminiCostIdentityStatus below, which itself
  // short-circuits to null for every non-google-ai provider before touching
  // rawData at all.
  const geminiCostSnapshotIds = geminiProviders
    .map((provider) => latestCostByProviderId.get(provider.id)?.id)
    .filter((id): id is string => typeof id === "string");
  const geminiCostRawDataRows = geminiCostSnapshotIds.length
    ? await prisma.usageSnapshot.findMany({
        where: { id: { in: geminiCostSnapshotIds } },
        select: { id: true, rawData: true },
      })
    : [];
  const geminiCostRawDataById = new Map(
    geminiCostRawDataRows.map((row) => [row.id, row.rawData])
  );

  const providerIdentityCandidates = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    identityPriority:
      (provider.plan?.monthlyBudgetUsd != null ? 4 : 0) +
      (provider.plan ? 2 : 0),
  }));
  const pushedByProviderId = new Map<string, ProviderPushedCost>();
  for (const [producerName, pushed] of pushedByProvider) {
    const owner = resolveProviderIdentity(producerName, providerIdentityCandidates);
    if (!owner) continue;
    const bucket = pushedByProviderId.get(owner.id) ?? {
      usagePushed: 0,
      subscriptionPushed: 0,
      subscriptionPushedManualUsd: 0,
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    bucket.usagePushed += pushed.usagePushed;
    bucket.subscriptionPushed += pushed.subscriptionPushed;
    bucket.subscriptionPushedManualUsd += pushed.subscriptionPushedManualUsd;
    bucket.estimatedApiEquivalentUsd += pushed.estimatedApiEquivalentUsd;
    bucket.pricedEventCount += pushed.pricedEventCount;
    bucket.unpricedEventCount += pushed.unpricedEventCount;
    bucket.unclassifiedCostEventCount += pushed.unclassifiedCostEventCount;
    pushedByProviderId.set(owner.id, bucket);
  }

  const providerStatuses: ProviderBudgetStatus[] = providers.map((p) => {
    const plan = p.plan;
    const latestSnapshot = p.snapshots[0] ?? null;
    const currentBillingConfig = serverConfig(p.config, p.secretConfig);
    const geminiBillingStatus = deriveGeminiBillingStatus({
      providerName: p.name,
      providerType: p.type,
      billingConfig: currentBillingConfig,
      latestSnapshot: geminiStatusSnapshots.get(p.id) ?? null,
    });
    const latestCostSnapshot = latestCostByProviderId.get(p.id) ?? null;
    const geminiCostIdentityStatus = deriveGeminiBillingStatus({
      providerName: p.name,
      providerType: p.type,
      billingConfig: currentBillingConfig,
      latestSnapshot: latestCostSnapshot
        ? {
            rawData: geminiCostRawDataById.get(latestCostSnapshot.id) ?? null,
            fetchedAt: latestCostSnapshot.fetchedAt,
          }
        : null,
    });
    const fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd ?? 0;
    const billingConfigurationChanged =
      geminiBillingStatus?.state === "configuration_changed" ||
      geminiCostIdentityStatus?.state === "configuration_changed";
    const billingSnapshotQuarantined =
      billingConfigurationChanged ||
      geminiBillingStatus?.state === "not_configured" ||
      geminiCostIdentityStatus?.state === "not_configured";
    // A fingerprint mismatch or removed billing configuration means the prior
    // snapshot belongs to an identity that is no longer current. Quarantine it
    // instead of charging old-project dollars to this provider row.
    const snapshotCostUsd = billingSnapshotQuarantined
      ? null
      : latestCostSnapshot?.totalCost ?? null;
    const snapshotFixedCostIncludedUsd = Math.max(
      0,
      Math.min(
        latestCostSnapshot?.fixedCostIncludedUsd ?? 0,
        snapshotCostUsd ?? 0
      )
    );
    const pushed = pushedByProviderId.get(p.id) ?? {
      usagePushed: 0,
      subscriptionPushed: 0,
      subscriptionPushedManualUsd: 0,
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    const pushedMonthToDateUsd = pushed.usagePushed + pushed.subscriptionPushed;
    const receiptCash = receiptCashByProviderId.get(p.id) ?? {
      paidUsd: 0,
      eventCount: 0,
    };
    const pushedCostCoverage = classifyCostCoverage(pushed);
    // Usage-like pushed cost is deduped against the variable portion of the
    // poll snapshot via max(); fixed representations are reconciled below.
    const snapshotVariableCostUsd = Math.max(
      0,
      (snapshotCostUsd ?? 0) - snapshotFixedCostIncludedUsd
    );
    const observedVariableUsageUsd = Math.max(
      snapshotVariableCostUsd,
      pushed.usagePushed
    );
    // API prepaid-funding receipts and observed API usage are overlapping
    // evidence of variable cash spend. Reconcile them with max(), while
    // recurring subscriptions remain additive below.
    const usageCost = Math.max(
      observedVariableUsageUsd,
      receiptCash.paidUsd
    );
    const liveExternalFixed = p.externalBilling.filter((record) => {
      return (
        isExternalBillingLinkCandidate(record, {
          now,
          staleAfterMs: externalBillingFreshnessWindowMs(
            p.refreshIntervalMin
          ),
        }) &&
        record.currentPeriodStart != null &&
        record.currentPeriodStart >= monthStart &&
        record.currentPeriodStart <= now
      );
    });
    const localFixed = p.subscriptions.filter(
      (subscription) => subscription.currency.toUpperCase() === "USD"
    );
    const linkedPeriods = new Map<
      string,
      { materializedUsd: number; representedSnapshotUsd: number; observedAt: Date }
    >();
    const addLinkedPeriod = (
      subscriptionId: string,
      periodStart: Date,
      periodEnd: Date,
      representedSnapshotUsd: number,
      observedAt: Date,
      expectedMaterializedUsd?: number
    ) => {
      const periodKey = `${subscriptionId}\u0000${periodStart.toISOString()}\u0000${periodEnd.toISOString()}`;
      const materialized = materializedChargeByIdempotencyKey.get(
        subscriptionChargeIdempotencyKey(subscriptionId, periodStart)
      );
      if (
        !materialized ||
        materialized.subscriptionId !== subscriptionId ||
        materialized.occurredAt.getTime() !== periodStart.getTime() ||
        materialized.windowStart.getTime() !== periodStart.getTime() ||
        materialized.windowEnd.getTime() !== periodEnd.getTime() ||
        (expectedMaterializedUsd != null &&
          Math.abs(materialized.costUsd - expectedMaterializedUsd) > 1e-6)
      ) {
        return;
      }
      const existing = linkedPeriods.get(periodKey);
      if (!existing || observedAt > existing.observedAt) {
        linkedPeriods.set(periodKey, {
          materializedUsd: materialized.costUsd,
          representedSnapshotUsd,
          observedAt,
        });
      }
    };
    for (const subscription of localFixed) {
      if (!subscription.externalBillingSource || !subscription.externalBillingId) {
        continue;
      }
      const externalRecord = liveExternalFixed.find(
        (record) =>
          record.source === subscription.externalBillingSource &&
          record.externalId === subscription.externalBillingId
      );
      if (externalRecord) {
        const exactCurrentTerms = canLinkSubscriptionToExternalBilling(
          subscription,
          externalRecord
        );
        const chargedManagedCorrection =
          subscription.externalBillingManaged &&
          subscription.lastChargedPeriodStart?.getTime() ===
            subscription.currentPeriodStart.getTime() &&
          externalRecord.currentPeriodStart?.getTime() ===
            subscription.currentPeriodStart.getTime();
        if (exactCurrentTerms || chargedManagedCorrection) {
          const materializedPeriod = exactCurrentTerms
            ? resolveExternalBillingPeriod(externalRecord)!
            : {
                start: subscription.currentPeriodStart,
                end: subscription.nextRenewalAt,
              };
          addLinkedPeriod(
            subscription.id,
            materializedPeriod.start,
            materializedPeriod.end,
            externalRecord.amountUsd ?? 0,
            externalRecord.syncedAt
          );
        }
      }

    }
    // Correction proofs were written only while the provider record was
    // fresh/authoritative and only after verifying one exact local event. They
    // remain historical overlap evidence if the source rolls/stales or an
    // owner later edits/deletes the Subscription row; neither action deletes
    // the already-materialized charge event. Stale evidence cannot create a
    // new proof or settle a new collision.
    for (const correction of p.externalBillingChargeCorrections) {
      addLinkedPeriod(
        correction.managedSubscriptionId,
        correction.originalPeriodStart,
        correction.originalPeriodEnd,
        correction.correctedAmountUsd,
        correction.observedAt,
        correction.originalAmountUsd
      );
    }
    const representedSnapshotFixedUsd = [...linkedPeriods.values()].reduce(
      (sum, period) => sum + period.representedSnapshotUsd,
      0
    );
    // Do not spend proof from one fixed source against an unrelated/partial
    // provider snapshot. The snapshot must cover every represented corrected
    // amount before any exact linked historical events are replaced.
    const linkedMaterializedFixedUsd =
      snapshotFixedCostIncludedUsd + 0.005 >= representedSnapshotFixedUsd
        ? [...linkedPeriods.values()].reduce(
            (sum, period) => sum + period.materializedUsd,
            0
          )
        : 0;
    const linkedSnapshotRepresentationUsd =
      linkedMaterializedFixedUsd > 0 ? representedSnapshotFixedUsd : 0;
    // A provider can correct a fixed charge after the linked historical event
    // materialized. Once an included fixed-cost snapshot exists, subtract the
    // full overlap proven by linked materialized/subscription evidence, even
    // when that old event is larger than a downward-corrected snapshot. This
    // makes $5 historical + $4 corrected snapshot resolve to $4 (and $5 + $6
    // to $6), while never deducting more than either the linked event total or
    // the subscription event channel actually contains.
    //
    // pushed.subscriptionPushed is additive across BOTH the materializer's own
    // sourceApp="subscription" charge (the thing linkedMaterializedFixedUsd
    // proves overlaps the snapshot) AND any manual adjustments (owner-directed
    // historical corrections/refunds, sourceApp != SUBSCRIPTION_SOURCE_APP)
    // that are never represented in the snapshot at all. Dedupe against only
    // the materializer-linked slice — isolated by subtracting the tracked
    // manual contribution — so a manual refund is never cancelled out by this
    // dedupe, and clamp it at 0 so a refund that drives the isolated slice
    // negative can never make the dedupe itself negative and ADD spend back
    // (see subscriptionPushedManualUsd's doc comment in external-usage-events.ts).
    const materializerLinkedSubscriptionPushedUsd = Math.max(
      0,
      pushed.subscriptionPushed - pushed.subscriptionPushedManualUsd
    );
    const linkedFixedDedupeUsd =
      snapshotFixedCostIncludedUsd > 0
        ? Math.min(
            materializerLinkedSubscriptionPushedUsd,
            linkedMaterializedFixedUsd
          )
        : 0;
    const snapshotCostIncludesUnknownFixed =
      snapshotCostUsd != null
        ? latestCostSnapshot?.costIncludesUnknownFixed ?? false
        : false;
    const fixedCostConflict =
      (fixedMonthlyCostUsd > 0 &&
        (pushed.subscriptionPushed > 0 || snapshotFixedCostIncludedUsd > 0)) ||
      Math.min(
        Math.max(
          0,
          snapshotFixedCostIncludedUsd - linkedSnapshotRepresentationUsd
        ),
        Math.max(0, pushed.subscriptionPushed - linkedFixedDedupeUsd)
      ) > 0.005 ||
      (snapshotCostIncludesUnknownFixed && pushed.subscriptionPushed > 0) ||
      linkedMaterializedFixedUsd - linkedFixedDedupeUsd > 0.005;
    // Preserve every distinct fixed source. Collapse only the amount proven to
    // represent the same provider billing identity through an explicit local
    // Subscription link; equal prices alone are never treated as identity.
    const fixedAccruedUsd =
      fixedMonthlyCostUsd +
      pushed.subscriptionPushed +
      snapshotFixedCostIncludedUsd -
      linkedFixedDedupeUsd;
    const spentUsd = fixedAccruedUsd + usageCost;
    const hasPushedEvents =
      pushed.pricedEventCount +
        pushed.unpricedEventCount +
        pushed.unclassifiedCostEventCount >
      0;
    const hasKnownVariableCost =
      pushed.pricedEventCount > 0 ||
      snapshotCostUsd != null ||
      receiptCash.paidUsd > 0;
    const hasUnknownCost =
      pushed.unpricedEventCount > 0 || pushed.unclassifiedCostEventCount > 0;
    let spendCoverage: CostCoverage = hasUnknownCost
      ? hasKnownVariableCost || fixedAccruedUsd > 0
        ? "partial"
        : pushed.unclassifiedCostEventCount > 0
          ? "legacy_unknown"
          : "unknown"
      : hasPushedEvents || snapshotCostUsd != null
        ? "complete"
        : fixedAccruedUsd > 0 || receiptCash.paidUsd > 0
          ? "partial"
          : "unknown";
    // Anthropic individual accounts have no authoritative billing API. A
    // fully priced producer stream is complete for the events received, but
    // cannot prove that every account request reached the monitor. Keep the
    // provider-level cash total explicitly partial until an authoritative
    // organization cost snapshot exists.
    if (
      canonicalProviderKey(p.name) === "anthropic" &&
      snapshotCostUsd == null &&
      hasPushedEvents &&
      spendCoverage === "complete"
    ) {
      spendCoverage = "partial";
    }
    const geminiBillingIncomplete =
      geminiBillingStatus != null && geminiBillingStatus.state !== "ready";
    if (geminiBillingIncomplete && spendCoverage === "complete") {
      spendCoverage =
        hasKnownVariableCost || fixedAccruedUsd > 0 ? "partial" : "unknown";
    }
    const forecastedSubscriptionRenewalsUsd = forecastSubscriptionRenewals(
      p.subscriptions,
      now
    );
    // Receipt funding is a lumpy cash event, not a consumption sample. While
    // it covers the observed variable usage, keep the receipt amount as the
    // variable projection instead of annualizing/month-elapsed extrapolating
    // that deposit. Once observed usage exceeds receipt cash, resume the
    // ordinary usage-rate forecast with the receipt as a lower bound.
    const projectedVariableUsageUsd =
      receiptCash.paidUsd >= observedVariableUsageUsd
        ? receiptCash.paidUsd
        : Math.max(
            receiptCash.paidUsd,
            calculateEomForecast(observedVariableUsageUsd, 0, now)
          );
    const monthlyBudgetUsd = plan?.monthlyBudgetUsd ?? null;

    // Reuse the shared alert logic for budget alerts by feeding the combined usage cost as the
    // snapshot's totalCost (so budget_exceeded/budget_warning reflect BOTH poll + pushed spend).
    const alertState = buildProviderAlertState(
      {
        isActive: p.isActive,
        refreshIntervalMin: p.refreshIntervalMin,
        plan: plan ?? null,
        latestSnapshot: {
          balance: latestSnapshot?.balance ?? null,
          totalCost: usageCost,
          totalRequests: latestSnapshot?.totalRequests ?? null,
          credits: latestSnapshot?.credits ?? null,
          fetchedAt: latestSnapshot?.fetchedAt ?? now,
        },
        trackedSpendUsd: spentUsd,
        fixedAccruedUsd,
      },
      now
    );
    const budgetAlerts = alertState.alerts.filter(
      (a) => a.code === "budget_exceeded" || a.code === "budget_warning"
    );
    if (fixedCostConflict) {
      budgetAlerts.push({
        code: "fixed_cost_conflict",
        severity: "warning",
        message:
          "Provider-reported and manual fixed costs may overlap; link or remove the manual entry after reconciling the provider billing record.",
      });
    }
    if (p.isActive && geminiBillingIncomplete) {
      const message =
        billingConfigurationChanged
          ? "Google Cloud Billing configuration changed; prior-configuration cost is excluded until the new configuration is verified."
          : geminiBillingStatus.state === "error"
          ? "Google Cloud Billing sync failed; spend is last known and coverage is incomplete."
          : geminiBillingStatus.state === "pending"
            ? "Google Cloud Billing export is pending; pending is not $0 and spend coverage is incomplete."
            : geminiBillingStatus.state === "unchecked"
              ? "Google Cloud Billing has not been checked for the current configuration."
              : "Google Cloud Billing is not configured; Gemini API spend coverage is incomplete.";
      budgetAlerts.push({
        code: "billing_sync_incomplete",
        severity:
          billingConfigurationChanged || geminiBillingStatus.state === "error"
            ? "warning"
            : "info",
        message,
      });
    }

    let status: BudgetStatusLevel;
    let remainingUsd: number | null;
    let percentUsed: number | null;
    if (monthlyBudgetUsd == null || monthlyBudgetUsd <= 0) {
      status = "unconfigured";
      remainingUsd = null;
      percentUsed = null;
    } else {
      remainingUsd = monthlyBudgetUsd - spentUsd;
      percentUsed = spentUsd / monthlyBudgetUsd;
      status =
        spentUsd >= monthlyBudgetUsd
          ? "exceeded"
          : spentUsd >= monthlyBudgetUsd * WARNING_RATIO
            ? "warning"
            : "ok";
    }

    return {
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      monthlyBudgetUsd,
      fixedMonthlyCostUsd,
      snapshotCostUsd,
      snapshotCostFetchedAt: billingSnapshotQuarantined
        ? null
        : latestCostSnapshot?.fetchedAt.toISOString() ?? null,
      snapshotFixedCostIncludedUsd,
      snapshotCostIncludesUnknownFixed,
      pushedMonthToDateUsd,
      receiptCashPaidUsd: receiptCash.paidUsd,
      receiptCashEventCount: receiptCash.eventCount,
      observedVariableUsageUsd,
      estimatedApiEquivalentUsd: pushed.estimatedApiEquivalentUsd,
      pushedCostCoverage,
      pushedPricedEventCount: pushed.pricedEventCount,
      pushedUnpricedEventCount: pushed.unpricedEventCount,
      pushedUnclassifiedCostEventCount: pushed.unclassifiedCostEventCount,
      spendCoverage,
      subscriptionMonthToDateUsd: pushed.subscriptionPushed,
      fixedAccruedUsd,
      linkedFixedDedupeUsd,
      fixedCostConflict,
      forecastedSubscriptionRenewalsUsd,
      spentUsd,
      projectedEomUsd:
        fixedAccruedUsd +
        projectedVariableUsageUsd +
        forecastedSubscriptionRenewalsUsd,
      remainingUsd,
      percentUsed,
      status,
      alerts: budgetAlerts,
    };
  });

  const budgeted = providerStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const budgetedSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);
  const totalSpentUsd = providerStatuses.reduce((s, p) => s + p.spentUsd, 0);
  const estimatedApiEquivalentUsd = providerStatuses.reduce(
    (sum, provider) => sum + provider.estimatedApiEquivalentUsd,
    0
  );

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatuses,
    summary: {
      totalBudgetUsd,
      budgetedSpentUsd,
      unbudgetedSpentUsd: totalSpentUsd - budgetedSpentUsd,
      totalSpentUsd,
      estimatedApiEquivalentUsd,
      remainingUsd: totalBudgetUsd - budgetedSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? budgetedSpentUsd / totalBudgetUsd : null,
      overBudget: providerStatuses.some((p) => p.status === "exceeded"),
      warning: providerStatuses.some((p) => p.status === "warning"),
    },
  };
}

export interface ProjectBudgetStatus {
  id: string;
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  projectedEomUsd: number;
  spendCoverage: CostCoverage;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  incompleteAllocatedProviderCount: number;
  // Cost attributed directly to this project — events carrying its projectId
  // (incl. materialized subscription charges) plus the legacy fallback where an
  // untagged event's sourceApp matches this project's name.
  directUsd: number;
  // Cost distributed to this project by ProviderProjectAllocation percentages
  // out of each provider's residual (spend not directly attributed anywhere).
  allocatedUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: BudgetStatusLevel;
}

export interface ProjectBudgetStatusResponse {
  ok: true;
  generatedAt: string;
  month: string;
  providers: ProviderBudgetStatus[];
  projects: ProjectBudgetStatus[];
  summary: {
    totalBudgetUsd: number;
    budgetedSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
    totalSpentUsd: number;
    estimatedApiEquivalentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

export async function computeProjectBudgetStatus(now: Date = new Date()): Promise<ProjectBudgetStatusResponse> {
  const [providerStatus, projects, attribution, identityProviders] = await Promise.all([
    computeBudgetStatus(now),
    prisma.project.findMany({
      include: {
        allocations: true,
      },
      orderBy: { name: "asc" }
    }),
    sumMonthToDateExternalCostAttribution(monthStartUtc(now), getExternalEventRawCutoff(now)),
    prisma.provider.findMany({
      select: {
        id: true,
        name: true,
        plan: { select: { monthlyBudgetUsd: true } },
      },
    }),
  ]);

  // Use the same oldest-row canonical resolver as ingest for the legacy
  // sourceApp-name fallback. Existing alias duplicates are therefore stable
  // even before an operator consolidates them.
  const projectIdByName = buildCanonicalProjectIdMap(projects);

  // Slice the (provider, sourceApp, projectId) triples into:
  //   directByProjectId  — cost attributed to a specific project. A row counts
  //     when it carries a projectId (authoritative), OR — only if untagged —
  //     when its sourceApp matches a known Project.name (legacy behaviour, kept
  //     for back-compat but no longer able to double-count a projectId row).
  //   attributedByProvider — for each provider, the slice of its cost that
  //     landed on SOME project above; subtracted from provider.spentUsd to get
  //     the residual that percentage allocations distribute (this is the fix
  //     for the old code, which subtracted a differently-keyed pushed total).
  const directByProjectId = new Map<string, number>();
  const directFixedByProjectId = new Map<string, number>();
  const directCoverageByProjectId = new Map<
    string,
    {
      pricedEventCount: number;
      unpricedEventCount: number;
      unclassifiedCostEventCount: number;
    }
  >();
  const attributedByProviderId = new Map<string, number>();
  const attributedFixedByProviderId = new Map<string, number>();
  const directVariableByProviderProjectId = new Map<
    string,
    Map<string, number>
  >();
  const totalDirectVariableByProviderId = new Map<string, number>();
  const providerById = new Map(providerStatus.providers.map((p) => [p.id, p]));
  const projectProviderCandidates = identityProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    identityPriority:
      (provider.plan?.monthlyBudgetUsd != null ? 4 : 0) +
      (provider.plan ? 2 : 0),
  }));
  for (const row of attribution) {
    const projectId =
      row.projectId ?? projectIdByName.get(canonicalProjectKey(row.sourceApp)) ?? null;
    if (!projectId) continue;
    const directCoverage = directCoverageByProjectId.get(projectId) ?? {
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    directCoverage.pricedEventCount += row.pricedEventCount;
    directCoverage.unpricedEventCount += row.unpricedEventCount;
    directCoverage.unclassifiedCostEventCount +=
      row.unclassifiedCostEventCount;
    directCoverageByProjectId.set(projectId, directCoverage);
    directByProjectId.set(projectId, (directByProjectId.get(projectId) ?? 0) + row.costUsd);
    const providerOwner = resolveProviderIdentity(
      row.provider,
      projectProviderCandidates
    );
    if (providerOwner) {
      attributedByProviderId.set(
        providerOwner.id,
        (attributedByProviderId.get(providerOwner.id) ?? 0) + row.costUsd
      );
      if (row.metricType !== "subscription") {
        const byProject =
          directVariableByProviderProjectId.get(providerOwner.id) ??
          new Map<string, number>();
        byProject.set(projectId, (byProject.get(projectId) ?? 0) + row.costUsd);
        directVariableByProviderProjectId.set(providerOwner.id, byProject);
        totalDirectVariableByProviderId.set(
          providerOwner.id,
          (totalDirectVariableByProviderId.get(providerOwner.id) ?? 0) + row.costUsd
        );
      }
    }
    if (row.metricType === "subscription") {
      directFixedByProjectId.set(
        projectId,
        (directFixedByProjectId.get(projectId) ?? 0) + row.costUsd
      );
      if (providerOwner) {
        attributedFixedByProviderId.set(
          providerOwner.id,
          (attributedFixedByProviderId.get(providerOwner.id) ?? 0) + row.costUsd
        );
      }
    }
  }

  // A prepaid receipt is a lumpy cash event, not a daily consumption sample.
  // When it covers observed variable usage, apportion that non-forecastable
  // amount first across directly attributed usage and then across the residual
  // that percentage allocations distribute. This keeps the project view
  // consistent with the provider forecast without double-counting receipts.
  const receiptBackedVariableByProviderId = new Map<string, number>();
  const directReceiptBackedByProjectId = new Map<string, number>();
  const directReceiptBackedByProviderId = new Map<string, number>();
  for (const provider of providerStatus.providers) {
    if (provider.receiptCashPaidUsd < provider.observedVariableUsageUsd) continue;
    const receiptBackedVariableUsd = Math.min(
      Math.max(0, provider.spentUsd - provider.fixedAccruedUsd),
      provider.receiptCashPaidUsd
    );
    if (receiptBackedVariableUsd <= 0) continue;
    receiptBackedVariableByProviderId.set(provider.id, receiptBackedVariableUsd);
    const totalDirectVariable = totalDirectVariableByProviderId.get(provider.id) ?? 0;
    const directCovered = Math.min(receiptBackedVariableUsd, totalDirectVariable);
    directReceiptBackedByProviderId.set(provider.id, directCovered);
    if (directCovered <= 0 || totalDirectVariable <= 0) continue;
    for (const [projectId, directVariable] of
      directVariableByProviderProjectId.get(provider.id) ?? []) {
      directReceiptBackedByProjectId.set(
        projectId,
        (directReceiptBackedByProjectId.get(projectId) ?? 0) +
          directCovered * (directVariable / totalDirectVariable)
      );
    }
  }

  const projectStatuses: ProjectBudgetStatus[] = projects.map((proj) => {
    // 1. Direct per-event attribution (projectId, plus legacy name match).
    const directUsd = directByProjectId.get(proj.id) ?? 0;
    const directFixedUsd = directFixedByProjectId.get(proj.id) ?? 0;

    // 2. Percentage allocation of each provider's residual — the spend NOT
    // already directly attributed to any project (fixed fees, poll-snapshot
    // usage, and any untagged pushed telemetry).
    let allocatedUsd = 0;
    let allocatedFixedUsd = 0;
    let allocatedReceiptBackedUsd = 0;
    let allocatedHasKnownCost = false;
    let allocatedHasCurrentUnknownCost = false;
    let allocatedHasLegacyUnknownCost = false;
    let incompleteAllocatedProviderCount = 0;
    for (const alloc of proj.allocations) {
      const provider = providerById.get(alloc.providerId);
      if (!provider) continue;
      const attributed = attributedByProviderId.get(provider.id) ?? 0;
      const residual = Math.max(0, provider.spentUsd - attributed);
      const attributedFixed = attributedFixedByProviderId.get(provider.id) ?? 0;
      const fixedResidual = Math.max(0, provider.fixedAccruedUsd - attributedFixed);
      const ratio = Math.max(0, Math.min(100, alloc.percentage)) / 100;
      if (ratio <= 0) continue;
      allocatedUsd += residual * ratio;
      allocatedFixedUsd += Math.min(residual, fixedResidual) * ratio;
      const receiptBackedResidual = Math.max(
        0,
        (receiptBackedVariableByProviderId.get(provider.id) ?? 0) -
          (directReceiptBackedByProviderId.get(provider.id) ?? 0)
      );
      allocatedReceiptBackedUsd +=
        Math.min(residual, receiptBackedResidual) * ratio;
      if (provider.spendCoverage === "complete") {
        allocatedHasKnownCost = true;
      } else {
        incompleteAllocatedProviderCount += 1;
        if (provider.spendCoverage === "partial") {
          allocatedHasKnownCost = true;
        }
        if (
          provider.spendCoverage === "legacy_unknown" ||
          provider.pushedUnclassifiedCostEventCount > 0
        ) {
          allocatedHasLegacyUnknownCost = true;
        }
        if (
          provider.spendCoverage !== "legacy_unknown" ||
          provider.pushedUnpricedEventCount > 0
        ) {
          allocatedHasCurrentUnknownCost = true;
        }
      }
    }

    const spentUsd = directUsd + allocatedUsd;
    const directReceiptBackedUsd =
      directReceiptBackedByProjectId.get(proj.id) ?? 0;
    const directCoverage = directCoverageByProjectId.get(proj.id) ?? {
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    const hasKnownCost =
      directCoverage.pricedEventCount > 0 || allocatedHasKnownCost;
    const hasCurrentUnknownCost =
      directCoverage.unpricedEventCount > 0 || allocatedHasCurrentUnknownCost;
    const hasLegacyUnknownCost =
      directCoverage.unclassifiedCostEventCount > 0 ||
      allocatedHasLegacyUnknownCost;
    const hasUnknownCost = hasCurrentUnknownCost || hasLegacyUnknownCost;
    const spendCoverage: CostCoverage = hasUnknownCost
      ? hasKnownCost
        ? "partial"
        : hasLegacyUnknownCost && !hasCurrentUnknownCost
          ? "legacy_unknown"
          : "unknown"
      : hasKnownCost
        ? "complete"
        : "unknown";

    let status: BudgetStatusLevel;
    let remainingUsd: number | null;
    let percentUsed: number | null;
    if (proj.monthlyBudgetUsd == null || proj.monthlyBudgetUsd <= 0) {
      status = "unconfigured";
      remainingUsd = null;
      percentUsed = null;
    } else {
      remainingUsd = proj.monthlyBudgetUsd - spentUsd;
      percentUsed = spentUsd / proj.monthlyBudgetUsd;
      status =
        spentUsd >= proj.monthlyBudgetUsd
          ? "exceeded"
          : spentUsd >= proj.monthlyBudgetUsd * WARNING_RATIO
            ? "warning"
            : "ok";
    }

    return {
      id: proj.id,
      name: proj.name,
      description: proj.description,
      monthlyBudgetUsd: proj.monthlyBudgetUsd,
      spentUsd,
      projectedEomUsd: calculateEomForecast(
        spentUsd,
        Math.min(
          spentUsd,
          directFixedUsd +
            allocatedFixedUsd +
            directReceiptBackedUsd +
            allocatedReceiptBackedUsd
        ),
        now
      ),
      spendCoverage,
      ...directCoverage,
      incompleteAllocatedProviderCount,
      directUsd,
      allocatedUsd,
      remainingUsd,
      percentUsed,
      status,
    };
  });

  const budgeted = projectStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const budgetedSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);
  const attributedProjectSpentUsd = projectStatuses.reduce((s, p) => s + p.spentUsd, 0);
  // Provider totals are the money source of truth. Project rows are an
  // attribution view and may intentionally leave some provider spend
  // unassigned (or be over-allocated by operator configuration), so never
  // derive the app-wide total from only the visible project rows.
  const totalSpentUsd = providerStatus.summary.totalSpentUsd;
  const unassignedSpentUsd = Math.max(0, totalSpentUsd - attributedProjectSpentUsd);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatus.providers,
    projects: projectStatuses,
    summary: {
      totalBudgetUsd,
      budgetedSpentUsd,
      unbudgetedSpentUsd: Math.max(0, totalSpentUsd - budgetedSpentUsd),
      unassignedSpentUsd,
      totalSpentUsd,
      estimatedApiEquivalentUsd: providerStatus.summary.estimatedApiEquivalentUsd,
      remainingUsd: totalBudgetUsd - budgetedSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? budgetedSpentUsd / totalBudgetUsd : null,
      overBudget: projectStatuses.some((p) => p.status === "exceeded"),
      warning: projectStatuses.some((p) => p.status === "warning"),
    },
  };
}
