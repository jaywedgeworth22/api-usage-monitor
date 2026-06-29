import {
  emptyResult,
  errorResult,
  fetchJson,
  headerNumber,
  parseNumber,
  type UsageResult,
} from "./helpers";

async function validateMarketData(
  url: string,
  note: string
): Promise<UsageResult> {
  const res = await fetchJson(url);
  const remaining = headerNumber(res.headers, [
    "x-ratelimit-remaining",
    "x-rate-limit-remaining",
    "ratelimit-remaining",
  ]);

  if (!res.ok) {
    return errorResult(res.status, { response: res.data, note });
  }

  return {
    balance: remaining,
    totalCost: null,
    totalRequests: remaining,
    credits: remaining,
    rawData: {
      response: res.data,
      note,
      rateLimitRemaining: remaining,
    },
  };
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  return validateMarketData(
    `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${encodeURIComponent(apiKey)}`,
    "FMP does not expose account balance via API. Key validated with a quote request."
  );
}
