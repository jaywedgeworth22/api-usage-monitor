import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${encodeURIComponent(apiKey)}`
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as Record<string, unknown>;
  const note =
    typeof data.Note === "string"
      ? data.Note
      : "Alpha Vantage does not expose account balance via API. Key validated with a quote request.";

  const hasQuote =
    data["Global Quote"] &&
    typeof data["Global Quote"] === "object" &&
    Object.keys(data["Global Quote"] as object).length > 0;

  return {
    balance: null,
    totalCost: null,
    totalRequests: hasQuote ? 1 : null,
    credits: null,
    rawData: { response: data, note },
  };
}
