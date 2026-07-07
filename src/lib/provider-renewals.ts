import { prisma } from "@/lib/prisma";
import { isSubscriptionInterval, rollForwardRenewal } from "@/lib/subscriptions";

// Advances any ProviderPlan.renewalDate that has passed to its next upcoming
// occurrence, following the plan's billingInterval. Without this the stored
// date would stay in the past forever (the historical bug that made
// renewal_overdue permanent). Alerts already compute the effective next date
// in-memory (provider-alerts.ts), so this exists to keep the PERSISTED value —
// the one shown in the Settings "Renewal" column — meaningful over time.
//
// Plans with no billingInterval are left untouched: there is no cadence to roll
// to, so a past date is genuinely overdue and stays flagged.
export interface RollForwardProviderRenewalsResult {
  examined: number;
  advanced: number;
}

export async function rollForwardProviderRenewals(
  now: Date = new Date()
): Promise<RollForwardProviderRenewalsResult> {
  const plans = await prisma.providerPlan.findMany({
    where: { renewalDate: { lt: now, not: null } },
    select: { id: true, renewalDate: true, billingInterval: true },
  });

  let advanced = 0;
  for (const plan of plans) {
    if (!plan.renewalDate || !plan.billingInterval || !isSubscriptionInterval(plan.billingInterval)) {
      continue;
    }
    const next = rollForwardRenewal(plan.renewalDate, plan.billingInterval, 1, now);
    if (next.getTime() !== plan.renewalDate.getTime()) {
      await prisma.providerPlan.update({
        where: { id: plan.id },
        data: { renewalDate: next },
      });
      advanced += 1;
    }
  }

  return { examined: plans.length, advanced };
}
