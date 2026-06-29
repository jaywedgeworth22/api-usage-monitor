import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.pushover.net/1/licenses.json?token=${encodeURIComponent(apiKey)}`
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as { status?: number; credits?: number };
  if (data.status !== 1) {
    return emptyResult(data);
  }

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: parseNumber(data.credits),
    rawData: data,
  };
}
