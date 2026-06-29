import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.twelvedata.com/quote?symbol=AAPL&apikey=${encodeURIComponent(apiKey)}`
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as Record<string, unknown>;
  const isValid = data.symbol != null && !data.code;

  return {
    balance: null,
    totalCost: null,
    totalRequests: isValid ? 1 : null,
    credits: null,
    rawData: {
      response: data,
      note: "Twelve Data does not expose account balance via API. Key validated with a quote request.",
    },
  };
}
