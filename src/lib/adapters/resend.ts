import {
  emptyResult,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.resend.com/api-keys", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "api-usage-monitor/1.0",
    },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as { data?: unknown[] };
  const keyCount = Array.isArray(data.data) ? data.data.length : 0;

  return {
    balance: null,
    totalCost: null,
    totalRequests: keyCount > 0 ? keyCount : null,
    credits: null,
    rawData: {
      ...data,
      note: "Resend does not expose remaining email quota via API. Key validated via api-keys endpoint.",
    },
  };
}
