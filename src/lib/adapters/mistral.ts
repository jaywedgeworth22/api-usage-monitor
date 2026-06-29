import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const now = new Date();
  const params = new URLSearchParams({
    month: String(now.getUTCMonth() + 1),
    year: String(now.getUTCFullYear()),
  });

  const [usageRes, limitsRes, modelsRes] = await Promise.all([
    fetchJson(`https://api.mistral.ai/api/admin/usage?${params}`, { headers }),
    fetchJson("https://api.mistral.ai/api/admin/spend-limit", { headers }),
    fetchJson("https://api.mistral.ai/v1/models", { headers }),
  ]);

  const rawData: Record<string, unknown> = {
    usage: usageRes.data,
    spendLimit: limitsRes.data,
    models: modelsRes.data,
  };

  if (!usageRes.ok && !limitsRes.ok && !modelsRes.ok) {
    return errorResult(usageRes.status || modelsRes.status, rawData);
  }

  let balance: number | null = null;
  let totalCost: number | null = null;
  let credits: number | null = null;

  if (usageRes.ok && usageRes.data && typeof usageRes.data === "object") {
    const usage = usageRes.data as Record<string, unknown>;
    totalCost =
      parseNumber(usage.total_cost) ??
      parseNumber(usage.total_amount) ??
      parseNumber(usage.amount);
    credits = parseNumber(usage.remaining_quota);
  }

  if (limitsRes.ok && limitsRes.data && typeof limitsRes.data === "object") {
    const limits = limitsRes.data as Record<string, unknown>;
    const spendLimit = parseNumber(limits.spend_limit);
    const currentSpend = parseNumber(limits.current_spend);
    if (spendLimit != null && currentSpend != null) {
      balance = Math.max(0, spendLimit - currentSpend);
    }
  }

  return {
    balance,
    totalCost,
    totalRequests: null,
    credits,
    rawData,
  };
}
