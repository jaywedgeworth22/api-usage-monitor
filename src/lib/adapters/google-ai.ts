import type { UsageResult } from "./openai";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/openai/usage?key=${apiKey}`,
    {
      headers: { "Content-Type": "application/json" },
    }
  );

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

  if (typeof data.totalCost === "number") {
    totalCost = data.totalCost;
  }
  if (typeof data.totalRequests === "number") {
    totalRequests = data.totalRequests;
  }

  return {
    balance: null,
    totalCost,
    totalRequests,
    credits: null,
    rawData: data,
  };
}
