import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.fintechstudios.com/v1/market/status", {
    headers: { Authorization: `Bearer ${apiKey}` },
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
      note: "Fintech Studios does not expose account balance via API. Key validated with market status.",
    },
  };
}
