import type { UsageResult } from "./openai";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  return { balance: null, totalCost: null, totalRequests: null, credits: null, rawData: null };
}
