import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey=${encodeURIComponent(apiKey)}`
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  return {
    balance: null,
    totalCost: null,
    totalRequests: 1,
    credits: null,
    rawData: {
      response: res.data,
      note: "Massive (Polygon) does not expose account balance via API. Key validated with a prev aggregate request.",
    },
  };
}
