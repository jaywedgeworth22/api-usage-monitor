import { deliverProviderAlerts, type AlertDeliveryResult } from "@/lib/alert-delivery";
import {
  runScheduledDataRetentionMaintenance,
  type DataRetentionResult,
  type ScheduledRetentionSkipped,
} from "@/lib/data-retention";

export interface UsageMaintenanceResult {
  retention: DataRetentionResult | ScheduledRetentionSkipped;
  alerts: AlertDeliveryResult;
}

let maintenanceInFlight: Promise<UsageMaintenanceResult> | null = null;

export async function runUsageMaintenance(): Promise<UsageMaintenanceResult> {
  if (maintenanceInFlight) return maintenanceInFlight;

  const run = (async () => {
    const retention = await runScheduledDataRetentionMaintenance();
    const alerts = await deliverProviderAlerts();
    return { retention, alerts };
  })();

  maintenanceInFlight = run;
  try {
    return await run;
  } finally {
    if (maintenanceInFlight === run) maintenanceInFlight = null;
  }
}
