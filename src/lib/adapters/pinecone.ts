import { AdapterError, errorResult, fetchJson, type UsageResult } from "./helpers";

interface PineconeIndex {
  name: string;
  host?: string;
  dimension?: number;
  metric?: string;
  status?: { ready?: boolean; state?: string };
  spec?: {
    serverless?: { cloud?: string; region?: string };
    pod?: { environment?: string; pod_type?: string; pods?: number };
  };
}

const PINECONE_API_VERSION = "2026-04";

export function pineconeHeaders(apiKey: string): Record<string, string> {
  return {
    "Api-Key": apiKey,
    "X-Pinecone-Api-Version": PINECONE_API_VERSION,
    "Content-Type": "application/json",
  };
}

export function isAllowedPineconeIndexHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.includes(":") ||
    normalized.includes("/") ||
    normalized.includes("@")
  ) {
    return false;
  }
  const labels = normalized.split(".");
  return (
    labels.length >= 5 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    normalized.endsWith(".pinecone.io") &&
    labels.includes("svc")
  );
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // Fetch list of indexes, then get stats for each
  const indexesRes = await fetchJson("https://api.pinecone.io/indexes", {
    headers: pineconeHeaders(apiKey),
  });

  if (!indexesRes.ok) {
    return errorResult(indexesRes.status);
  }

  const { indexes = [] } = (indexesRes.data ?? {}) as {
    indexes?: PineconeIndex[];
  };
  const rawData: Record<string, unknown> = { indexes };

  let totalVectorCount = 0;
  const stats: unknown[] = [];
  const billingRecords = [];

  for (const idx of indexes) {
    let vectorCount: number | null = null;
    try {
      const host = idx.host;
      if (!host) continue;
      if (!isAllowedPineconeIndexHost(host)) {
        throw new AdapterError(
          "Pinecone returned an index host outside the allowed *.svc.*.pinecone.io domain",
          { code: "UNSAFE_OUTBOUND_URL" }
        );
      }
      const statsRes = await fetchJson(
        `https://${host}/describe_index_stats`,
        {
          headers: pineconeHeaders(apiKey),
          method: "POST",
          body: JSON.stringify({}),
        },
        { security: "untrusted" }
      );

      if (statsRes.ok) {
        const indexStats = statsRes.data as { totalVectorCount?: number };
        stats.push({ name: idx.name, stats: indexStats });
        if (typeof indexStats.totalVectorCount === "number") {
          totalVectorCount += indexStats.totalVectorCount;
          vectorCount = indexStats.totalVectorCount;
        }
      } else {
        stats.push({ name: idx.name, error: `HTTP ${statsRes.status}` });
      }
    } catch (err) {
      stats.push({
        name: idx.name,
        error: err instanceof Error ? err.message : "Unknown",
      });
    }

    const serverless = idx.spec?.serverless;
    const pod = idx.spec?.pod;
    const planName = serverless
      ? ["Serverless", serverless.cloud, serverless.region].filter(Boolean).join(" · ")
      : pod
        ? ["Pod", pod.pod_type, pod.environment].filter(Boolean).join(" · ")
        : "Index";
    billingRecords.push({
      externalId: idx.name,
      kind: "service_plan" as const,
      serviceName: idx.name,
      planName,
      status:
        idx.status?.state ??
        (idx.status?.ready === true ? "ready" : idx.status?.ready === false ? "initializing" : "unknown"),
      usageQuantity: vectorCount,
      usageUnit: "vectors",
      rollupRole: "metadata" as const,
    });
  }

  rawData.stats = stats;

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      ...rawData,
      totalVectorCount,
      capabilities: {
        indexInventory: true,
        vectorCount: true,
        billingCost: false,
        subscriptionStatus: false,
        apiVersion: PINECONE_API_VERSION,
      },
    },
    externalBilling: {
      source: "pinecone-index-inventory",
      authoritative: true,
      records: billingRecords,
    },
  };
}
