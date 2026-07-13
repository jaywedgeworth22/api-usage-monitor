import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt, encryptJson } from "@/lib/crypto";
import { parseProviderCreateInput, readJsonBody } from "@/lib/provider-input";
import { buildProviderAlertState } from "@/lib/provider-alerts";
import { computeBudgetStatus } from "@/lib/budget-status";
import { toPrismaProviderPlanData } from "@/lib/provider-plan";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  hasProviderSecrets,
  providerConfigForClient,
  splitProviderConfig,
} from "@/lib/provider-secret-config";

function buildKeyPreview(encryptedKey: string | null): string | null {
  if (!encryptedKey) return null;
  try {
    const decrypted = decrypt(encryptedKey);
    if (decrypted.length <= 10) return null;
    const first = decrypted.slice(0, 6);
    const last = decrypted.slice(-4);
    return `${first}...${last}`;
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
          fetchedAt: true,
        },
      },
    },
  }), computeBudgetStatus()]);
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
    const latestSnapshot = snapshots[0] ?? null;
    const alertState = buildProviderAlertState({
      isActive: p.isActive,
      refreshIntervalMin: p.refreshIntervalMin,
      plan: p.plan,
      latestSnapshot,
    });
    const canonicalBudget = budgetByProviderId.get(p.id);
    const duplicateProviderIds = duplicateIdsByCanonicalName.get(
      canonicalProviderKey(p.name)
    ) ?? [];

    return {
      ...rest,
      ...clientConfig,
      keyPreview: buildKeyPreview(apiKey),
      latestSnapshot,
      alerts: canonicalBudget?.alerts ?? alertState.alerts,
      estimatedMonthlyCostUsd: alertState.estimatedMonthlyCostUsd,
      spentUsd: canonicalBudget?.spentUsd ?? latestSnapshot?.totalCost ?? 0,
      snapshotCostUsd: canonicalBudget?.snapshotCostUsd ?? latestSnapshot?.totalCost ?? null,
      snapshotCostFetchedAt: canonicalBudget?.snapshotCostFetchedAt ?? null,
      snapshotFixedCostIncludedUsd:
        canonicalBudget?.snapshotFixedCostIncludedUsd ?? 0,
      snapshotCostIncludesUnknownFixed:
        canonicalBudget?.snapshotCostIncludesUnknownFixed ?? false,
      pushedMonthToDateUsd: canonicalBudget?.pushedMonthToDateUsd ?? 0,
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
