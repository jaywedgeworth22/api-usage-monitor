import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

type AccountScope = "organization" | "user" | "enterprise";

interface GitHubUsageItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  quantity?: number;
  netQuantity?: number;
  netAmount?: number;
}

interface GitHubBudget {
  id?: string;
  budget_type?: string;
  budget_product_sku?: string;
  budget_product_skus?: unknown;
  budget_scope?: string;
  budget_entity_name?: string;
  budget_amount?: number;
  prevent_further_usage?: boolean;
  budget_alerting?: { will_alert?: boolean; alert_recipients?: unknown };
}

type GitHubResponse = Awaited<ReturnType<typeof fetchJson>>;

interface FetchOutcome {
  response: GitHubResponse | null;
  error: AdapterError | null;
}

interface UsageAggregate {
  product: string;
  sku: string;
  model: string | null;
  unit: string | null;
  quantity: number;
  netAmountUsd: number;
}

interface BudgetOutcome {
  budgets: GitHubBudget[] | null;
  status: number | null;
  error: AdapterError | null;
}

interface OptionalUsageOutcome {
  sync: AdapterExternalBillingSync | null;
  capability: ReturnType<typeof availability>;
}

const GITHUB_API_VERSION = "2026-03-10";
const MAX_BUDGET_PAGES = 100;

function adapterError(error: unknown, message: string): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError(message, {
    code: "TRANSPORT_ERROR",
    retryable: true,
    cause: error,
  });
}

async function get(url: string, headers: HeadersInit): Promise<FetchOutcome> {
  try {
    return { response: await fetchJson(url, { headers }), error: null };
  } catch (error) {
    return { response: null, error: adapterError(error, "GitHub billing request failed") };
  }
}

function configuredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountScope(value: unknown): AccountScope {
  if (value == null || value === "") return "organization";
  if (value === "organization" || value === "user" || value === "enterprise") {
    return value;
  }
  throw new AdapterError("GitHub accountType must be organization, user, or enterprise", {
    code: "CONFIGURATION_ERROR",
  });
}

function accountLogin(config: Record<string, unknown>, scope: AccountScope): string {
  const legacyOrg = configuredString(config.org) ?? configuredString(config.orgSlug);
  const account =
    configuredString(config.account) ??
    (scope === "organization"
      ? legacyOrg
      : scope === "user"
        ? configuredString(config.username) ?? configuredString(config.user) ?? legacyOrg
        : configuredString(config.enterprise) ?? legacyOrg);
  if (account) return account;
  throw new AdapterError(
    `GitHub ${scope} account login or slug is required for billing usage`,
    { code: "CONFIGURATION_ERROR" }
  );
}

function githubApiOrigin(config: Record<string, unknown>): string {
  const configured = configuredString(config.apiOrigin) ?? configuredString(config.apiBaseUrl);
  if (!configured) return "https://api.github.com";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new AdapterError("GitHub apiOrigin must be a valid HTTPS URL", {
      code: "CONFIGURATION_ERROR",
    });
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === "api.github.com" || /^api\.[a-z0-9-]+\.ghe\.com$/.test(host);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !allowed
  ) {
    throw new AdapterError(
      "GitHub apiOrigin must be https://api.github.com or https://api.<enterprise>.ghe.com",
      { code: "CONFIGURATION_ERROR" }
    );
  }
  return url.origin;
}

function billingBase(scope: AccountScope, account: string, apiOrigin: string): string {
  const encoded = encodeURIComponent(account);
  if (scope === "organization") return `${apiOrigin}/organizations/${encoded}/settings/billing`;
  if (scope === "user") return `${apiOrigin}/users/${encoded}/settings/billing`;
  return `${apiOrigin}/enterprises/${encoded}/settings/billing`;
}

function monthParameters(now: Date): URLSearchParams {
  return new URLSearchParams({
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1),
  });
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError(message, { code: "INVALID_RESPONSE" });
  }
  return value as Record<string, unknown>;
}

function usageItems(value: unknown, source: string): GitHubUsageItem[] {
  const object = requireObject(value, `${source} expected a response object`);
  if (!Array.isArray(object.usageItems)) {
    throw new AdapterError(`${source} expected usageItems[]`, { code: "INVALID_RESPONSE" });
  }
  return object.usageItems as GitHubUsageItem[];
}

function aggregateUsageItems(items: GitHubUsageItem[], source: string): UsageAggregate[] {
  const byProduct = new Map<string, UsageAggregate>();
  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new AdapterError(`${source} returned an invalid usage item`, {
        code: "INVALID_RESPONSE",
      });
    }
    const amount = parseNumber(item.netAmount);
    if (amount == null) {
      throw new AdapterError(`${source} usage item omitted netAmount`, {
        code: "INVALID_RESPONSE",
      });
    }
    const product = configuredString(item.product) ?? "unknown";
    const sku = configuredString(item.sku) ?? "unknown";
    const model = configuredString(item.model);
    const key = [product, sku, model ?? ""].join("\u0000");
    const aggregate = byProduct.get(key) ?? {
      product,
      sku,
      model,
      unit: configuredString(item.unitType),
      quantity: 0,
      netAmountUsd: 0,
    };
    aggregate.quantity += parseNumber(item.netQuantity ?? item.quantity) ?? 0;
    aggregate.netAmountUsd += amount;
    byProduct.set(key, aggregate);
  }
  return [...byProduct.values()];
}

function externalUsageRecords(
  account: string,
  month: string,
  title: string,
  aggregates: UsageAggregate[],
  periodStart: Date,
  periodEnd: Date,
  role: "canonical" | "component"
): AdapterExternalBillingRecord[] {
  if (role === "canonical") {
    return [
      {
        externalId: `${account.toLowerCase()}:${month}`,
        kind: "billing_period",
        serviceName: "GitHub",
        planName: title,
        status: "open",
        amountUsd: aggregates.reduce((total, item) => total + item.netAmountUsd, 0),
        currency: "USD",
        currentPeriodStart: periodStart.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        rollupRole: "canonical",
        dateKind: "period_end",
      },
      ...externalUsageRecords(
        account,
        month,
        title,
        aggregates,
        periodStart,
        periodEnd,
        "component"
      ),
    ];
  }
  return aggregates.map((item) => ({
    externalId: `${account.toLowerCase()}:${month}:${item.product}:${item.sku}:${item.model ?? ""}`,
    kind: "billing_period",
    serviceName: item.model ? `${item.product} (${item.model})` : item.product,
    planName: item.sku,
    status: "open",
    amountUsd: item.netAmountUsd,
    currency: "USD",
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
    usageQuantity: item.quantity,
    usageUnit: item.unit,
    rollupRole: "component",
    dateKind: "period_end",
  }));
}

async function fetchAllBudgets(
  base: string,
  headers: HeadersInit
): Promise<BudgetOutcome> {
  const budgets: GitHubBudget[] = [];
  for (let page = 1; page <= MAX_BUDGET_PAGES; page += 1) {
    const params = new URLSearchParams({ page: String(page), per_page: "100" });
    const outcome = await get(`${base}/budgets?${params}`, headers);
    if (!outcome.response?.ok) {
      return {
        budgets: null,
        status: outcome.response?.status ?? outcome.error?.status ?? null,
        error: outcome.error,
      };
    }
    let data: Record<string, unknown>;
    try {
      data = requireObject(outcome.response.data, "GitHub budgets expected a response object");
    } catch (error) {
      return {
        budgets: null,
        status: outcome.response.status,
        error: adapterError(error, "GitHub budgets response is invalid"),
      };
    }
    if (!Array.isArray(data.budgets) || typeof data.has_next_page !== "boolean") {
      return {
        budgets: null,
        status: outcome.response.status,
        error: new AdapterError("GitHub budgets response is invalid", {
          code: "INVALID_RESPONSE",
          status: outcome.response.status,
        }),
      };
    }
    budgets.push(...(data.budgets as GitHubBudget[]));
    if (!data.has_next_page) {
      return { budgets, status: outcome.response.status, error: null };
    }
  }
  return {
    budgets: null,
    status: null,
    error: new AdapterError("GitHub budgets pagination exceeded the safety limit", {
      code: "INVALID_RESPONSE",
    }),
  };
}

function budgetProductSkus(budget: GitHubBudget): string[] {
  const values = Array.isArray(budget.budget_product_skus)
    ? budget.budget_product_skus
    : budget.budget_product_sku == null
      ? []
      : [budget.budget_product_sku];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim())
    .slice(0, 20);
}

function budgetRecords(budgets: GitHubBudget[]): AdapterExternalBillingRecord[] {
  const seenIds = new Set<string>();
  return budgets.map((budget) => {
    const id = configuredString(budget.id);
    if (!id || seenIds.has(id)) {
      throw new AdapterError("GitHub budgets response has an invalid or duplicate budget id", {
        code: "INVALID_RESPONSE",
      });
    }
    seenIds.add(id);
    const type = configuredString(budget.budget_type) ?? "budget";
    const scope = configuredString(budget.budget_scope) ?? "account";
    const skus = budgetProductSkus(budget);
    const amount = parseNumber(budget.budget_amount);
    const licenseBudget = type.toLowerCase().includes("license");
    return {
      externalId: id,
      kind: "account",
      serviceName: `GitHub ${scope} budget`,
      planName: [type, skus.join(", ")].filter(Boolean).join(" · ") || "GitHub budget",
      status: budget.prevent_further_usage === true ? "enforced" : "active",
      currency: licenseBudget ? null : "USD",
      spendLimitUsd: !licenseBudget ? amount : null,
      spendLimitWindow: !licenseBudget && amount != null ? "GitHub budget" : null,
      requestLimit: licenseBudget ? amount : null,
      requestLimitWindow: licenseBudget && amount != null ? "licenses" : null,
      rollupRole: "metadata",
    };
  });
}

function optionalUsageSync(
  source: string,
  account: string,
  month: string,
  title: string,
  outcome: FetchOutcome,
  periodStart: Date,
  periodEnd: Date
): OptionalUsageOutcome {
  const capability = availability(outcome);
  if (!outcome.response?.ok) return { sync: null, capability };
  try {
    const aggregates = aggregateUsageItems(usageItems(outcome.response.data, title), title);
    return {
      sync: {
        source,
        authoritative: true,
        records: externalUsageRecords(
          account,
          month,
          title,
          aggregates,
          periodStart,
          periodEnd,
          "component"
        ),
      },
      capability,
    };
  } catch (error) {
    const adapterFailure = adapterError(error, `${title} response is invalid`);
    return {
      sync: null,
      capability: {
        status: "error",
        httpStatus: outcome.response.status,
        errorCode: adapterFailure.code,
      },
    };
  }
}

function availability(outcome: FetchOutcome): {
  status: "available" | "permission_unavailable" | "not_available" | "upstream_unavailable" | "error";
  httpStatus: number | null;
  errorCode: string | null;
} {
  if (outcome.response?.ok) return { status: "available", httpStatus: outcome.response.status, errorCode: null };
  const status = outcome.response?.status ?? outcome.error?.status ?? null;
  return {
    status:
      status === 403 ? "permission_unavailable" :
      status === 404 ? "not_available" :
      status != null && status >= 500 ? "upstream_unavailable" : "error",
    httpStatus: status,
    errorCode: outcome.error?.code ?? (status == null ? "TRANSPORT_ERROR" : "HTTP_ERROR"),
  };
}

/**
 * GitHub's enhanced-billing summary is the canonical net-cost surface. The
 * AI-credit and premium-request APIs are more detailed Copilot breakdowns of
 * billed/included consumption, so they are written as component rows in their
 * own sources and never summed into totalCost a second time.
 */
export async function fetchUsage(
  apiKey: string,
  config: Record<string, unknown> = {}
): Promise<UsageResult> {
  const scope = accountScope(config.accountType);
  const account = accountLogin(config, scope);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = monthStart.toISOString().slice(0, 7);
  const params = monthParameters(now);
  const base = billingBase(scope, account, githubApiOrigin(config));
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${apiKey}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "api-usage-monitor/1.0",
  };

  // Summary is GitHub's documented aggregated account-wide paid-product
  // surface. The older detailed report is a compatibility fallback only; its
  // per-repository fields are deliberately never persisted.
  const summaryOutcome = await get(`${base}/usage/summary?${params}`, headers);
  let primaryOutcome = summaryOutcome;
  let primarySource = "summary";
  if (!summaryOutcome.response?.ok) {
    primaryOutcome = await get(`${base}/usage?${params}`, headers);
    primarySource = "detailed_report_fallback";
  }
  if (!primaryOutcome.response?.ok) {
    return errorResult(
      primaryOutcome.response?.status ?? summaryOutcome.response?.status ?? primaryOutcome.error?.status ?? summaryOutcome.error?.status ?? 0,
      {
        note: `GitHub ${scope} enhanced billing usage is unavailable. The token needs the documented billing permission and the account may need the enhanced billing platform.`,
      }
    );
  }

  const [budgetOutcome, aiCreditOutcome, premiumRequestOutcome] = await Promise.all([
    scope === "user" ? Promise.resolve<BudgetOutcome | null>(null) : fetchAllBudgets(base, headers),
    get(`${base}/ai_credit/usage?${params}`, headers),
    get(`${base}/premium_request/usage?${params}`, headers),
  ]);
  const aggregates = aggregateUsageItems(
    usageItems(primaryOutcome.response.data, "GitHub billing usage"),
    "GitHub billing usage"
  );
  const totalCost = aggregates.reduce((total, item) => total + item.netAmountUsd, 0);
  const usageSync: AdapterExternalBillingSync = {
    // Preserve the established source name so existing canonical usage rows
    // are updated in place instead of briefly coexisting with a renamed
    // source after this adapter is deployed.
    source: "github-enhanced-billing",
    authoritative: true,
    records: externalUsageRecords(
      account,
      month,
      "Enhanced billing usage total",
      aggregates,
      monthStart,
      monthEnd,
      "canonical"
    ),
  };
  const aiCredit = optionalUsageSync(
    "github-enhanced-billing-ai-credits",
    account,
    month,
    "Copilot AI credit usage",
    aiCreditOutcome,
    monthStart,
    monthEnd
  );
  const premiumRequest = optionalUsageSync(
    "github-enhanced-billing-premium-requests",
    account,
    month,
    "Copilot premium request usage",
    premiumRequestOutcome,
    monthStart,
    monthEnd
  );
  // Budget inventory is useful but independent from canonical cash usage. A
  // malformed optional budget record must not turn a valid usage summary into
  // an error or discard its current-month cash total.
  const budgetState = scope === "user"
    ? {
        sync: null,
        capability: {
          status: "not_exposed",
          httpStatus: null,
          note: "GitHub documents budget listing for organizations and enterprises, not personal user accounts.",
        },
      }
    : budgetOutcome?.budgets
      ? (() => {
          try {
            return {
              sync: {
                source: "github-enhanced-billing-budgets",
                authoritative: true,
                records: budgetRecords(budgetOutcome.budgets),
              } satisfies AdapterExternalBillingSync,
              capability: {
                status: "available",
                httpStatus: budgetOutcome.status,
                count: budgetOutcome.budgets.length,
              },
            };
          } catch (error) {
            const adapterFailure = adapterError(error, "GitHub budgets response is invalid");
            return {
              sync: null,
              capability: {
                status: "error",
                httpStatus: budgetOutcome.status,
                errorCode: adapterFailure.code,
              },
            };
          }
        })()
      : {
          sync: null,
          capability: {
            status:
              budgetOutcome?.status === 403 ? "permission_unavailable" :
              budgetOutcome?.status === 404 ? "not_available" :
              budgetOutcome?.status != null && budgetOutcome.status >= 500 ? "upstream_unavailable" : "error",
            httpStatus: budgetOutcome?.status ?? null,
            errorCode: budgetOutcome?.error?.code ?? (budgetOutcome?.status == null ? "TRANSPORT_ERROR" : "HTTP_ERROR"),
          },
        };

  return {
    balance: null,
    totalCost,
    costWindowStart: monthStart,
    costWindowEnd: now,
    costScope: "calendar_month_to_date",
    totalRequests: null,
    credits: null,
    rawData: {
      account: { scope, login: account },
      month,
      billing: {
        source: primarySource,
        itemCount: aggregates.length,
        actualBilledUsage: true,
        planSubscriptionStatus: "not_exposed_by_github_billing_rest_api",
        renewalDate: "not_exposed_by_github_billing_rest_api",
        paymentMethod: "not_exposed_by_github_billing_rest_api",
      },
      capabilities: {
        enhancedBillingUsage: availability(primaryOutcome),
        usageSummary: availability(summaryOutcome),
        budgets: budgetState.capability,
        aiCredits: aiCredit.capability,
        premiumRequests: premiumRequest.capability,
        planSubscription: "not_exposed",
        renewalDate: "not_exposed",
        paymentMethod: "not_exposed",
      },
      // Never retain repository names, user names, budget alert recipients,
      // or any token-derived identity beyond the configured account boundary.
      usageByProduct: aggregates.map((item) => ({
        product: item.product,
        sku: item.sku,
        model: item.model,
        unit: item.unit,
        quantity: item.quantity,
        netAmountUsd: item.netAmountUsd,
      })),
    },
    externalBillingSyncs: [usageSync, budgetState.sync, aiCredit.sync, premiumRequest.sync].filter(
      (sync): sync is AdapterExternalBillingSync => sync != null
    ),
  };
}
