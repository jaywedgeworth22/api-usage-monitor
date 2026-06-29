import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=${encodeURIComponent(apiKey)}&file_type=json`
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
      note: "FRED does not expose account balance via API. Key validated with a series request.",
    },
  };
}
