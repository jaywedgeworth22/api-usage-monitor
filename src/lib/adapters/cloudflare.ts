import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingSync,
  type UsageResult,
  type AdapterExternalBillingRecord,
} from "./helpers";

interface AnalyticsDashboardResponse {
  result?: {
    totals?: {
      requests?: number;
      bandwidth?: number;
    };
  };
}

interface CloudflareSubscription {
  id?: string;
  currency?: string;
  current_period_start?: string;
  current_period_end?: string;
  frequency?: string;
  price?: number;
  rate_plan?: { id?: string; public_name?: string };
  state?: string;
}

const SUBSCRIPTIONS_PER_PAGE = 50;
const MAX_SUBSCRIPTION_PAGES = 1_000;

function invalidSubscriptionsResponse(message: string): never {
  throw new AdapterError(`Cloudflare subscriptions: ${message}`, {
    code: "INVALID_RESPONSE",
  });
}

function isNonNegativeInteger(value: number | null): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number | null): value is number {
  return value != null && Number.isSafeInteger(value) && value > 0;
}

async function fetchAllSubscriptions(
  baseUrl: string,
  headers: Record<string, string>
): Promise<{ rows: CloudflareSubscription[]; pages: number }> {
  const rows: CloudflareSubscription[] = [];
  const seenIds = new Set<string>();
  let expectedTotal: number | null = null;
  let expectedPerPage: number | null = null;

  for (let requestedPage = 1; requestedPage <= MAX_SUBSCRIPTION_PAGES; requestedPage++) {
    const params = new URLSearchParams({
      page: String(requestedPage),
      per_page: String(SUBSCRIPTIONS_PER_PAGE),
    });
    const response = await fetchJson(`${baseUrl}/subscriptions?${params}`, {
      headers,
    });
    if (!response.ok) {
      errorResult(response.status, {
        note: "Cloudflare account subscriptions require Account Billing Read",
      });
    }
    if (!response.data || typeof response.data !== "object") {
      invalidSubscriptionsResponse("expected a response object");
    }

    const page = response.data as {
      result?: CloudflareSubscription[];
      result_info?: {
        count?: number;
        page?: number;
        per_page?: number;
        total_count?: number;
      };
    };
    if (!Array.isArray(page.result) || !page.result_info) {
      invalidSubscriptionsResponse("expected result[] and result_info");
    }

    const count = parseNumber(page.result_info.count);
    const pageNumber = parseNumber(page.result_info.page);
    const perPage = parseNumber(page.result_info.per_page);
    const totalCount = parseNumber(page.result_info.total_count);
    if (
      !isNonNegativeInteger(count) ||
      !isPositiveInteger(pageNumber) || pageNumber !== requestedPage ||
      !isPositiveInteger(perPage) ||
      !isNonNegativeInteger(totalCount)
    ) {
      invalidSubscriptionsResponse("pagination metadata was missing or invalid");
    }
    if (count !== page.result.length) {
      invalidSubscriptionsResponse("result_info.count did not match result length");
    }
    if (expectedTotal == null) expectedTotal = totalCount;
    if (expectedPerPage == null) expectedPerPage = perPage;
    if (totalCount !== expectedTotal || perPage !== expectedPerPage) {
      invalidSubscriptionsResponse("pagination metadata changed between pages");
    }

    for (const subscription of page.result) {
      if (!subscription || typeof subscription !== "object") {
        invalidSubscriptionsResponse("subscription entry was not an object");
      }
      const id = typeof subscription.id === "string"
        ? subscription.id.trim()
        : "";
      if (!id) invalidSubscriptionsResponse("subscription id was missing");
      if (seenIds.has(id)) {
        invalidSubscriptionsResponse(`subscription id ${id} was repeated`);
      }
      seenIds.add(id);
      rows.push(subscription);
    }

    if (rows.length > expectedTotal) {
      invalidSubscriptionsResponse("received more subscriptions than total_count");
    }
    if (rows.length === expectedTotal) {
      return { rows, pages: requestedPage };
    }
    if (page.result.length === 0) {
      invalidSubscriptionsResponse("pagination ended before total_count was reached");
    }
  }

  invalidSubscriptionsResponse(
    `pagination exceeded the ${MAX_SUBSCRIPTION_PAGES}-page safety limit`
  );
}

function makeHeaders(
  apiKey: string,
  accountEmail?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accountEmail) {
    headers["X-Auth-Email"] = accountEmail;
    headers["X-Auth-Key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const accountId = config?.accountId as string | undefined;

  if (!accountId) {
    configurationError("accountId is required in config");
  }

  const accountEmail = config?.accountEmail as string | undefined;
  const headers = makeHeaders(apiKey, accountEmail);
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const rawData: Record<string, unknown> = {};

  let totalRequests: number | null = null;
  let totalCost: number | null = null;
  let fixedCostIncludedUsd: number | null = null;
  let successfulCalls = 0;
  const billingSyncs: AdapterExternalBillingSync[] = [];
  const failedStatuses: number[] = [];

  // 1. Analytics dashboard (general stats)
  const now = new Date();
  const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const analyticsParams = new URLSearchParams({
    since: thirtyDaysAgo.toISOString(),
    until: now.toISOString(),
    continuous: "true",
  });

  try {
    const analyticsRes = await fetchJson(
      `${baseUrl}/analytics/dashboard?${analyticsParams}`,
      { headers }
    );
    if (analyticsRes.ok) {
      const analytics = analyticsRes.data as AnalyticsDashboardResponse;
      rawData.analytics = analytics;
      successfulCalls++;
      if (analytics.result?.totals?.requests != null) {
        totalRequests = analytics.result.totals.requests;
      }
      if (analytics.result?.totals?.bandwidth != null) {
        rawData.totalBandwidth_bytes = analytics.result.totals.bandwidth;
      }
    } else {
      failedStatuses.push(analyticsRes.status);
      rawData.analyticsError = `HTTP ${analyticsRes.status}`;
    }
  } catch (err) {
    rawData.analyticsError = err instanceof Error ? err.message : "Failed";
  }

  // 2. Workers analytics
  try {
    const workersRes = await fetchJson(
      `${baseUrl}/workers/analytics/dashboard?${analyticsParams}`,
      { headers }
    );
    if (workersRes.ok) {
      const workersData = workersRes.data as AnalyticsDashboardResponse;
      rawData.workers = workersData;
      successfulCalls++;
      if (workersData.result?.totals?.requests != null) {
        // Account analytics is the broader total. Workers analytics is a
        // fallback only, never an additive second count of the same traffic.
        if (totalRequests == null) {
          totalRequests = workersData.result.totals.requests;
        }
      }
    } else {
      failedStatuses.push(workersRes.status);
      rawData.workersError = `HTTP ${workersRes.status}`;
    }
  } catch (err) {
    rawData.workersError = err instanceof Error ? err.message : "Failed";
  }

  // 3. Fixed subscriptions and renewal/status metadata. Billing Read is the
  // least-privilege Cloudflare token permission for this endpoint. Usage
  // overages are intentionally not inferred from analytics (Cloudflare states
  // that analytics datasets are not billing-grade).
  try {
    const { rows, pages } = await fetchAllSubscriptions(baseUrl, headers);
    successfulCalls++;
    rawData.subscriptions = rows;

    const nowMs = now.getTime();
    let billedThisMonthUsd = 0;
    let foundBilledSubscription = false;
    const billingRecords: AdapterExternalBillingRecord[] = [];
    for (const subscription of rows) {
      const price = parseNumber(subscription.price);
      const currency = subscription.currency?.trim().toUpperCase() || null;
      const periodStart = subscription.current_period_start
        ? Date.parse(subscription.current_period_start)
        : Number.NaN;
      const normalizedState = (subscription.state ?? "unknown")
        .trim()
        .toLowerCase();
      const isLive = ![
        "cancelled",
        "canceled",
        "failed",
        "expired",
        "inactive",
      ].includes(normalizedState);
      if (
        price != null &&
        currency === "USD" &&
        isLive &&
        periodStart >= monthStartMs &&
        periodStart <= nowMs
      ) {
        billedThisMonthUsd += price;
        foundBilledSubscription = true;
      }
      billingRecords.push({
        externalId: subscription.id!,
        kind: "subscription",
        serviceName: "Cloudflare subscription",
        planName:
          subscription.rate_plan?.public_name ??
          subscription.rate_plan?.id ??
          null,
        status: normalizedState || "unknown",
        amountUsd: currency == null ? null : price,
        currency,
        billingInterval: subscription.frequency ?? null,
        currentPeriodStart: subscription.current_period_start ?? null,
        currentPeriodEnd: subscription.current_period_end ?? null,
        nextRenewalAt: isLive
          ? subscription.current_period_end ?? null
          : null,
        rollupRole: "canonical",
        dateKind: "renewal",
      });
    }
    billingSyncs.push({
      source: "cloudflare-subscriptions",
      authoritative: true,
      records: billingRecords,
    });
    if (foundBilledSubscription) {
      totalCost = billedThisMonthUsd;
      fixedCostIncludedUsd = billedThisMonthUsd;
    }
    rawData.billing = {
      fixedSubscriptionBilledThisMonthUsd:
        foundBilledSubscription ? billedThisMonthUsd : null,
      subscriptionCount: rows.length,
      subscriptionPages: pages,
      capabilities: {
        fixedSubscriptionPrice: true,
        subscriptionStatus: true,
        renewalDate: true,
        usageOverageCost: false,
      },
    };
  } catch (error) {
    if (error instanceof AdapterError && error.code === "INVALID_RESPONSE") {
      throw error;
    }
    rawData.subscriptionsCapability = {
      available: false,
      error: error instanceof Error ? error.message : "Failed",
      requiredPermission: "Account Billing Read",
    };
  }

  // 4. PayGo billable usage is Cloudflare's billing-grade alpha endpoint.
  // It is restricted to select self-serve accounts; a 403/404 is a capability
  // miss, not a reason to discard otherwise valid subscription/analytics data.
  try {
    const paygoResponse = await fetchJson(`${baseUrl}/paygo-usage`, { headers });
    if (paygoResponse.ok) {
      if (
        !paygoResponse.data ||
        typeof paygoResponse.data !== "object" ||
        Array.isArray(paygoResponse.data)
      ) {
        throw new AdapterError("Cloudflare PayGo usage expected a response object", {
          code: "INVALID_RESPONSE",
        });
      }
      const paygo = paygoResponse.data as {
        result?: Array<{
          BillingCurrency?: string;
          BillingPeriodStart?: string;
          ChargePeriodEnd?: string;
          ConsumedQuantity?: number;
          ConsumedUnit?: string;
          ContractedCost?: number;
          ServiceName?: string;
        }>;
      };
      if (!Array.isArray(paygo.result)) {
        throw new AdapterError("Cloudflare PayGo usage expected result[]", {
          code: "INVALID_RESPONSE",
        });
      }
      successfulCalls++;
      const rows = paygo.result.filter((row) => {
        const periodStart = row.BillingPeriodStart
          ? Date.parse(row.BillingPeriodStart)
          : Number.NaN;
        return Number.isFinite(periodStart) && periodStart >= monthStartMs && periodStart <= now.getTime();
      });
      let paygoCostUsd = 0;
      let foundPaygoCost = false;
      const byService = new Map<string, {
        serviceName: string;
        currency: string | null;
        contractedCost: number;
        hasContractedCost: boolean;
        quantity: number;
        unit: string | null;
      }>();
      const costByCurrency = new Map<string, number>();
      for (const row of rows) {
        const cost = parseNumber(row.ContractedCost);
        const currency = row.BillingCurrency?.trim().toUpperCase() || null;
        if (currency === "USD" && cost != null) {
          paygoCostUsd += cost;
          foundPaygoCost = true;
        }
        if (currency && cost != null) {
          costByCurrency.set(currency, (costByCurrency.get(currency) ?? 0) + cost);
        }
        const serviceName = row.ServiceName ?? "Unknown service";
        const unit = row.ConsumedUnit ?? null;
        const key = `${currency ?? "unknown"}\u0000${serviceName}\u0000${unit ?? ""}`;
        const aggregate = byService.get(key) ?? {
          serviceName,
          currency,
          contractedCost: 0,
          hasContractedCost: false,
          quantity: 0,
          unit,
        };
        if (currency && cost != null) {
          aggregate.contractedCost += cost;
          aggregate.hasContractedCost = true;
        }
        aggregate.quantity += parseNumber(row.ConsumedQuantity) ?? 0;
        byService.set(key, aggregate);
      }
      if (foundPaygoCost) totalCost = (totalCost ?? 0) + paygoCostUsd;
      const periodStart = rows[0]?.BillingPeriodStart ??
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const periodEnd = rows.reduce<string | null>((latest, row) => {
        if (!row.ChargePeriodEnd) return latest;
        return latest == null || row.ChargePeriodEnd > latest
          ? row.ChargePeriodEnd
          : latest;
      }, null) ?? now.toISOString();
      rawData.paygoBilling = {
        currentPeriodCostUsd: foundPaygoCost ? paygoCostUsd : null,
        recordCount: rows.length,
        excludedOutOfPeriodRecords: paygo.result.length - rows.length,
        byService: [...byService.values()],
        alpha: true,
      };
      billingSyncs.push({
        source: "cloudflare-paygo-usage",
        authoritative: true,
        records: rows.length > 0
          ? [
              ...[...costByCurrency.entries()].map(([currency, amount]) => ({
                externalId: `${accountId}:${periodStart.slice(0, 7)}:${currency}`,
                kind: "billing_period",
                serviceName: "Cloudflare PayGo",
                planName: `${currency} monthly billable usage`,
                status: "open",
                amountUsd: amount,
                currency,
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd,
                rollupRole: "canonical",
                dateKind: "period_end",
              } as const)),
              ...[...byService.values()].map((aggregate) => ({
                externalId: `${accountId}:${periodStart.slice(0, 7)}:${encodeURIComponent(
                  `${aggregate.currency ?? "unknown"}:${aggregate.serviceName}:${aggregate.unit ?? ""}`
                )}`,
                kind: "billing_period" as const,
                serviceName: aggregate.serviceName,
                planName: "PayGo service usage",
                status: "open",
                amountUsd: aggregate.hasContractedCost
                  ? aggregate.contractedCost
                  : null,
                currency: aggregate.currency,
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd,
                usageQuantity: aggregate.quantity,
                usageUnit: aggregate.unit,
                rollupRole: "component" as const,
                dateKind: "period_end" as const,
              })),
            ]
          : [],
      });
    } else {
      rawData.paygoBillingCapability = {
        available: false,
        status: paygoResponse.status,
        note: "Alpha endpoint is restricted to select PayGo accounts",
      };
    }
  } catch (error) {
    rawData.paygoBillingCapability = {
      available: false,
      error: error instanceof Error ? error.message : "Failed",
    };
  }

  // 5. D1 database metrics
  const databaseId = config?.databaseId as string | undefined;
  if (databaseId) {
    try {
      const d1Res = await fetchJson(`${baseUrl}/d1/database/${databaseId}`, {
        headers,
      });
      if (d1Res.ok) {
        successfulCalls++;
        rawData.d1 = d1Res.data;
      }
    } catch {
      // best effort
    }
  }

  // 6. R2 storage bytes
  const r2BucketName = config?.r2BucketName as string | undefined;
  if (r2BucketName) {
    try {
      const r2Res = await fetchJson(
        `${baseUrl}/r2/buckets/${r2BucketName}`,
        { headers }
      );
      if (r2Res.ok) {
        successfulCalls++;
        rawData.r2 = r2Res.data;
      }
    } catch {
      // best effort
    }
  }

  // 7. KV namespace
  const kvNamespaceId = config?.kvNamespaceId as string | undefined;
  if (kvNamespaceId) {
    try {
      const kvRes = await fetchJson(
        `${baseUrl}/storage/kv/namespaces/${kvNamespaceId}`,
        { headers }
      );
      if (kvRes.ok) {
        successfulCalls++;
        rawData.kv = kvRes.data;
      }
    } catch {
      // best effort
    }
  }

  // 8. Queue message counts
  const queueId = config?.queueId as string | undefined;
  if (queueId) {
    try {
      const queueRes = await fetchJson(`${baseUrl}/queues/${queueId}`, {
        headers,
      });
      if (queueRes.ok) {
        successfulCalls++;
        rawData.queue = queueRes.data;
      }
    } catch {
      // best effort
    }
  }

  if (successfulCalls === 0) {
    return errorResult(failedStatuses[0] ?? 502, {
      note: "No Cloudflare account usage or billing capability was readable",
    });
  }

  return {
    balance: null,
    totalCost,
    fixedCostIncludedUsd,
    costWindowStart:
      totalCost != null ? new Date(monthStartMs) : null,
    costWindowEnd: totalCost != null ? now : null,
    costScope: totalCost != null ? "calendar_month_to_date" : "unknown",
    totalRequests,
    credits: null,
    rawData,
    externalBillingSyncs: billingSyncs.length > 0 ? billingSyncs : undefined,
  };
}
