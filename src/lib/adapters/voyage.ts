import {
  emptyResult,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voyage-4-lite",
      input: ["ping"],
    }),
  });

  const rawData: Record<string, unknown> = {
    status: res.status,
    response: res.data,
    note: "Voyage AI does not expose remaining credits via API. Key validated with a minimal embedding call.",
  };

  if (!res.ok) {
    return errorResult(res.status, rawData);
  }

  return {
    balance: null,
    totalCost: null,
    totalRequests: 1,
    credits: null,
    rawData,
  };
}
