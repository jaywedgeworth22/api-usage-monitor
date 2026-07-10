import { deliverProviderAlerts, type AlertDeliveryResult } from "@/lib/alert-delivery";
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

export interface UsageMaintenanceResult {
  subscriptions: MaterializeSubscriptionsResult;
  providerRenewals: RollForwardProviderRenewalsResult;
  retention: DataRetentionResult | ScheduledRetentionSkipped;
  alerts: AlertDeliveryResult;
}

let maintenanceInFlight: Promise<UsageMaintenanceResult> | null = null;

export async function runUsageMaintenance(): Promise<UsageMaintenanceResult> {
  if (maintenanceInFlight) return maintenanceInFlight;

  const run = (async () => {
    // Materialize subscription charges and advance provider renewals BEFORE
    // retention so newly-generated subscription events roll up in the same
    // pass, and BEFORE alerts so budget/renewal alerts see current state.
    const subscriptions = await materializeDueSubscriptions();
    const providerRenewals = await rollForwardProviderRenewals();
    const retention = await runScheduledDataRetentionMaintenance();
    const alerts = await deliverProviderAlerts();
    return { subscriptions, providerRenewals, retention, alerts };
  })();

  maintenanceInFlight = run;
  try {
    return await run;
  } finally {
    if (maintenanceInFlight === run) maintenanceInFlight = null;
  }
}
