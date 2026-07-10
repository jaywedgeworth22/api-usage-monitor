import type { Prisma } from "@prisma/client";
import type { ProviderPlanInput } from "@/lib/provider-input";

export function toPrismaProviderPlanData(
  plan: ProviderPlanInput
): Prisma.ProviderPlanCreateWithoutProviderInput {
  return {
    billingMode: plan.billingMode ?? "manual",
    fixedMonthlyCostUsd: plan.fixedMonthlyCostUsd,
    monthlyBudgetUsd: plan.monthlyBudgetUsd,
    monthlyRequestLimit: plan.monthlyRequestLimit,
    lowBalanceUsd: plan.lowBalanceUsd,
    lowCredits: plan.lowCredits,
    renewalDate: plan.renewalDate,
    billingInterval: plan.billingInterval ?? undefined,
    mustKeepFunded: plan.mustKeepFunded ?? false,
    notes: plan.notes,
  };
}
