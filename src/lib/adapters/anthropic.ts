import {
  emptyResult,
  errorResult,
  fetchJson,
  isoDateTimeDaysAgo,
  parseNumber,
  sumDailyCosts,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  const end = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = isoDateTimeDaysAgo(30);
  const orgId = config?.orgId as string | undefined;
  const rawData: Record<string, unknown> = {};

  const requests: Promise<unknown>[] = [
    fetchJson("https://api.anthropic.com/v1/organizations/cost_report", {
      headers,
      method: "POST",
      body: JSON.stringify({
        starting_at: start,
        ending_at: end,
        bucket_width: "1d",
        limit: 31,
      }),
    }).then((res) => {
      rawData.costReport = res.data;
      return res;
    }),
    fetchJson("https://api.anthropic.com/v1/billing/usage", { headers }).then(
      (res) => {
        rawData.billingUsage = res.data;
        return res;
      }
    ),
  ];

  if (orgId) {
    requests.push(
      fetchJson(
        `https://console.anthropic.com/api/organizations/${orgId}/prepaid/credits`,
        { headers }
      ).then((res) => {
        rawData.prepaidCredits = res.data;
        return res;
      })
    );
  }

  const results = await Promise.all(requests);
  const costRes = results[0] as Awaited<ReturnType<typeof fetchJson>>;
  const billingRes = results[1] as Awaited<ReturnType<typeof fetchJson>>;

  if (!costRes.ok && !billingRes.ok) {
    return errorResult(costRes.status || billingRes.status, rawData);
  }

  let balance: number | null = null;
  let totalCost: number | null = null;
  let totalRequests: number | null = null;

  if (orgId && rawData.prepaidCredits && typeof rawData.prepaidCredits === "object") {
    const prepaid = rawData.prepaidCredits as Record<string, unknown>;
    const amountCents = parseNumber(prepaid.amount);
    if (amountCents != null) balance = amountCents / 100;
  }

  if (costRes.ok && costRes.data && typeof costRes.data === "object") {
    const report = costRes.data as { data?: Array<{ results?: Array<{ amount?: string | number }> }> };
    totalCost = sumDailyCosts(report.data || []);
  }

  if (
    billingRes.ok &&
    billingRes.data &&
    typeof billingRes.data === "object"
  ) {
    const billing = billingRes.data as Record<string, unknown>;
    if (totalCost == null) totalCost = parseNumber(billing.total_cost);
    totalRequests = parseNumber(billing.total_requests);
  }

  return { balance, totalCost, totalRequests, credits: null, rawData };
}
