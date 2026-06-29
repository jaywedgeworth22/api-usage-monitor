import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.tiingo.com/api/test", {
    headers: { Authorization: `Token ${apiKey}` },
  });

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
      note: "Tiingo does not expose account balance via API. Key validated with /api/test.",
    },
  };
}
