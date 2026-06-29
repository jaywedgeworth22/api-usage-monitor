import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api-v2.intrinio.com/securities/AAPL/prices/realtime?api_key=${encodeURIComponent(apiKey)}`
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
      note: "Intrinio does not expose account balance via API. Key validated with a realtime price request.",
    },
  };
}
