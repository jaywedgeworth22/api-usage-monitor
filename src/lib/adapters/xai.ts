import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const managementKey =
    (config?.managementKey as string | undefined) || apiKey;
  const teamId = config?.teamId as string | undefined;

  if (!teamId) {
    return emptyResult({
      error: "teamId is required in config for xAI balance tracking",
      note: "Find your team ID in the xAI Console billing settings.",
    });
  }

  const res = await fetchJson(
    `https://management-api.x.ai/v1/billing/teams/${teamId}/prepaid/balance`,
    { headers: { Authorization: `Bearer ${managementKey}` } }
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  if (!res.data || typeof res.data !== "object") {
    return emptyResult(res.data);
  }

  const data = res.data as {
    total?: { val?: string };
    changes?: Array<{ changeOrigin?: string; amount?: { val?: string } }>;
  };

  const totalCents = parseNumber(data.total?.val);
  const balance =
    totalCents != null ? Math.abs(totalCents) / 100 : null;

  let totalCost = 0;
  let hasSpend = false;
  for (const change of data.changes || []) {
    if (change.changeOrigin === "SPEND") {
      const spend = parseNumber(change.amount?.val);
      if (spend != null) {
        totalCost += spend / 100;
        hasSpend = true;
      }
    }
  }

  return {
    balance,
    totalCost: hasSpend ? totalCost : null,
    totalRequests: data.changes?.length ?? null,
    credits: balance,
    rawData: data,
  };
}
