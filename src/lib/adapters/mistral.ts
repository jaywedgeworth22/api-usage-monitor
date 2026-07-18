import {
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

const ADMIN_BASE_URL = "https://console.mistral.ai/api/admin";
const WORKSPACE_PAGE_SIZE = 100;
const MAX_WORKSPACE_COMPONENTS = 50;
const WORKSPACE_USAGE_CONCURRENCY = 5;

type MistralUsageReport = {
  start_date?: unknown;
  end_date?: unknown;
  currency?: unknown;
  [key: string]: unknown;
};

type MistralWorkspace = {
  uuid?: unknown;
  name?: unknown;
};

type MistralWorkspacePage = {
  items?: unknown;
  total?: unknown;
};

type MistralSpendLimits = {
  limits?: {
    completion?: {
      no_monthly_limit?: unknown;
      monthly_limit_reached?: unknown;
      usage?: unknown;
      total_usage?: unknown;
      usage_limit?: unknown;
      usage_limit_organization?: unknown;
    };
    last_payment_failure?: unknown;
    currency?: unknown;
  };
};

type MistralRateLimits = {
  requests_per_second?: unknown;
  tokens_limits_by_model?: unknown;
};

function parseIsoDate(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

/**
 * The usage endpoint is documented as billing usage, but its published schema
 * currently leaves per-category payloads open-ended and does not define a
 * numeric organization-cost aggregate. Therefore this only accepts its
 * reporting window, never an arbitrary numeric counter as cash. In
 * particular, `/spend-limit` counters are caps/consumption metadata, not USD.
 */
function validateCurrentUtcUsageWindow(
  report: MistralUsageReport,
  now: Date
): { start: string; end: string; currency: string } | null {
  const start = parseIsoDate(report.start_date);
  const end = parseIsoDate(report.end_date);
  const currency = parseCurrency(report.currency);
  if (!start || !end || !currency) return null;

  const expectedStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (startMs !== expectedStart || endMs <= startMs || endMs > nextMonth) {
    return null;
  }

  return { start, end, currency };
}

function normalizeWorkspace(value: unknown): { uuid: string; name: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const workspace = value as MistralWorkspace;
  if (typeof workspace.uuid !== "string" || workspace.uuid.trim() === "") {
    return null;
  }
  return {
    uuid: workspace.uuid.trim(),
    name: typeof workspace.name === "string" && workspace.name.trim()
      ? workspace.name.trim()
      : null,
  };
}

async function listWorkspaces(
  headers: Record<string, string>
): Promise<{
  attempted: boolean;
  complete: boolean;
  workspaces: Array<{ uuid: string; name: string | null }>;
}> {
  let first;
  try {
    first = await fetchJson(
      `${ADMIN_BASE_URL}/workspaces?page=1&page_size=${WORKSPACE_PAGE_SIZE}`,
      { headers }
    );
  } catch {
    return { attempted: true, complete: false, workspaces: [] };
  }
  if (!first.ok) return { attempted: true, complete: false, workspaces: [] };

  const firstPage = (first.data ?? {}) as MistralWorkspacePage;
  if (
    !Array.isArray(firstPage.items) ||
    typeof firstPage.total !== "number" ||
    !Number.isSafeInteger(firstPage.total) ||
    firstPage.total < 0
  ) {
    return { attempted: true, complete: false, workspaces: [] };
  }

  const total = firstPage.total;
  const pages = Math.ceil(total / WORKSPACE_PAGE_SIZE);
  if (pages === 0) return { attempted: true, complete: true, workspaces: [] };

  const items = [...firstPage.items];
  for (let page = 2; page <= pages; page += 1) {
    let response;
    try {
      response = await fetchJson(
        `${ADMIN_BASE_URL}/workspaces?page=${page}&page_size=${WORKSPACE_PAGE_SIZE}`,
        { headers }
      );
    } catch {
      return { attempted: true, complete: false, workspaces: [] };
    }
    const data = (response.data ?? {}) as MistralWorkspacePage;
    if (!response.ok || !Array.isArray(data.items)) {
      return { attempted: true, complete: false, workspaces: [] };
    }
    items.push(...data.items);
  }

  const deduped = new Map<string, { uuid: string; name: string | null }>();
  for (const item of items) {
    const workspace = normalizeWorkspace(item);
    if (!workspace || deduped.has(workspace.uuid)) {
      return { attempted: true, complete: false, workspaces: [] };
    }
    deduped.set(workspace.uuid, workspace);
  }

  return {
    attempted: true,
    complete: deduped.size === total,
    workspaces: [...deduped.values()],
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(WORKSPACE_USAGE_CONCURRENCY, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function fetchWorkspaceUsageRecords(
  workspaces: Array<{ uuid: string; name: string | null }>,
  headers: Record<string, string>,
  now: Date
): Promise<{ records: AdapterExternalBillingRecord[]; complete: boolean }> {
  const bounded = workspaces.slice(0, MAX_WORKSPACE_COMPONENTS);
  const results = await mapWithConcurrency<
    { uuid: string; name: string | null },
    AdapterExternalBillingRecord | null
  >(bounded, async (workspace) => {
    const params = new URLSearchParams({
      month: String(now.getUTCMonth() + 1),
      year: String(now.getUTCFullYear()),
      workspace_id: workspace.uuid,
    });
    let response;
    try {
      response = await fetchJson(`${ADMIN_BASE_URL}/usage?${params}`, { headers });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const report = (response.data ?? {}) as MistralUsageReport;
    const window = validateCurrentUtcUsageWindow(report, now);
    if (!window) return null;

    return {
      externalId: workspace.uuid,
      kind: "billing_period" as const,
      serviceName: workspace.name ? `Mistral workspace: ${workspace.name}` : "Mistral workspace",
      planName: "Mistral workspace billing usage (cash total unavailable)",
      status: "cost_unavailable",
      amountUsd: null,
      currency: window.currency,
      currentPeriodStart: window.start,
      currentPeriodEnd: window.end,
      rollupRole: "component" as const,
      dateKind: "report_through" as const,
    };
  });

  return {
    records: results.filter(
      (record): record is AdapterExternalBillingRecord => record != null
    ),
    complete: bounded.length === workspaces.length && results.every((record) => record != null),
  };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const adminApiKey =
    (config?.adminApiKey as string | undefined)?.trim() || apiKey;
  const headers = { "x-api-key": adminApiKey };
  const now = new Date();
  const params = new URLSearchParams({
    month: String(now.getUTCMonth() + 1),
    year: String(now.getUTCFullYear()),
  });

  const [usageResponse, limitsResponse, rateResponse, workspaceList] = await Promise.all([
    fetchJson(`${ADMIN_BASE_URL}/usage?${params}`, { headers }),
    fetchJson(`${ADMIN_BASE_URL}/spend-limit`, { headers }),
    fetchJson(`${ADMIN_BASE_URL}/rate-limit`, { headers }),
    listWorkspaces(headers),
  ]);

  if (!usageResponse.ok && !limitsResponse.ok && !rateResponse.ok) {
    return errorResult(
      usageResponse.status || limitsResponse.status || rateResponse.status,
      { note: "Mistral billing endpoints require a Backoffice Admin API key" }
    );
  }

  const usage = (usageResponse.data ?? {}) as MistralUsageReport;
  const limits = (limitsResponse.data ?? {}) as MistralSpendLimits;
  const rate = (rateResponse.data ?? {}) as MistralRateLimits;
  const completion = limits.limits?.completion;
  const usageWindow = usageResponse.ok
    ? validateCurrentUtcUsageWindow(usage, now)
    : null;
  const limitsCurrency = parseCurrency(limits.limits?.currency);
  const spendLimitUsd = limitsCurrency === "USD"
    ? parseNumber(completion?.usage_limit) ?? parseNumber(completion?.usage_limit_organization)
    : null;
  const requestLimit = rateResponse.ok ? parseNumber(rate.requests_per_second) : null;
  const status = limits.limits?.last_payment_failure === true
    ? "payment_failed"
    : completion?.monthly_limit_reached === true
      ? "limit_reached"
      : "active";
  const billingSyncs: AdapterExternalBillingSync[] = [];

  // This stable source identity intentionally clears the old false cash value.
  // A valid report lets the UI show its period/currency while stating that the
  // provider has not published a schema-safe numeric organization total.
  if (usageWindow) {
    billingSyncs.push({
      source: "mistral-usage-billing",
      authoritative: true,
      records: [
        {
          externalId: usageWindow.start.slice(0, 7),
          kind: "billing_period",
          planName: "Mistral organization billing usage (cash total unavailable)",
          status: "cost_unavailable",
          amountUsd: null,
          currency: usageWindow.currency,
          currentPeriodStart: usageWindow.start,
          currentPeriodEnd: usageWindow.end,
          rollupRole: "canonical",
          dateKind: "report_through",
        },
      ],
    });
  }
  if (limitsResponse.ok) {
    billingSyncs.push({
      source: "mistral-spend-limits",
      authoritative: true,
      records: [
        {
          externalId: "organization",
          kind: "account",
          planName: "Mistral organization spend limit",
          status: spendLimitUsd == null ? "metadata_unavailable" : status,
          spendLimitUsd,
          spendLimitWindow: completion?.no_monthly_limit === true ? null : "month",
          rollupRole: "metadata",
        },
      ],
    });
  }
  if (requestLimit != null) {
    billingSyncs.push({
      source: "mistral-rate-limits",
      authoritative: true,
      records: [
        {
          externalId: "organization",
          kind: "account",
          planName: "Mistral organization rate limit",
          status: "active",
          requestLimit,
          requestLimitWindow: "second",
          rollupRole: "metadata",
        },
      ],
    });
  }

  if (workspaceList.complete || workspaceList.workspaces.length > 0) {
    const workspaceUsage = await fetchWorkspaceUsageRecords(
      workspaceList.workspaces,
      headers,
      now
    );
    billingSyncs.push({
      source: "mistral-workspace-usage",
      authoritative: workspaceList.complete && workspaceUsage.complete,
      records: workspaceUsage.records,
    });
  }

  return {
    balance: null,
    totalCost: null,
    costWindowStart: null,
    costWindowEnd: null,
    costScope: "unknown",
    costCoverageCaveat: {
      code: "mistral_usage_cash_total_schema_unavailable",
      message: "Mistral's Admin Usage endpoint reports billing usage, but its published schema does not define a numeric organization cash total. Spend-limit counters are shown only as cap metadata, never as cash spend.",
    },
    totalRequests: null,
    credits: null,
    rawData: {
      usage: usageResponse.ok ? usage : null,
      spendLimit: limitsResponse.ok ? limits : null,
      rateLimit: rateResponse.ok ? rate : null,
      workspaceCoverage: {
        attempted: workspaceList.attempted,
        enumerated: workspaceList.workspaces.length,
        complete: workspaceList.complete,
        capped: workspaceList.workspaces.length > MAX_WORKSPACE_COMPONENTS,
      },
      capabilities: {
        actualCost: false,
        usageBreakdown: usageWindow != null,
        spendLimit: spendLimitUsd != null,
        rateLimit: requestLimit != null,
        workspaceUsage: workspaceList.complete,
        credential: "Mistral Backoffice Admin API key",
      },
    },
    externalBillingSyncs: billingSyncs.length > 0 ? billingSyncs : undefined,
  };
}
