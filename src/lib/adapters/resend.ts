import {
  errorResult,
  fetchJson,
  headerNumber,
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
  const rateLimit = headerNumber(res.headers, ["ratelimit-limit", "x-ratelimit-limit"]);
  const rateRemaining = headerNumber(res.headers, ["ratelimit-remaining", "x-ratelimit-remaining"]);
  const rateReset = res.headers.get("ratelimit-reset") ?? res.headers.get("x-ratelimit-reset");

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      apiKeyCount: keyCount,
      apiRateLimit: {
        limit: rateLimit,
        remaining: rateRemaining,
        reset: rateReset,
      },
      note: "Resend does not expose remaining email quota, plan, or billing cost via API. Authentication was checked through the non-sending API-key control plane.",
      capabilities: {
        nonBillableKeyValidation: true,
        apiRequestRateHeaders: rateLimit != null || rateRemaining != null,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
    externalBilling:
      rateLimit != null || rateRemaining != null
        ? {
            source: "resend-api-rate-limit",
            authoritative: true,
            records: [
              {
                externalId: "account-api-rate-limit",
                kind: "account",
                serviceName: "Resend API",
                planName: "API request rate limit",
                status: "active",
                requestLimit: rateLimit,
                requestLimitWindow: rateReset ? `reset ${rateReset}` : "provider-defined window",
                usageQuantity:
                  rateLimit != null && rateRemaining != null
                    ? Math.max(0, rateLimit - rateRemaining)
                    : null,
                remainingQuantity: rateRemaining,
                usageUnit: "API requests",
                rollupRole: "metadata",
              },
            ],
          }
        : undefined,
  };
}
