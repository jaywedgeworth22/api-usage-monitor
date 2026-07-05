import { prisma } from "@/lib/prisma";
import { sumMonthToDateExternalCostByProvider } from "@/lib/external-usage-events";
import { buildProviderAlertState, type ProviderAlert } from "@/lib/provider-alerts";
import { getExternalEventRawCutoff } from "@/lib/data-retention";

// Budget-status computation for the read endpoint (GET /api/budget-status).
//
// Consuming apps (e.g. Agentic Trading's cost-aware feedback loop) poll this to decide whether to
// throttle spend. Spend is combined across BOTH channels the monitor tracks:
//   - poll snapshots  (UsageSnapshot.totalCost — cumulative cost the poll adapter reported)
//   - pushed telemetry (ExternalUsageEvent.costUsd — month-to-date, the ONLY signal for providers
//     the poll adapters are blind to: Anthropic, Voyage, Robinhood)
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
  pushedMonthToDateUsd: number;
  spentUsd: number;
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
    totalSpentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function monthLabel(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function computeBudgetStatus(now: Date = new Date()): Promise<BudgetStatusResponse> {
  const monthStart = monthStartUtc(now);
  const rawCutoff = getExternalEventRawCutoff(now);

  const [providers, pushedByProvider] = await Promise.all([
    prisma.provider.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
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
            mustKeepFunded: true,
          },
        },
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { balance: true, totalCost: true, totalRequests: true, credits: true, fetchedAt: true },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(monthStart, rawCutoff),
  ]);

  // Case-insensitive provider name → month-to-date pushed cost.
  const pushedMap = pushedByProvider;

  const providerStatuses: ProviderBudgetStatus[] = providers.map((p) => {
    const plan = p.plan;
    const latestSnapshot = p.snapshots[0] ?? null;
    const fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd ?? 0;
    const snapshotCostUsd = latestSnapshot?.totalCost ?? null;
    const pushedMonthToDateUsd = pushedMap.get(p.name.toLowerCase()) ?? 0;
    const usageCost = Math.max(snapshotCostUsd ?? 0, pushedMonthToDateUsd);
    const spentUsd = fixedMonthlyCostUsd + usageCost;
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
      },
      now
    );
    const budgetAlerts = alertState.alerts.filter(
      (a) => a.code === "budget_exceeded" || a.code === "budget_warning"
    );

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
      pushedMonthToDateUsd,
      spentUsd,
      remainingUsd,
      percentUsed,
      status,
      alerts: budgetAlerts,
    };
  });

  const budgeted = providerStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const totalSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatuses,
    summary: {
      totalBudgetUsd,
      totalSpentUsd,
      remainingUsd: totalBudgetUsd - totalSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? totalSpentUsd / totalBudgetUsd : null,
      overBudget: providerStatuses.some((p) => p.status === "exceeded"),
      warning: providerStatuses.some((p) => p.status === "warning"),
    },
  };
}
