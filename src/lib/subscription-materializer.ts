import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { persistExternalUsageEvents, type ExternalUsageEventInput } from "@/lib/external-usage-events";
import { advancePeriod, isSubscriptionInterval, type SubscriptionInterval } from "@/lib/subscriptions";

// Turns each active subscription's elapsed billing periods into synthetic
// ExternalUsageEvent rows (metricType="subscription"), so recurring fees flow
// through the SAME month-to-date sums, daily rollups, per-project attribution,
// and budgets as metered usage — no special-casing in budget-status.
//
// Idempotent two ways: every charge's idempotencyKey is a hash of
// (subscriptionId, periodStart), and the subscription tracks a
// lastChargedPeriodStart watermark. Re-running never double-charges a period
// (the upsert is a no-op on a seen key), so it's safe to call on every
// maintenance cycle.
//
// The event's `provider` string is the provider's (already lowercased) name so
// the charge aggregates under that provider exactly like pushed usage; its
// `projectId` is the subscription's, so per-project budgets pick it up.

// Guard against a subscription whose startDate is far in the past generating an
// unbounded backfill in one pass.
const MAX_PERIODS_PER_RUN = 240;

export const SUBSCRIPTION_SOURCE_APP = "subscription";

export interface MaterializeSubscriptionsResult {
  examined: number;
  charged: number;
  eventsWritten: number;
}

function chargeIdempotencyKey(subscriptionId: string, periodStart: Date): string {
  return crypto
    .createHash("sha256")
    .update(`subscription:${subscriptionId}:${periodStart.toISOString()}`)
    .digest("hex");
}

interface DueSubscription {
  id: string;
  name: string;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  projectId: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date | null;
  provider: { name: string };
}

interface ChargePlan {
  inputs: ExternalUsageEventInput[];
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date;
}

// Pure planning step (exported for tests): given a subscription and `now`,
// returns the charges to emit and the advanced cycle fields. Charges every
// period whose start is at or before `now` and past the watermark.
export function planSubscriptionCharges(
  subscription: DueSubscription,
  now: Date
): ChargePlan | null {
  const interval: SubscriptionInterval = isSubscriptionInterval(subscription.interval)
    ? subscription.interval
    : "monthly";
  const intervalCount = Math.max(1, Math.trunc(subscription.intervalCount));

  const inputs: ExternalUsageEventInput[] = [];
  let periodStart = subscription.currentPeriodStart;
  let lastCharged = subscription.lastChargedPeriodStart;
  let latestStarted = subscription.currentPeriodStart;
  const cadencePeriodEnd = advancePeriod(periodStart, interval, intervalCount);
  let nextRenewalAt =
    subscription.nextRenewalAt.getTime() > periodStart.getTime()
      ? new Date(
          Math.min(
            subscription.nextRenewalAt.getTime(),
            cadencePeriodEnd.getTime()
          )
        )
      : cadencePeriodEnd;
  let latestPeriodEnd = nextRenewalAt;
  let guard = 0;

  while (periodStart.getTime() <= now.getTime() && guard < MAX_PERIODS_PER_RUN) {
    guard += 1;
    const periodEnd = nextRenewalAt;

    if (!lastCharged || periodStart.getTime() > lastCharged.getTime()) {
      inputs.push({
        idempotencyKey: chargeIdempotencyKey(subscription.id, periodStart),
        sourceApp: SUBSCRIPTION_SOURCE_APP,
        provider: subscription.provider.name,
        projectId: subscription.projectId,
        service: subscription.name,
        label: subscription.name,
        billingMode: "manual",
        metricType: "subscription",
        unit: "usd",
        costUsd: subscription.costUsd,
        confidence: "actual",
        occurredAt: periodStart,
        windowStart: periodStart,
        windowEnd: periodEnd,
        metadata: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          interval,
          intervalCount,
          currency: subscription.currency,
        },
      });
      lastCharged = periodStart;
    }

    latestStarted = periodStart;
    latestPeriodEnd = periodEnd;
    // A non-auto-renewing subscription is charged for exactly the one term it
    // is in and then stops — never advance into (or charge) a following period.
    if (!subscription.autoRenew) break;
    if (periodEnd.getTime() > now.getTime()) break;
    periodStart = periodEnd;
    nextRenewalAt = advancePeriod(periodStart, interval, intervalCount);
  }

  if (inputs.length === 0) return null;

  return {
    inputs,
    currentPeriodStart: latestStarted,
    nextRenewalAt: latestPeriodEnd,
    lastChargedPeriodStart: lastCharged as Date,
  };
}

export async function materializeDueSubscriptions(
  now: Date = new Date()
): Promise<MaterializeSubscriptionsResult> {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: "active", currentPeriodStart: { lte: now } },
    select: {
      id: true,
      name: true,
      costUsd: true,
      currency: true,
      interval: true,
      intervalCount: true,
      projectId: true,
      autoRenew: true,
      currentPeriodStart: true,
      nextRenewalAt: true,
      lastChargedPeriodStart: true,
      provider: { select: { name: true } },
    },
  });

  let charged = 0;
  let eventsWritten = 0;

  for (const subscription of subscriptions) {
    const plan = planSubscriptionCharges(subscription, now);
    if (!plan) continue;

    const persistResult = await persistExternalUsageEvents(plan.inputs);
    eventsWritten += persistResult.persisted;
    charged += 1;

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodStart: plan.currentPeriodStart,
        nextRenewalAt: plan.nextRenewalAt,
        lastChargedPeriodStart: plan.lastChargedPeriodStart,
      },
    });
  }

  return { examined: subscriptions.length, charged, eventsWritten };
}
