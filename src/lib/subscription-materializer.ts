import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  persistExternalUsageEventsInTransaction,
  type ExternalUsageEventInput,
} from "@/lib/external-usage-events";
import {
  SUBSCRIPTION_SOURCE_APP,
  subscriptionChargeIdempotencyKey,
} from "@/lib/subscription-charge-identity";
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

export interface MaterializeSubscriptionsResult {
  examined: number;
  charged: number;
  eventsWritten: number;
}

interface SubscriptionChargePlanInput {
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
  provider: { name: string; refreshIntervalMin?: number };
}

interface DueSubscription extends SubscriptionChargePlanInput {
  providerId: string;
  externalAdoptionGuardKey: string | null;
  externalBillingSource: string | null;
  externalBillingId: string | null;
  externalBillingManaged: boolean;
}

interface ChargeCorrectionProof {
  managedSubscriptionId: string;
  source: string;
  externalId: string;
  correctedPeriodStart: Date;
  correctedPeriodEnd: Date;
  correctedGuardKey: string;
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
  subscription: SubscriptionChargePlanInput,
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
        idempotencyKey: subscriptionChargeIdempotencyKey(
          subscription.id,
          periodStart
        ),
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

function conflictingManagedPeriodStarts(
  subscription: DueSubscription,
  plan: ChargePlan,
  correctionProofs: ChargeCorrectionProof[]
): Set<number> {
  const periodStarts = new Set<number>();
  const guardKey = subscription.externalAdoptionGuardKey;
  const externalBillingSource = subscription.externalBillingSource;
  const externalBillingId = subscription.externalBillingId;
  if (
    !guardKey ||
    subscription.externalBillingManaged !== false ||
    !externalBillingSource ||
    !externalBillingId
  ) {
    return periodStarts;
  }

  for (const proof of correctionProofs) {
    if (
      proof.managedSubscriptionId === subscription.id ||
      proof.correctedGuardKey !== guardKey ||
      proof.source !== externalBillingSource ||
      proof.externalId !== externalBillingId
    ) {
      continue;
    }
    if (
      plan.inputs.some(
        (input) =>
          input.windowStart?.getTime() ===
            proof.correctedPeriodStart.getTime() &&
          input.windowEnd?.getTime() === proof.correctedPeriodEnd.getTime()
      )
    ) {
      periodStarts.add(proof.correctedPeriodStart.getTime());
    }
  }
  return periodStarts;
}

async function resolveGuardedChargePlan(
  subscriptionId: string,
  now: Date
): Promise<
  | { subscription: DueSubscription; plan: ChargePlan }
  | { settled: true; charged: number; eventsWritten: number }
  | null
> {
  return prisma.$transaction(
    async (tx) => {
      // SQLite interactive transactions begin deferred. Take the writer lock
      // before re-reading the guarded row and its collision provenance so a
      // concurrent owner edit cannot be mistaken for the state we settle.
      await tx.$executeRaw`
        UPDATE "Subscription"
        SET "costUsd" = "costUsd"
        WHERE "id" = ${subscriptionId}
      `;
      const subscription = await tx.subscription.findFirst({
        where: {
          id: subscriptionId,
          status: "active",
          currentPeriodStart: { lte: now },
        },
        select: {
          id: true,
          providerId: true,
          externalAdoptionGuardKey: true,
          externalBillingSource: true,
          externalBillingId: true,
          externalBillingManaged: true,
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
          provider: {
            select: { name: true, refreshIntervalMin: true },
          },
        },
      });
      if (!subscription) return null;

      const plan = planSubscriptionCharges(subscription, now);
      if (!plan) return null;
      if (!subscription.externalAdoptionGuardKey) {
        return { subscription, plan };
      }

      // A provider/price/cadence guard is not a billing identity. Only an
      // owner-declared exact source + external ID can spend correction proof;
      // absent identity fails open so unrelated paid services stay additive.
      if (
        subscription.externalBillingManaged !== false ||
        !subscription.externalBillingSource ||
        !subscription.externalBillingId
      ) {
        return { subscription, plan };
      }

      const correctionProofs = await tx.externalBillingChargeCorrection.findMany({
        where: {
          providerId: subscription.providerId,
          correctedGuardKey: subscription.externalAdoptionGuardKey,
          source: subscription.externalBillingSource,
          externalId: subscription.externalBillingId,
        },
        select: {
          managedSubscriptionId: true,
          source: true,
          externalId: true,
          correctedPeriodStart: true,
          correctedPeriodEnd: true,
          correctedGuardKey: true,
        },
      });
      const settledPeriodStarts = conflictingManagedPeriodStarts(
        subscription,
        plan,
        correctionProofs
      );
      if (settledPeriodStarts.size === 0) return { subscription, plan };

      // Suppress only the proven overlapping input. Any earlier/non-overlap
      // inputs must materialize before the monotonic watermark advances past
      // them, or a June+July plan could permanently omit June when only July
      // overlaps. Persistence and watermark/cycle advancement share this
      // writer-locked transaction, so failure rolls both back and replay stays
      // idempotent.
      const nonOverlappingInputs = plan.inputs.filter(
        (input) =>
          !settledPeriodStarts.has(input.windowStart?.getTime() ?? Number.NaN)
      );
      const persisted = await persistExternalUsageEventsInTransaction(
        tx,
        nonOverlappingInputs
      );
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          currentPeriodStart: plan.currentPeriodStart,
          nextRenewalAt: plan.nextRenewalAt,
          lastChargedPeriodStart: plan.lastChargedPeriodStart,
        },
      });
      return {
        settled: true,
        charged: nonOverlappingInputs.length > 0 ? 1 : 0,
        eventsWritten: persisted.persisted,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 20_000,
    }
  );
}

export async function materializeDueSubscriptions(
  now: Date = new Date()
): Promise<MaterializeSubscriptionsResult> {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: "active", currentPeriodStart: { lte: now } },
    select: {
      id: true,
      providerId: true,
      externalAdoptionGuardKey: true,
      externalBillingSource: true,
      externalBillingId: true,
      externalBillingManaged: true,
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

  for (const observedSubscription of subscriptions) {
    let subscription: DueSubscription = observedSubscription;
    let plan = planSubscriptionCharges(subscription, now);
    if (!plan) continue;

    // An explicitly linked owner-controlled row can take over an identity after
    // a provider corrects a charged term (for example $5 -> $6). Preserve its
    // terms/status/guard, but avoid a duplicate only when immutable proof
    // matches that exact source + external ID and window. The writer-locked
    // recheck records only a settlement watermark; unlinked/unrelated rows and
    // an owner reanchor remain independently billable.
    if (subscription.externalAdoptionGuardKey) {
      const guarded = await resolveGuardedChargePlan(subscription.id, now);
      if (!guarded) continue;
      if ("settled" in guarded) {
        charged += guarded.charged;
        eventsWritten += guarded.eventsWritten;
        continue;
      }
      subscription = guarded.subscription;
      plan = guarded.plan;
    }

    // Wave G / E13: persist charges + advance watermark in one writer-locked
    // transaction (same guarantee as the guarded settlement path above). A
    // crash between event insert and watermark update can no longer leave a
    // charged period re-eligible while events already exist (idempotent, but
    // brittle for ops).
    const persistResult = await prisma.$transaction(
      async (tx) => {
        const persisted = await persistExternalUsageEventsInTransaction(
          tx,
          plan.inputs
        );
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            currentPeriodStart: plan.currentPeriodStart,
            nextRenewalAt: plan.nextRenewalAt,
            lastChargedPeriodStart: plan.lastChargedPeriodStart,
          },
        });
        return persisted;
      },
      { timeout: 30_000 }
    );
    eventsWritten += persistResult.persisted;
    charged += 1;
  }

  return { examined: subscriptions.length, charged, eventsWritten };
}
