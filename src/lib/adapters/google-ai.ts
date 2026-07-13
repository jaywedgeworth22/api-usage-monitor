import {
  errorResult,
  fetchJson,
  headerNumber,
  type UsageResult,
} from "./helpers";
import {
  fetchGoogleCloudBilling,
  hasGoogleCloudBillingConfig,
} from "./google-cloud-billing";

export async function fetchUsage(
  apiKey: string,
  config: Record<string, unknown> = {}
): Promise<UsageResult> {
  // Listing model metadata is a non-inference control-plane read. Google AI
  // Studio does not expose billing through the Gemini key. When configured,
  // actual spend comes from a read-only Cloud Billing BigQuery export.
  const billingConfigured = hasGoogleCloudBillingConfig(config);
  const modelRequest = fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { headers: { "Content-Type": "application/json" } }
  );
  const [response, billing] = billingConfigured
    ? await Promise.all([modelRequest, fetchGoogleCloudBilling(config)])
    : [await modelRequest, null];

  if (!response.ok && !billing) {
    return errorResult(response.status, {
      note: "Gemini key validation failed; Google AI Studio has no billing API",
    });
  }

  const data = (response.data ?? {}) as { models?: unknown[] };
  const remaining = headerNumber(response.headers, ["x-ratelimit-remaining"]);
  const limit = headerNumber(response.headers, ["x-ratelimit-limit"]);
  const reset = response.headers.get("x-ratelimit-reset");

  return {
    balance: null,
    totalCost: billing?.totalCostUsd ?? null,
    costWindowStart: billing?.windowStart ?? null,
    costWindowEnd: billing?.windowEnd ?? null,
    costScope: billing ? "calendar_month_to_date" : undefined,
    totalRequests: null,
    credits: remaining,
    rawData: {
      keyValidation: {
        ok: response.ok,
        status: response.status,
        availableModelCount:
          response.ok && Array.isArray(data.models) ? data.models.length : null,
      },
      rateLimit: { remaining, limit, reset },
      billing: billing
        ? {
            configured: true,
            status: billing.status,
            source: "standard-bigquery-export",
            dataset: billing.dataset,
            tableId: billing.tableId,
            queryProjectId: billing.queryProjectId,
            observedProjectCount: billing.projectCount,
            skuCount: billing.rows.length,
            reportThrough: billing.reportThrough,
            maximumBytesBilled: 1_073_741_824,
          }
        : {
            configured: false,
            note: "Google AI Studio exposes no billing API. Configure the standard Cloud Billing BigQuery export for direct spend.",
          },
      capabilities: {
        nonBillableKeyValidation: response.ok,
        billingCost: billing?.status === "ready",
        subscriptionStatus: false,
      },
    },
    externalBilling: billing?.externalBilling,
    externalBillingSyncs: limit != null
      ? [{
          source: "google-gemini-rate-limits",
          authoritative: true,
          records: [
            {
              externalId: "gemini-api-key",
              kind: "account",
              planName: "Gemini API quota",
              status: "active",
              requestLimit: limit,
              requestLimitWindow: "provider-defined",
            },
          ],
        }]
      : undefined,
  };
}
