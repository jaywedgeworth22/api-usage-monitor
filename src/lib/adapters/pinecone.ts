import type { UsageResult } from "./openai";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // Fetch list of indexes, then get stats for each
  const indexesRes = await fetch("https://api.pinecone.io/indexes", {
    headers: {
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!indexesRes.ok) {
    return {
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      rawData: { error: `HTTP ${indexesRes.status}`, status: indexesRes.status },
    };
  }

  const { indexes = [] } = await indexesRes.json();
  const rawData: Record<string, unknown> = { indexes };

  let totalVectorCount = 0;
  const stats: unknown[] = [];

  for (const idx of indexes) {
    try {
      const host = idx.host;
      if (!host) continue;
      const statsRes = await fetch(`https://${host}/describe_index_stats`, {
        headers: {
          "Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({}),
      });

      if (statsRes.ok) {
        const indexStats = await statsRes.json();
        stats.push({ name: idx.name, stats: indexStats });
        if (typeof indexStats.totalVectorCount === "number") {
          totalVectorCount += indexStats.totalVectorCount;
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
  }

  rawData.stats = stats;

  return {
    balance: null,
    totalCost: null,
    totalRequests: totalVectorCount,
    credits: null,
    rawData,
  };
}
