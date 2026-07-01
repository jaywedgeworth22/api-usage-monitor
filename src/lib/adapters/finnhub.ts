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
  const limit = headerNumber(res.headers, [
    "x-ratelimit-limit",
    "x-rate-limit-limit",
  ]);

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  // Finnhub's free tier has no account balance/credit concept - only a
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
      note: "Finnhub does not expose account balance via API. Key validated with a quote request.",
      rateLimit: { remaining, limit },
    },
  };
}
