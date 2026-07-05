import { resilientFetch, type UsageResult } from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const url = (config?.endpoint as string) || "https://agent-sync.jays.services/health";
  const rawData: Record<string, unknown> = {};

  try {
    const res = await resilientFetch(url, {
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      throw new Error(`Uptime check failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    rawData.status = "UP";
    rawData.data = data;

    return {
      balance: null,
      totalCost: 0,
      totalRequests: 1, // represents healthy heartbeat/uptime tick
      credits: null,
      rawData,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Uptime check failed";
    rawData.status = "DOWN";
    rawData.error = errorMsg;
    throw new Error(errorMsg);
  }
}
