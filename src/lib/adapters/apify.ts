import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.apify.com/v2/users/me/limits", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    data?: {
      limits?: { maxMonthlyUsageUsd?: number };
      current?: { monthlyUsageUsd?: number };
    };
  };

  const maxMonthly = parseNumber(data.data?.limits?.maxMonthlyUsageUsd);
  const usedMonthly = parseNumber(data.data?.current?.monthlyUsageUsd);
  const balance =
    maxMonthly != null && usedMonthly != null
      ? Math.max(0, maxMonthly - usedMonthly)
      : null;

  return {
    balance,
    totalCost: usedMonthly,
    totalRequests: null,
    credits: balance,
    rawData: data,
  };
}
