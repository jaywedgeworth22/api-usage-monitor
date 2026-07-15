import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  classifyCostCoverage,
  sumMonthToDateExternalCostByProvider,
  sumMonthToDateExternalCostAttribution,
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

// Budget-status computation for the read endpoint (GET /api/budget-status).
//
// Consuming apps (e.g. Agentic Trading's cost-aware feedback loop) poll this to decide whether to
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

  const [providers, pushedByProvider, latestCostTimes, materializedSubscriptionEvents] = await Promise.all([
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
            rawData: true,
            fetchedAt: true,
          },
        },
        subscriptions: {
          where: { status: "active" },
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
            status: true,
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
        costUsd: true,
        metadata: true,
        occurredAt: true,
        windowEnd: true,
      },
    }),
  ]);

  const geminiProviders = providers.filter(
    (provider) =>
      provider.type.trim().toLowerCase() === "builtin" &&
      canonicalProviderKey(provider.name) === "google-ai"
  );
  const geminiStatusSnapshots = new Map(
    await Promise.all(
      geminiProviders.map(async (provider) => [
        provider.id,
        await prisma.usageSnapshot.findFirst({
          where: {
            providerId: provider.id,
            rawData: { not: Prisma.DbNull },
          },
          orderBy: { fetchedAt: "desc" },
          select: { rawData: true, fetchedAt: true },
        }),
      ] as const)
    )
  );

  const materializedCostBySubscriptionPeriod = new Map<string, number>();
  for (const event of materializedSubscriptionEvents) {
    if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      continue;
    }
    const subscriptionId = (event.metadata as Record<string, unknown>).subscriptionId;
    if (
      typeof subscriptionId !== "string" ||
      event.costUsd == null ||
      !event.windowEnd
    ) {
      continue;
    }
    const periodKey = `${subscriptionId}\u0000${event.occurredAt.toISOString()}\u0000${event.windowEnd.toISOString()}`;
    materializedCostBySubscriptionPeriod.set(
      periodKey,
      (materializedCostBySubscriptionPeriod.get(periodKey) ?? 0) +
        event.costUsd
    );
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
          providerId: true,
          fetchedAt: true,
          totalCost: true,
          fixedCostIncludedUsd: true,
          costIncludesUnknownFixed: true,
          rawData: true,
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
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    bucket.usagePushed += pushed.usagePushed;
    bucket.subscriptionPushed += pushed.subscriptionPushed;
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
      latestSnapshot: latestCostSnapshot,
    });
    const fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd ?? 0;
    const billingConfigurationChanged =
      geminiBillingStatus?.state === "configuration_changed" ||
      geminiCostIdentityStatus?.state === "configuration_changed";
    // A fingerprint mismatch means the prior snapshot belongs to another
    // dataset/project/service-account identity. Quarantine it instead of
    // charging old-project dollars to the newly configured provider row.
    const snapshotCostUsd = billingConfigurationChanged
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
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    const pushedMonthToDateUsd = pushed.usagePushed + pushed.subscriptionPushed;
    const pushedCostCoverage = classifyCostCoverage(pushed);
    // Usage-like pushed cost is deduped against the variable portion of the
    // poll snapshot via max(); fixed representations are reconciled below.
    const snapshotVariableCostUsd = Math.max(
      0,
      (snapshotCostUsd ?? 0) - snapshotFixedCostIncludedUsd
    );
    const usageCost = Math.max(snapshotVariableCostUsd, pushed.usagePushed);
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
    let linkedMaterializedFixedUsd = 0;
    for (const subscription of localFixed) {
      if (!subscription.externalBillingSource || !subscription.externalBillingId) continue;
      const externalRecord = liveExternalFixed.find(
        (record) =>
          record.source === subscription.externalBillingSource &&
          record.externalId === subscription.externalBillingId
      );
      if (
        !externalRecord ||
        !canLinkSubscriptionToExternalBilling(subscription, externalRecord)
      ) {
        continue;
      }
      const externalPeriod = resolveExternalBillingPeriod(externalRecord)!;
      const periodKey = `${subscription.id}\u0000${externalPeriod.start.toISOString()}\u0000${externalPeriod.end.toISOString()}`;
      linkedMaterializedFixedUsd +=
        materializedCostBySubscriptionPeriod.get(periodKey) ?? 0;
    }
    const linkedFixedDedupeUsd = Math.min(
      snapshotFixedCostIncludedUsd,
      pushed.subscriptionPushed,
      linkedMaterializedFixedUsd
    );
    const snapshotCostIncludesUnknownFixed =
      snapshotCostUsd != null
        ? latestCostSnapshot?.costIncludesUnknownFixed ?? false
        : false;
    const fixedCostConflict =
      (fixedMonthlyCostUsd > 0 &&
        (pushed.subscriptionPushed > 0 || snapshotFixedCostIncludedUsd > 0)) ||
      Math.min(snapshotFixedCostIncludedUsd, pushed.subscriptionPushed) -
        linkedFixedDedupeUsd >
        0.005 ||
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
    const hasKnownVariableCost = pushed.pricedEventCount > 0 || snapshotCostUsd != null;
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
        : fixedAccruedUsd > 0
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
      snapshotCostFetchedAt: billingConfigurationChanged
        ? null
        : latestCostSnapshot?.fetchedAt.toISOString() ?? null,
      snapshotFixedCostIncludedUsd,
      snapshotCostIncludesUnknownFixed,
      pushedMonthToDateUsd,
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
        calculateEomForecast(spentUsd, fixedAccruedUsd, now) +
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

  const providerById = new Map(providerStatus.providers.map((p) => [p.id, p]));

  const projectStatuses: ProjectBudgetStatus[] = projects.map((proj) => {
    // 1. Direct per-event attribution (projectId, plus legacy name match).
    const directUsd = directByProjectId.get(proj.id) ?? 0;
    const directFixedUsd = directFixedByProjectId.get(proj.id) ?? 0;

    // 2. Percentage allocation of each provider's residual — the spend NOT
    // already directly attributed to any project (fixed fees, poll-snapshot
    // usage, and any untagged pushed telemetry).
    let allocatedUsd = 0;
    let allocatedFixedUsd = 0;
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
        Math.min(spentUsd, directFixedUsd + allocatedFixedUsd),
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
