import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `http://api.marketstack.com/v1/eod/latest?access_key=${encodeURIComponent(apiKey)}&symbols=AAPL`
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
      note: "Marketstack does not expose account balance via API. Key validated with a latest EOD request.",
    },
  };
}
