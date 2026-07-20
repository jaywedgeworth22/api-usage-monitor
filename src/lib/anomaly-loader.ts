import { prisma } from "@/lib/prisma";
import {
  type AnomalyConfig,
  type AnomalyResult,
  dailyIncrementsFromCumulative,
  detectSeriesAnomaly,
  resolveAnomalyConfig,
} from "@/lib/anomaly-detection";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Hard cap on scanned scalar rows; keeps this memory-light on the hot budget
// path even for high-frequency pollers (only 4 scalar columns are selected —
// never the rawData blob that caused the #392 OOM).
const MAX_SNAPSHOT_ROWS = 20_000;

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface SnapshotScalarRow {
  providerId: string;
  fetchedAt: Date;
  totalCost: number | null;
  totalRequests: number | null;
}

interface DayPeak {
  cost: number | null;
  requests: number | null;
}

/**
 * Build per-provider daily incremental cost & request series from raw poll
 * snapshots and run the detector on the latest day of each.
 *
 * Poll snapshots carry a CUMULATIVE month-to-date `totalCost` / `totalRequests`
 * sampled every refresh interval. We collapse them to one cumulative peak per
 * (provider, UTC day) and difference them into per-day increments (see
 * `dailyIncrementsFromCumulative`, which resets at month boundaries and clamps
 * corrections). The detector then compares the most recent day against a robust
 * baseline of the preceding days.
 *
 * Returns providerId → anomalies (cost and/or requests). Providers with too
 * little history simply produce no entry. Disabled config returns an empty map.
 */
export async function loadSpendAnomaliesByProviderId(
  now: Date = new Date(),
  config: AnomalyConfig = resolveAnomalyConfig()
): Promise<Map<string, AnomalyResult[]>> {
  const results = new Map<string, AnomalyResult[]>();
  if (!config.enabled) return results;

  // +2 days of slack: one so the earliest kept day still has a prior day to
  // diff against, one so "today" (the observed point) sits on a full baseline.
  const windowStart = new Date(now.getTime() - (config.windowDays + 2) * MS_PER_DAY);

  const rows = (await prisma.usageSnapshot.findMany({
    where: { fetchedAt: { gte: windowStart, lte: now } },
    orderBy: { fetchedAt: "desc" },
    take: MAX_SNAPSHOT_ROWS,
    select: { providerId: true, fetchedAt: true, totalCost: true, totalRequests: true },
  })) as SnapshotScalarRow[];

  const byProvider = new Map<string, Map<string, DayPeak>>();
  for (const row of rows) {
    const day = utcDayKey(row.fetchedAt);
    let days = byProvider.get(row.providerId);
    if (!days) {
      days = new Map();
      byProvider.set(row.providerId, days);
    }
    const peak = days.get(day) ?? { cost: null, requests: null };
    if (row.totalCost != null) peak.cost = Math.max(peak.cost ?? row.totalCost, row.totalCost);
    if (row.totalRequests != null) {
      peak.requests = Math.max(peak.requests ?? row.totalRequests, row.totalRequests);
    }
    days.set(day, peak);
  }

  for (const [providerId, days] of byProvider) {
    const dayKeys = [...days.keys()].sort();
    const anomalies: AnomalyResult[] = [];

    const costCumulative = dayKeys
      .filter((day) => days.get(day)?.cost != null)
      .map((day) => ({ day, cumulative: days.get(day)!.cost as number }));
    if (costCumulative.length >= 2) {
      const anomaly = detectSeriesAnomaly(
        dailyIncrementsFromCumulative(costCumulative),
        "cost",
        config
      );
      if (anomaly) anomalies.push({ ...anomaly, providerId });
    }

    const reqCumulative = dayKeys
      .filter((day) => days.get(day)?.requests != null)
      .map((day) => ({ day, cumulative: days.get(day)!.requests as number }));
    if (reqCumulative.length >= 2) {
      const anomaly = detectSeriesAnomaly(
        dailyIncrementsFromCumulative(reqCumulative),
        "requests",
        config
      );
      if (anomaly) anomalies.push({ ...anomaly, providerId });
    }

    if (anomalies.length > 0) results.set(providerId, anomalies);
  }

  return results;
}
