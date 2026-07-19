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
import {
  verifyOpenRouterGenerations,
  type OpenRouterVerificationResult,
} from "@/lib/openrouter-generation-verification";
import {
  reconcileProviderUsage,
  type ProviderUsageReconciliationResult,
} from "@/lib/provider-usage-reconciliation";

export interface UsageMaintenanceResult {
  subscriptionAdoption: SubscriptionAdoptionMaintenanceResult;
  subscriptions: MaterializeSubscriptionsResult;
  providerRenewals: RollForwardProviderRenewalsResult;
  retention: DataRetentionResult | ScheduledRetentionSkipped;
  alerts: AlertMaintenanceResult;
  openrouterVerification?: OpenRouterVerificationResult;
  reconciliation?: ProviderUsageReconciliationResult;
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
    result.alerts.persistenceDegraded.length === 0 &&
    // A key that cannot read generations (401/403) silently disables the
    // per-call audit layer. Reporting healthy in that state would recreate
    // exactly the blind spot §3c exists to remove.
    result.openrouterVerification?.degraded !== true
  );
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

    // Both jobs acquire write admission internally around their DB writes ONLY
    // — verification's HTTP calls must not hold the single SQLite writer (the
    // same discipline alert-delivery follows). Neither is allowed to fail the
    // maintenance tick: this is an audit layer beside the money path.
    let openrouterVerification: OpenRouterVerificationResult = {
      examined: 0,
      matched: 0,
      discrepancies: 0,
      errors: 0,
      exhausted: 0,
      verifiedCount: 0,
      truncated: false,
      degraded: false,
    };
    try {
      openrouterVerification = await verifyOpenRouter();
    } catch (error) {
      console.error("[usage-maintenance] OpenRouter verification job failed:", error);
      openrouterVerification = { ...openrouterVerification, degraded: true };
    }

    let reconciliation: ProviderUsageReconciliationResult = {
      examined: 0,
      reconciled: 0,
      discrepancies: 0,
      unverifiable: 0,
      pending: 0,
      reconciledCount: 0,
    };
    try {
      reconciliation = await reconcileUsage();
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
