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
  const limit = headerNumber(res.headers, [
    "x-ratelimit-limit",
    "x-rate-limit-limit",
    "ratelimit-limit",
  ]);

  if (!res.ok) {
    return errorResult(res.status, { response: res.data, note });
  }

  // FMP's free/basic tiers have no account balance/credit concept - only a
  // per-minute call quota. Don't surface the rate-limit-remaining count as
  // balance/credits/totalRequests (those imply an accumulated resource or
  // usage total, not a transient per-minute counter that resets every
  // minute) - keep it in rawData only.
  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      response: res.data,
      note,
      rateLimit: { remaining, limit },
    },
  };
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  return validateMarketData(
    `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${encodeURIComponent(apiKey)}`,
    "FMP does not expose account balance via API. Key validated with a quote request."
  );
}
