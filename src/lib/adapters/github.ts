import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

interface GitHubUsageItem {
  product?: string;
  sku?: string;
  unitType?: string;
  quantity?: number;
  netQuantity?: number;
  netAmount?: number;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const org =
    ((config?.org ?? config?.orgSlug) as string | undefined)?.trim();
  if (!org) configurationError("org is required for GitHub billing usage");

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const params = new URLSearchParams({
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1),
  });
  const response = await fetchJson(
    `https://api.github.com/organizations/${encodeURIComponent(org)}/settings/billing/usage?${params}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${apiKey}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "api-usage-monitor/1.0",
      },
    }
  );
  if (!response.ok) {
    return errorResult(response.status, {
      note: "GitHub enhanced billing requires organization Administration read permission",
    });
  }

  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
    throw new AdapterError("GitHub billing usage expected a response object", {
      code: "INVALID_RESPONSE",
    });
  }
  const data = response.data as { usageItems?: GitHubUsageItem[] };
  if (!Array.isArray(data.usageItems)) {
    throw new AdapterError("GitHub billing usage expected usageItems[]", {
      code: "INVALID_RESPONSE",
    });
  }
  const items = data.usageItems;
  let totalCost = 0;
  let foundCost = false;
  const byProduct = new Map<string, {
    product: string;
    sku: string;
    unit: string | null;
    quantity: number;
    netAmountUsd: number;
  }>();
  for (const item of items) {
    if (!item || typeof item !== "object" || parseNumber(item.netAmount) == null) {
      throw new AdapterError("GitHub billing usage item omitted netAmount", {
        code: "INVALID_RESPONSE",
      });
    }
    const amount = parseNumber(item.netAmount);
    if (amount != null) {
      totalCost += amount;
      foundCost = true;
    }
    const product = item.product ?? "unknown";
    const sku = item.sku ?? "unknown";
    const key = [product, sku].join(" / ");
    const aggregate = byProduct.get(key) ?? {
      product,
      sku,
      unit: item.unitType ?? null,
      quantity: 0,
      netAmountUsd: 0,
    };
    aggregate.quantity += parseNumber(item.netQuantity ?? item.quantity) ?? 0;
    aggregate.netAmountUsd += amount ?? 0;
    byProduct.set(key, aggregate);
  }
  const month = monthStart.toISOString().slice(0, 7);
  const records = [
    {
      externalId: `${org.toLowerCase()}:${month}`,
      kind: "billing_period" as const,
      serviceName: "GitHub",
      planName: "Enhanced billing total",
      status: "open",
      amountUsd: foundCost ? totalCost : null,
      currency: "USD",
      currentPeriodStart: monthStart.toISOString(),
      currentPeriodEnd: monthEnd.toISOString(),
      rollupRole: "canonical" as const,
      dateKind: "period_end" as const,
    },
    ...[...byProduct.values()].map((aggregate) => ({
      externalId: `${org.toLowerCase()}:${month}:${aggregate.product}:${aggregate.sku}`,
      kind: "billing_period" as const,
      serviceName: aggregate.product,
      planName: aggregate.sku,
      status: "open",
      amountUsd: aggregate.netAmountUsd,
      currency: "USD",
      currentPeriodStart: monthStart.toISOString(),
      currentPeriodEnd: monthEnd.toISOString(),
      usageQuantity: aggregate.quantity,
      usageUnit: aggregate.unit,
      rollupRole: "component" as const,
      dateKind: "period_end" as const,
    })),
  ];

  return {
    balance: null,
    totalCost: foundCost ? totalCost : null,
    costWindowStart: foundCost ? monthStart : null,
    costWindowEnd: foundCost ? now : null,
    costScope: foundCost ? "calendar_month_to_date" : "unknown",
    totalRequests: null,
    credits: null,
    rawData: {
      organization: org,
      month,
      itemCount: items.length,
      byProduct: Object.fromEntries(byProduct),
      capabilities: {
        actualBilledUsage: true,
        enhancedBillingPlatformRequired: true,
        requiredPermission: "Organization Administration read",
      },
    },
    externalBilling: {
      source: "github-enhanced-billing",
      authoritative: true,
      records,
    },
  };
}
