import {
  AlertNotificationSummaryPersistenceTimeout,
  deliverProviderAlerts,
  type AlertDeliveryResult,
  type AlertNotificationSummaryOperation,
} from "@/lib/alert-delivery";
import {
  runScheduledDataRetentionMaintenance,
  type DataRetentionResult,
  type ScheduledRetentionSkipped,
} from "@/lib/data-retention";
import {
  materializeDueSubscriptions,
  type MaterializeSubscriptionsResult,
} from "@/lib/subscription-materializer";
import {
  rollForwardProviderRenewals,
  type RollForwardProviderRenewalsResult,
} from "@/lib/provider-renewals";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";
import {
  adoptExternalBillingSubscriptions,
  type AdoptExternalBillingSubscriptionsResult,
  type CloudflareLegacyHandoffStatus,
} from "@/lib/external-billing-subscription-adoption";
import { quarantineLegacyMistralSpendLimitSnapshots } from "@/lib/mistral-snapshot-quarantine";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { fetchJson } from "@/lib/adapters/helpers";
import { sumMonthToDateExternalCostByProvider } from "@/lib/external-usage-events";

export interface UsageMaintenanceResult {
  subscriptionAdoption: SubscriptionAdoptionMaintenanceResult;
  subscriptions: MaterializeSubscriptionsResult;
  providerRenewals: RollForwardProviderRenewalsResult;
  retention: DataRetentionResult | ScheduledRetentionSkipped;
  alerts: AlertMaintenanceResult;
  openrouterVerification?: { verifiedCount: number };
  reconciliation?: { reconciledCount: number };
}

export interface SubscriptionAdoptionMaintenanceError {
  stage: "subscription_adoption";
  message: string;
}

export interface SubscriptionAdoptionMaintenanceResult
  extends AdoptExternalBillingSubscriptionsResult {
  degradedError: SubscriptionAdoptionMaintenanceError | null;
}

export interface DeferredAlertMaintenanceError {
  stage: "alerts";
  operation: AlertNotificationSummaryOperation;
  code: "P1008";
  model: "ProviderAlertNotification";
  message: string;
}

export interface AlertMaintenanceResult extends AlertDeliveryResult {
  deferredError: DeferredAlertMaintenanceError | null;
}

export interface UsageMaintenanceDependencies {
  quarantineMistralSnapshots?: typeof quarantineLegacyMistralSpendLimitSnapshots;
  adoptSubscriptions?: typeof adoptExternalBillingSubscriptions;
  materializeSubscriptions?: typeof materializeDueSubscriptions;
  rollForwardRenewals?: typeof rollForwardProviderRenewals;
  runRetention?: typeof runScheduledDataRetentionMaintenance;
  deliverAlerts?: typeof deliverProviderAlerts;
  verifyOpenRouterGenerations?: typeof verifyOpenRouterGenerations;
  reconcileProviderUsage?: typeof reconcileProviderUsage;
}

const HEALTHY_CLOUDFLARE_LEGACY_HANDOFF_STATUSES = new Set<
  CloudflareLegacyHandoffStatus
>(["disabled", "handed_off", "already_managed"]);

export function isUsageMaintenanceHealthy(result: UsageMaintenanceResult): boolean {
  return (
    result.subscriptionAdoption.degradedError === null &&
    HEALTHY_CLOUDFLARE_LEGACY_HANDOFF_STATUSES.has(
      result.subscriptionAdoption.cloudflareLegacyHandoff
    ) &&
    result.alerts.deferredError === null &&
    result.alerts.persistenceDegraded.length === 0
  );
}

export async function verifyOpenRouterGenerations(): Promise<number> {
  const events = await prisma.externalUsageEvent.findMany({
    where: {
      provider: "openrouter",
      metricType: "usage",
      keyRef: {
        not: null,
        startsWith: "gen-",
      },
      verificationStatus: null,
    },
    take: 50,
  });

  if (events.length === 0) return 0;

  let apiKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!apiKey) {
    const provider = await prisma.provider.findFirst({
      where: {
        name: "openrouter",
        isActive: true,
        apiKey: { not: null },
      },
    });
    if (provider?.apiKey) {
      apiKey = decrypt(provider.apiKey);
    }
  }

  if (!apiKey) {
    console.warn("[openrouter-verification] No OpenRouter API key found for verification.");
    return 0;
  }

  let verifiedCount = 0;
  for (const event of events) {
    if (!event.keyRef) continue;
    try {
      const res = await fetchJson(
        `https://openrouter.ai/api/v1/generation?id=${event.keyRef}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      if (res.ok) {
        const payload = res.data && typeof res.data === "object" && !Array.isArray(res.data)
          ? (res.data as Record<string, any>).data
          : null;

        if (payload && payload.id === event.keyRef) {
          await prisma.externalUsageEvent.update({
            where: { id: event.id },
            data: { verificationStatus: "verified" },
          });
          verifiedCount++;
        } else {
          await prisma.externalUsageEvent.update({
            where: { id: event.id },
            data: { verificationStatus: "failed" },
          });
        }
      } else if (res.status === 404) {
        await prisma.externalUsageEvent.update({
          where: { id: event.id },
          data: { verificationStatus: "failed" },
        });
      } else {
        // Transient error, leave status as null/pending for retry
      }
    } catch (error) {
      console.error(`[openrouter-verification] Error verifying event ${event.id}:`, error);
    }
  }
  return verifiedCount;
}

export async function reconcileProviderUsage(): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rawCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // 90 days retention

  const [providers, pushedCosts] = await Promise.all([
    prisma.provider.findMany({
      where: { isActive: true },
      include: {
        snapshots: {
          where: {
            fetchedAt: { gte: monthStart },
            totalCost: { not: null },
          },
          orderBy: { fetchedAt: "desc" },
          take: 1,
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(monthStart, rawCutoff),
  ]);

  let count = 0;
  for (const provider of providers) {
    const latestSnapshot = provider.snapshots[0];
    if (!latestSnapshot || latestSnapshot.totalCost === null) {
      continue; // Not adapter-verifiable (no poll snapshot cost)
    }

    const providerCost = latestSnapshot.totalCost;
    
    // Look up pushed cost from the Map
    const normalizedKey = provider.name.toLowerCase();
    let localCost = 0;
    let localEventCount = 0;
    for (const [key, value] of pushedCosts.entries()) {
      if (key.toLowerCase() === normalizedKey) {
        localCost = value.usagePushed;
        localEventCount = value.pricedEventCount + value.unpricedEventCount + value.unclassifiedCostEventCount;
        break;
      }
    }

    const deltaUsd = providerCost - localCost;
    const deltaRatio = localCost > 0 ? deltaUsd / localCost : null;
    const status = Math.abs(deltaUsd) > 0.01 ? "discrepancy" : "ok";

    // Clean up older reconciliations for the same provider and month to keep it clean
    await prisma.providerUsageReconciliation.deleteMany({
      where: {
        providerId: provider.id,
        periodStart: monthStart,
      },
    });

    await prisma.providerUsageReconciliation.create({
      data: {
        providerId: provider.id,
        periodStart: monthStart,
        periodEnd: now,
        reportedCostUsd: localCost,
        reportedEventCount: localEventCount,
        verifiedCostUsd: providerCost,
        verifiedSource: "usage-snapshot",
        deltaUsd,
        deltaRatio,
        status,
        checkedAt: now,
        keyRef: "",
      },
    });

    count++;
  }

  return count;
}

let maintenanceInFlight: Promise<UsageMaintenanceResult> | null = null;

function deferredAlertMaintenanceError(
  error: AlertNotificationSummaryPersistenceTimeout
): DeferredAlertMaintenanceError {
  return {
    stage: "alerts",
    operation: error.operation,
    code: error.code,
    model: error.model,
    message: error.originalError.message,
  };
}

export async function runUsageMaintenance(
  dependencies: UsageMaintenanceDependencies = {}
): Promise<UsageMaintenanceResult> {
  if (maintenanceInFlight) return maintenanceInFlight;

  const run = (async () => {
    // External billing was reconciled during provider polling. Adopt only its
    // exact authoritative recurring charges before materialization so a newly
    // discovered current period is charged exactly once in this same pass.
    const { subscriptionAdoption, subscriptions } =
      await withInternalUsageWriteAdmission(async () => {
        // This correction is independent of the current provider poll: even a
        // Mistral 401 must not keep the retired spend-limit-as-cash snapshots
        // eligible for budget math. The helper is bounded and idempotent.
        const mistralQuarantine = await (
          dependencies.quarantineMistralSnapshots ??
          quarantineLegacyMistralSpendLimitSnapshots
        )();
        if (
          mistralQuarantine.quarantined > 0 ||
          mistralQuarantine.externalBillingQuarantined > 0 ||
          mistralQuarantine.truncated
        ) {
          console.warn(
            `[mistral-snapshot-quarantine] snapshotsExamined=${mistralQuarantine.examined} snapshotsQuarantined=${mistralQuarantine.quarantined} externalBillingExamined=${mistralQuarantine.externalBillingExamined} externalBillingQuarantined=${mistralQuarantine.externalBillingQuarantined} truncated=${mistralQuarantine.truncated}`
          );
        }
        let subscriptionAdoption: SubscriptionAdoptionMaintenanceResult;
        try {
          subscriptionAdoption = {
            ...(await (
              dependencies.adoptSubscriptions ??
              adoptExternalBillingSubscriptions
            )()),
            degradedError: null,
          };
        } catch (error) {
          // Adoption is an optional source of NEW local charges. Fail it
          // closed, but continue materializing already-existing schedules and
          // all later maintenance stages.
          console.error(
            "[usage-maintenance] external billing subscription adoption failed; continuing existing maintenance",
            error
          );
          subscriptionAdoption = {
            examined: 0,
            eligible: 0,
            adopted: 0,
            existing: 0,
            ambiguous: 0,
            reconciled: 0,
            deactivated: 0,
            raced: 0,
            cloudflareLegacyHandoff: "not_run",
            degradedError: {
              stage: "subscription_adoption",
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown subscription adoption failure",
            },
          };
        }
        const subscriptions = await (
          dependencies.materializeSubscriptions ?? materializeDueSubscriptions
        )();
        return { subscriptionAdoption, subscriptions };
      });

    // Advance provider renewals BEFORE retention so newly-generated
    // subscription events roll up in the same pass, and BEFORE alerts so
    // budget/renewal alerts see current state.
    const providerRenewals = await withInternalUsageWriteAdmission(() =>
      (dependencies.rollForwardRenewals ?? rollForwardProviderRenewals)()
    );
    const retention = await (
      dependencies.runRetention ?? runScheduledDataRetentionMaintenance
    )();

    let alerts: AlertMaintenanceResult;
    try {
      alerts = {
        ...(await (dependencies.deliverAlerts ?? deliverProviderAlerts)()),
        deferredError: null,
      };
    } catch (error) {
      if (!(error instanceof AlertNotificationSummaryPersistenceTimeout)) throw error;

      // Provider polling and money-path maintenance have already committed.
      // The notification summary write is safe to defer: any channel send is
      // persisted first in ProviderAlertChannelDelivery. Do not broaden this
      // catch to channel-state writes, where retrying can duplicate a send.
      console.error(
        "[usage-maintenance] alert notification bookkeeping timed out; deferring until the next cycle",
        error
      );
      alerts = {
        ...error.partialResult,
        deferredError: deferredAlertMaintenanceError(error),
      };
    }
    const verifyOpenRouter = dependencies.verifyOpenRouterGenerations ?? verifyOpenRouterGenerations;
    const reconcileUsage = dependencies.reconcileProviderUsage ?? reconcileProviderUsage;

    let openrouterVerification = { verifiedCount: 0 };
    try {
      openrouterVerification = await withInternalUsageWriteAdmission(async () => {
        const verifiedCount = await verifyOpenRouter();
        return { verifiedCount };
      });
    } catch (error) {
      console.error("[usage-maintenance] OpenRouter verification job failed:", error);
    }

    let reconciliation = { reconciledCount: 0 };
    try {
      reconciliation = await withInternalUsageWriteAdmission(async () => {
        const reconciledCount = await reconcileUsage();
        return { reconciledCount };
      });
    } catch (error) {
      console.error("[usage-maintenance] Provider usage reconciliation failed:", error);
    }

    return {
      subscriptionAdoption,
      subscriptions,
      providerRenewals,
      retention,
      alerts,
      openrouterVerification,
      reconciliation,
    };
  })();

  maintenanceInFlight = run;
  try {
    return await run;
  } finally {
    if (maintenanceInFlight === run) maintenanceInFlight = null;
  }
}
