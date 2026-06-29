import type { UsageResult } from "./openai";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetch("https://api.anthropic.com/v1/billing/usage", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    return {
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      rawData: { error: `HTTP ${res.status}`, status: res.status },
    };
  }

  const data = await res.json();

  let totalCost: number | null = null;
  let totalRequests: number | null = null;

  // Anthropic billing API returns usage/cost info
  if (typeof data.total_cost === "number") {
    totalCost = data.total_cost;
  }
  if (typeof data.total_requests === "number") {
    totalRequests = data.total_requests;
  }

  return {
    balance: null,
    totalCost,
    totalRequests,
    credits: null,
    rawData: data,
  };
}
