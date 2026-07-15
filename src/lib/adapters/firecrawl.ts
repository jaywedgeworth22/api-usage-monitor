import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

const CREDIT_USAGE_URL = "https://api.firecrawl.dev/v2/team/credit-usage";

function responseObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function nullableIsoTimestamp(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const token = apiKey.trim();
  if (!token) {
    configurationError("Firecrawl API key is required");
  }

  const response = await fetchJson(CREDIT_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return errorResult(response.status, {
      note:
        response.status === 401 || response.status === 403
          ? "Firecrawl rejected the API key"
          : "Firecrawl team credit usage was unavailable",
    });
  }

  const body = responseObject(response.data);
  const data = responseObject(body?.data);
  if (body?.success !== true || !data) {
    throw new AdapterError(
      "Firecrawl returned an unsuccessful or invalid credit-usage response",
      { code: "INVALID_RESPONSE" }
    );
  }

  const remainingCredits = nonNegativeNumber(data.remainingCredits);
  const planCredits = nonNegativeNumber(data.planCredits);
  const billingPeriodStart = nullableIsoTimestamp(data.billingPeriodStart);
  const billingPeriodEnd = nullableIsoTimestamp(data.billingPeriodEnd);
  if (
    remainingCredits == null ||
    planCredits == null ||
    billingPeriodStart === undefined ||
    billingPeriodEnd === undefined ||
    (billingPeriodStart != null &&
      billingPeriodEnd != null &&
      Date.parse(billingPeriodEnd) <= Date.parse(billingPeriodStart))
  ) {
    throw new AdapterError(
      "Firecrawl returned invalid credit totals or billing-period dates",
      { code: "INVALID_RESPONSE" }
    );
  }

  return {
    balance: null,
    totalCost: null,
    costScope: "unknown",
    totalRequests: null,
    credits: remainingCredits,
    rawData: {
      credits: {
        plan: planCredits,
        remaining: remainingCredits,
      },
      billingPeriod: {
        start: billingPeriodStart,
        end: billingPeriodEnd,
      },
      capabilities: {
        currentCreditQuota: true,
        billingPeriod:
          billingPeriodStart != null || billingPeriodEnd != null,
        providerReportedUsage: false,
        planTier: false,
        usdCost: false,
        renewalDate: false,
      },
    },
    externalBilling: {
      source: "firecrawl-team-credit-usage",
      authoritative: true,
      records: [
        {
          externalId: "team-credit-plan",
          kind: "plan",
          serviceName: "Firecrawl API",
          currentPeriodStart: billingPeriodStart,
          currentPeriodEnd: billingPeriodEnd,
          requestLimit: planCredits,
          requestLimitWindow: "billing period",
          remainingQuantity: remainingCredits,
          usageUnit: "credits",
          rollupRole: "metadata",
          dateKind: billingPeriodEnd == null ? null : "period_end",
        },
      ],
    },
  };
}
