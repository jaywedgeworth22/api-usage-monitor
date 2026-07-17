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
import { snapshotCostCoverageCaveat } from "@/lib/snapshot-sync-status";

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
    },
  }), computeBudgetStatus()]);
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
    const latestSnapshotWithRawData = snapshots[0] ?? null;
    const latestSnapshot = latestSnapshotWithRawData
      ? {
          balance: latestSnapshotWithRawData.balance,
          totalCost: latestSnapshotWithRawData.totalCost,
          fixedCostIncludedUsd: latestSnapshotWithRawData.fixedCostIncludedUsd,
          costWindowStart: latestSnapshotWithRawData.costWindowStart,
          costWindowEnd: latestSnapshotWithRawData.costWindowEnd,
          costScope: latestSnapshotWithRawData.costScope,
          costIncludesUnknownFixed:
            latestSnapshotWithRawData.costIncludesUnknownFixed,
          totalRequests: latestSnapshotWithRawData.totalRequests,
          credits: latestSnapshotWithRawData.credits,
          fetchedAt: latestSnapshotWithRawData.fetchedAt,
        }
      : null;
    // Derived from the existing rawData JSON blob rather than a new DB
    // column - see snapshot-sync-status.ts's __apiUsageMonitor metadata bag.
    const costCoverageCaveat = snapshotCostCoverageCaveat(
      latestSnapshotWithRawData?.rawData ?? null
    );
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
