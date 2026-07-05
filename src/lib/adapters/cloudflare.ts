import { resilientFetch, type UsageResult } from "./helpers";

function makeHeaders(
  apiKey: string,
  accountEmail?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (accountEmail) headers["X-Auth-Email"] = accountEmail;
  return headers;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const accountId = config?.accountId as string | undefined;

  if (!accountId) {
    return {
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      rawData: { error: "accountId is required in config" },
    };
  }

  const accountEmail = config?.accountEmail as string | undefined;
  const headers = makeHeaders(apiKey, accountEmail);
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const rawData: Record<string, unknown> = {};

  let totalRequests: number | null = null;
  let totalCost: number | null = null;

  // 1. Analytics dashboard (general stats)
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const analyticsParams = new URLSearchParams({
    since: thirtyDaysAgo.toISOString(),
    until: now.toISOString(),
    continuous: "true",
  });

  try {
    const analyticsRes = await resilientFetch(
      `${baseUrl}/analytics/dashboard?${analyticsParams}`,
      { headers }
    );
    if (analyticsRes.ok) {
      const analytics = await analyticsRes.json();
      rawData.analytics = analytics;
      if (analytics.result?.totals?.requests != null) {
        totalRequests = analytics.result.totals.requests;
      }
      if (analytics.result?.totals?.bandwidth != null) {
        rawData.totalBandwidth_bytes = analytics.result.totals.bandwidth;
      }
    } else {
      rawData.analyticsError = `HTTP ${analyticsRes.status}`;
    }
  } catch (err) {
    rawData.analyticsError = err instanceof Error ? err.message : "Failed";
  }

  // 2. Workers analytics
  try {
    const workersRes = await resilientFetch(
      `${baseUrl}/workers/analytics/dashboard?${analyticsParams}`,
      { headers }
    );
    if (workersRes.ok) {
      const workersData = await workersRes.json();
      rawData.workers = workersData;
      if (workersData.result?.totals?.requests != null) {
        totalRequests =
          (totalRequests ?? 0) + workersData.result.totals.requests;
      }
    } else {
      rawData.workersError = `HTTP ${workersRes.status}`;
    }
  } catch (err) {
    rawData.workersError = err instanceof Error ? err.message : "Failed";
  }

  // 3. D1 database metrics
  const databaseId = config?.databaseId as string | undefined;
  if (databaseId) {
    try {
      const d1Res = await resilientFetch(`${baseUrl}/d1/database/${databaseId}`, {
        headers,
      });
      if (d1Res.ok) {
        rawData.d1 = await d1Res.json();
      }
    } catch {
      // best effort
    }
  }

  // 4. R2 storage bytes
  const r2BucketName = config?.r2BucketName as string | undefined;
  if (r2BucketName) {
    try {
      const r2Res = await resilientFetch(
        `${baseUrl}/r2/buckets/${r2BucketName}`,
        { headers }
      );
      if (r2Res.ok) {
        rawData.r2 = await r2Res.json();
      }
    } catch {
      // best effort
    }
  }

  // 5. KV namespace
  const kvNamespaceId = config?.kvNamespaceId as string | undefined;
  if (kvNamespaceId) {
    try {
      const kvRes = await resilientFetch(
        `${baseUrl}/storage/kv/namespaces/${kvNamespaceId}`,
        { headers }
      );
      if (kvRes.ok) {
        rawData.kv = await kvRes.json();
      }
    } catch {
      // best effort
    }
  }

  // 6. Queue message counts
  const queueId = config?.queueId as string | undefined;
  if (queueId) {
    try {
      const queueRes = await resilientFetch(`${baseUrl}/queues/${queueId}`, {
        headers,
      });
      if (queueRes.ok) {
        rawData.queue = await queueRes.json();
      }
    } catch {
      // best effort
    }
  }

  return {
    balance: null,
    totalCost,
    totalRequests,
    credits: null,
    rawData,
  };
}
