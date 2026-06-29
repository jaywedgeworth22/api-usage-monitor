import {
  errorResult,
  fetchJson,
  headerNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(apiKey)}`
  );
  const remaining = headerNumber(res.headers, [
    "x-ratelimit-remaining",
    "x-rate-limit-remaining",
  ]);

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  return {
    balance: remaining,
    totalCost: null,
    totalRequests: remaining,
    credits: remaining,
    rawData: {
      response: res.data,
      note: "Finnhub does not expose account balance via API. Key validated with a quote request.",
      rateLimitRemaining: remaining,
    },
  };
}
