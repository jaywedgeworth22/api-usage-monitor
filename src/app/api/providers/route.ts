import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt, encryptJson } from "@/lib/crypto";
import { parseProviderCreateInput, readJsonBody } from "@/lib/provider-input";
import { buildProviderAlertState } from "@/lib/provider-alerts";
import { computeBudgetStatus } from "@/lib/budget-status";
import { toPrismaProviderPlanData } from "@/lib/provider-plan";
import { canonicalProviderKey } from "@/lib/provider-identity";
import { buildKeyPreview } from "@/lib/provider-key-preview";
import {
  hasProviderSecrets,
  providerConfigForClient,
  providerConfigForServer,
  splitProviderConfig,
} from "@/lib/provider-secret-config";
import {
  hasStoredAnthropicAdminApiKey,
  providerPollSnapshotExpected,
} from "@/lib/anthropic-credentials";
import {
  deriveGeminiBillingStatus,
  deriveGeminiKeyStatus,
  deriveGeminiMonitoringStatus,
} from "@/lib/gemini-key-status";
import { projectGeminiExternalBillingForClient } from "@/lib/gemini-external-billing";
import {
  containsProviderManagementClaim,
  hasStPrimaryCredentialOwnership,
  isReservedStPrimaryManagedLabel,
  providerCredentialManagementForClient,
} from "@/lib/managed-provider-credential";
import type { CostCoverageCaveat } from "@/lib/adapters/helpers";

function decryptKey(encryptedKey: string | null): string | null {
  if (!encryptedKey) return null;
  try {
    return decrypt(encryptedKey);
  } catch {
    return null;
  }
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

/**
 * Batched, DB-side equivalent of snapshot-sync-status.ts's
 * snapshotCostCoverageCaveat for many snapshot ids at once. Uses SQLite's
 * json_extract so only the tiny __apiUsageMonitor.costCoverageCaveat
 * sub-object is pulled out of each row - never the full rawData blob. That
 * blob is a full adapter raw-API-response payload that can be large; reading
 * and JSON-parsing it for all 39 providers' latest snapshot on every list
 * call was the dominant cost of this endpoint and a major contributor to
 * OOM-crashing the 512MB instance (see #392).
 */
async function batchSnapshotCostCoverageCaveats(
  snapshotIds: string[]
): Promise<Map<string, CostCoverageCaveat>> {
  const result = new Map<string, CostCoverageCaveat>();
  const ids = [...new Set(snapshotIds)];
  if (ids.length === 0) return result;

  const rows = await prisma.$queryRaw<
    Array<{ id: string; version: unknown; code: unknown; message: unknown }>
  >(Prisma.sql`
    SELECT
      "id" AS "id",
      json_extract("rawData", '$.__apiUsageMonitor.version') AS "version",
      json_extract("rawData", '$.__apiUsageMonitor.costCoverageCaveat.code') AS "code",
      json_extract("rawData", '$.__apiUsageMonitor.costCoverageCaveat.message') AS "message"
    FROM "UsageSnapshot"
    WHERE "id" IN (${Prisma.join(ids)})
  `);

  for (const row of rows) {
    // json_extract's INTEGER result comes back through $queryRaw as a
    // BigInt (Prisma doesn't know the static type of a computed raw-SQL
    // column, so it plays safe against precision loss) - Number(...) it
    // before comparing, a strict `row.version === 1` silently never matches.
    if (
      Number(row.version) === 1 &&
      typeof row.code === "string" &&
      typeof row.message === "string"
    ) {
      result.set(row.id, { code: row.code, message: row.message });
    }
  }
  return result;
}

export async function GET() {
  const [providers, budget] = await Promise.all([prisma.provider.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      refreshIntervalMin: true,
      groupId: true,
      label: true,
      config: true,
      secretConfig: true,
      apiKey: true,
      createdAt: true,
      allocations: {
        select: {
          projectId: true,
          percentage: true,
        },
      },
      plan: {
        select: {
          id: true,
          billingMode: true,
          fixedMonthlyCostUsd: true,
          monthlyBudgetUsd: true,
          monthlyRequestLimit: true,
          lowBalanceUsd: true,
          lowCredits: true,
          renewalDate: true,
          billingInterval: true,
          mustKeepFunded: true,
          notes: true,
        },
      },
      externalBilling: {
        orderBy: [{ source: "asc" }, { externalId: "asc" }],
        select: {
          source: true,
          externalId: true,
          kind: true,
          serviceName: true,
          planName: true,
          status: true,
          amountUsd: true,
          currency: true,
          billingInterval: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          nextRenewalAt: true,
          requestLimit: true,
          requestLimitWindow: true,
          spendLimitUsd: true,
          spendLimitWindow: true,
          usageQuantity: true,
          remainingQuantity: true,
          usageUnit: true,
          rollupRole: true,
          dateKind: true,
          syncedAt: true,
        },
      },
      snapshots: {
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: {
          id: true,
          balance: true,
          totalCost: true,
          fixedCostIncludedUsd: true,
          costWindowStart: true,
          costWindowEnd: true,
          costScope: true,
          costIncludesUnknownFixed: true,
          totalRequests: true,
          credits: true,
          // rawData is deliberately NOT selected: it's a full adapter raw
          // API-response blob that can be large, and selecting it for every
          // provider's latest snapshot (39x) was the dominant cost of this
          // endpoint's DB read/serialization and a major OOM contributor on
          // the 512MB instance (see #392). The only thing this endpoint
          // derives from rawData is costCoverageCaveat, which is fetched
          // separately below via batchSnapshotCostCoverageCaveats - a
          // SQLite json_extract query that pulls out just that tiny nested
          // field instead of the whole blob.
          fetchedAt: true,
        },
      },
    },
  }), computeBudgetStatus()]);
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
  // non-null-rawData snapshot per provider" result in a single query. This
  // is also run alongside the costCoverageCaveat batch query below.
  const geminiProviderIds = geminiProviders.map((provider) => provider.id);
  const latestSnapshotIds = providers
    .map((provider) => provider.snapshots[0]?.id)
    .filter((id): id is string => typeof id === "string");
  const [geminiRawSnapshots, costCoverageCaveatBySnapshotId] =
    await Promise.all([
      geminiProviderIds.length
        ? prisma.usageSnapshot.findMany({
            where: {
              providerId: { in: geminiProviderIds },
              rawData: { not: Prisma.DbNull },
            },
            orderBy: { fetchedAt: "desc" },
            select: { providerId: true, rawData: true, fetchedAt: true },
          })
        : Promise.resolve([]),
      batchSnapshotCostCoverageCaveats(latestSnapshotIds),
    ]);
  const geminiStatusSnapshots = new Map<
    string,
    { rawData: unknown; fetchedAt: Date }
  >();
  for (const snapshot of geminiRawSnapshots) {
    if (!geminiStatusSnapshots.has(snapshot.providerId)) {
      geminiStatusSnapshots.set(snapshot.providerId, snapshot);
    }
  }
  const budgetByProviderId = new Map(
    budget.providers.map((entry) => [entry.id, entry])
  );
  const duplicateIdsByCanonicalName = new Map<string, string[]>();
  for (const provider of providers) {
    const key = canonicalProviderKey(provider.name);
    const ids = duplicateIdsByCanonicalName.get(key) ?? [];
    ids.push(provider.id);
    duplicateIdsByCanonicalName.set(key, ids);
  }

  // Flatten latest snapshot into the provider object
  const result = providers.map((p) => {
    const { snapshots, apiKey, config, secretConfig, ...rest } = p;
    const clientConfig = providerConfigForClient(config, secretConfig);
    const credentialManagement = providerCredentialManagementForClient(
      config,
      secretConfig
    );
    const credentialManaged = hasStPrimaryCredentialOwnership(
      config,
      secretConfig,
      p.label
    );
    const latestSnapshotRow = snapshots[0] ?? null;
    const latestSnapshot = latestSnapshotRow
      ? {
          balance: latestSnapshotRow.balance,
          totalCost: latestSnapshotRow.totalCost,
          fixedCostIncludedUsd: latestSnapshotRow.fixedCostIncludedUsd,
          costWindowStart: latestSnapshotRow.costWindowStart,
          costWindowEnd: latestSnapshotRow.costWindowEnd,
          costScope: latestSnapshotRow.costScope,
          costIncludesUnknownFixed: latestSnapshotRow.costIncludesUnknownFixed,
          totalRequests: latestSnapshotRow.totalRequests,
          credits: latestSnapshotRow.credits,
          fetchedAt: latestSnapshotRow.fetchedAt,
        }
      : null;
    // Derived from the existing rawData JSON blob rather than a new DB
    // column - see snapshot-sync-status.ts's __apiUsageMonitor metadata bag.
    // Looked up from the batched json_extract query above (keyed by
    // snapshot id) instead of holding the full rawData blob in memory here.
    const costCoverageCaveat = latestSnapshotRow
      ? costCoverageCaveatBySnapshotId.get(latestSnapshotRow.id) ?? null
      : null;
    const decryptedKey = decryptKey(apiKey);
    const adapterConfig = serverConfig(config, secretConfig);
    const geminiStatusSnapshot = geminiStatusSnapshots.get(p.id) ?? null;
    const geminiBillingStatus = deriveGeminiBillingStatus({
      providerName: p.name,
      providerType: p.type,
      billingConfig: adapterConfig,
      latestSnapshot: geminiStatusSnapshot,
    });
    const geminiKeyStatus = deriveGeminiKeyStatus({
      providerName: p.name,
      providerType: p.type,
      apiKey: decryptedKey,
      apiKeyConfigured: apiKey != null,
      latestSnapshot: geminiStatusSnapshot,
    });
    const geminiMonitoringStatus = deriveGeminiMonitoringStatus({
      providerName: p.name,
      providerType: p.type,
      monitoringConfig: adapterConfig,
      latestSnapshot: geminiStatusSnapshot,
    });
    const externalBilling = projectGeminiExternalBillingForClient(
      rest.externalBilling,
      geminiBillingStatus,
      geminiKeyStatus
    );
    const alertState = buildProviderAlertState({
      isActive: p.isActive,
      refreshIntervalMin: p.refreshIntervalMin,
      snapshotExpected: providerPollSnapshotExpected({
        name: p.name,
        type: p.type,
        apiKey,
        config,
        secretConfig,
      }),
      plan: p.plan,
      latestSnapshot,
    });
    const canonicalBudget = budgetByProviderId.get(p.id);
    const nonBudgetAlerts = alertState.alerts.filter(
      (alert) =>
        alert.code !== "budget_exceeded" && alert.code !== "budget_warning"
    );
    const alerts =
      canonicalBudget && p.isActive
        ? [...nonBudgetAlerts, ...canonicalBudget.alerts]
        : alertState.alerts;
    const duplicateProviderIds = duplicateIdsByCanonicalName.get(
      canonicalProviderKey(p.name)
    ) ?? [];

    return {
      ...rest,
      externalBilling,
      ...clientConfig,
      credentialManagement,
      keyPreview: credentialManaged ? null : buildKeyPreview(decryptedKey),
      geminiKeyStatus,
      geminiBillingStatus,
      geminiMonitoringStatus,
      anthropicAdminApiConfigured: hasStoredAnthropicAdminApiKey({
        name: p.name,
        apiKey,
        config,
        secretConfig,
      }),
      latestSnapshot,
      // Distinct from spendCoverage/pushedCostCoverage below - see
      // CostCoverageCaveat in adapters/helpers.ts for why these must not be
      // conflated.
      costCoverageCaveat,
      alerts,
      estimatedMonthlyCostUsd: alertState.estimatedMonthlyCostUsd,
      spentUsd: canonicalBudget?.spentUsd ?? latestSnapshot?.totalCost ?? 0,
      snapshotCostUsd: canonicalBudget?.snapshotCostUsd ?? latestSnapshot?.totalCost ?? null,
      snapshotCostFetchedAt: canonicalBudget?.snapshotCostFetchedAt ?? null,
      snapshotFixedCostIncludedUsd:
        canonicalBudget?.snapshotFixedCostIncludedUsd ?? 0,
      snapshotCostIncludesUnknownFixed:
        canonicalBudget?.snapshotCostIncludesUnknownFixed ?? false,
      pushedMonthToDateUsd: canonicalBudget?.pushedMonthToDateUsd ?? 0,
      receiptCashPaidUsd: canonicalBudget?.receiptCashPaidUsd ?? 0,
      receiptCashEventCount: canonicalBudget?.receiptCashEventCount ?? 0,
      observedVariableUsageUsd:
        canonicalBudget?.observedVariableUsageUsd ?? 0,
      estimatedApiEquivalentUsd:
        canonicalBudget?.estimatedApiEquivalentUsd ?? 0,
      pushedCostCoverage: canonicalBudget?.pushedCostCoverage ?? "unknown",
      pushedPricedEventCount: canonicalBudget?.pushedPricedEventCount ?? 0,
      pushedUnpricedEventCount: canonicalBudget?.pushedUnpricedEventCount ?? 0,
      pushedUnclassifiedCostEventCount:
        canonicalBudget?.pushedUnclassifiedCostEventCount ?? 0,
      spendCoverage:
        canonicalBudget?.spendCoverage ??
        (latestSnapshot?.totalCost != null ? "complete" : "unknown"),
      subscriptionMonthToDateUsd:
        canonicalBudget?.subscriptionMonthToDateUsd ?? 0,
      fixedMonthlyCostUsd: canonicalBudget?.fixedMonthlyCostUsd ?? 0,
      fixedAccruedUsd: canonicalBudget?.fixedAccruedUsd ?? 0,
      linkedFixedDedupeUsd: canonicalBudget?.linkedFixedDedupeUsd ?? 0,
      fixedCostConflict: canonicalBudget?.fixedCostConflict ?? false,
      forecastedSubscriptionRenewalsUsd:
        canonicalBudget?.forecastedSubscriptionRenewalsUsd ?? 0,
      projectedEomUsd: canonicalBudget?.projectedEomUsd ?? alertState.projectedEomUsd,
      billingMode: alertState.billingMode,
      duplicateNameWarning:
        duplicateProviderIds.length > 1
          ? { providerIds: [...duplicateProviderIds].sort() }
          : null,
    };
  });

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  let input;
  try {
    input = parseProviderCreateInput(await readJsonBody(request));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  if (
    containsProviderManagementClaim(input.config) ||
    isReservedStPrimaryManagedLabel(input.label)
  ) {
    return NextResponse.json(
      { error: "Provider credential-management metadata is server-only" },
      { status: 400 }
    );
  }

  let groupId = input.groupId;

  if (!groupId) {
    const existingWithSameName = await prisma.provider.findFirst({
      where: { name: input.name },
      orderBy: { createdAt: "asc" },
    });

    if (existingWithSameName) {
      if (existingWithSameName.groupId) {
        groupId = existingWithSameName.groupId;
      } else {
        groupId = input.name;
        await prisma.provider.updateMany({
          where: { name: input.name, groupId: null },
          data: { groupId },
        });
      }
    }
  }

  const encryptedKey = input.apiKey ? encrypt(input.apiKey) : null;
  const splitConfig = splitProviderConfig(input.config);

  const provider = await prisma.provider.create({
    data: {
      name: input.name,
      displayName: input.displayName,
      type: input.type,
      apiKey: encryptedKey,
      config: Object.keys(splitConfig.publicConfig).length > 0
        ? (splitConfig.publicConfig as Prisma.InputJsonObject)
        : undefined,
      secretConfig: hasProviderSecrets(splitConfig.secretConfig)
        ? encryptJson(splitConfig.secretConfig)
        : null,
      refreshIntervalMin: input.refreshIntervalMin,
      groupId,
      label: input.label,
      plan: input.plan
        ? { create: toPrismaProviderPlanData(input.plan) }
        : undefined,
      allocations: input.allocations
        ? {
            create: input.allocations.map((a) => ({
              projectId: a.projectId,
              percentage: a.percentage,
            })),
          }
        : undefined,
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      refreshIntervalMin: true,
      groupId: true,
      label: true,
      allocations: {
        select: {
          projectId: true,
          percentage: true,
        },
      },
      plan: true,
      createdAt: true,
    },
  });

  return NextResponse.json(provider, { status: 201 });
}
