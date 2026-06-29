import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const modelsRes = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  );

  if (!modelsRes.ok) {
    return errorResult(modelsRes.status, { models: modelsRes.data });
  }

  const models =
    modelsRes.data &&
    typeof modelsRes.data === "object" &&
    Array.isArray((modelsRes.data as { models?: unknown[] }).models)
      ? (modelsRes.data as { models: unknown[] }).models
      : [];

  const rawData: Record<string, unknown> = {
    models,
    note: "Google AI Studio does not expose remaining balance via API key. Key validated via models list.",
  };

  return {
    balance: null,
    totalCost: null,
    totalRequests: models.length > 0 ? models.length : null,
    credits: null,
    rawData,
  };
}
