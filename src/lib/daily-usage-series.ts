import { prisma } from "@/lib/prisma";
import { isClaudeCodeAnalyticsTelemetry } from "@/lib/external-usage-events";
import { isReceiptCashEvent } from "@/lib/receipt-cash";
import { canonicalProviderKey } from "@/lib/provider-identity";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Bound memory on the hot budget path (4 scalar fields only). */
const MAX_EVENT_ROWS = 50_000;
const STATUS_METRIC_TYPES = ["quota_sync", "credit_balance"] as const;
const SUBSCRIPTION_METRIC_TYPE = "subscription";

function utcDayIndex(date: Date, monthStart: Date): number {
  return Math.floor((date.getTime() - monthStart.getTime()) / MS_PER_DAY);
}

/**
 * Wave J / E11: month-to-date *variable usage* daily series keyed by
 * canonical provider name (lowercase). Excludes subscription charges,
 * prepaid receipt cash, Claude Code API-equivalent estimates, and status
 * metrics — matching the cash-spend basis used by budget-status.
 *
 * Returns dense arrays from day 1 of the UTC month through `now`'s UTC day
 * (missing days are 0) so `forecastMonthlyUsageFromSeries` can fit a trend.
 */
export async function loadMtdDailyVariableUsageByProviderName(
  monthStart: Date,
  now: Date,
  options?: { maxRows?: number }
): Promise<Map<string, number[]>> {
  const dayCount = Math.max(1, utcDayIndex(now, monthStart) + 1);
  const maxRows = Math.min(
    Math.max(options?.maxRows ?? MAX_EVENT_ROWS, 1_000),
    100_000
  );

  const rows = await prisma.externalUsageEvent.findMany({
    where: {
      occurredAt: { gte: monthStart, lte: now },
      costUsd: { not: null },
      metricType: { notIn: [...STATUS_METRIC_TYPES] },
    },
    select: {
      provider: true,
      sourceApp: true,
      service: true,
      label: true,
      metricType: true,
      billingMode: true,
      costUsd: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: "asc" },
    take: maxRows,
  });

  const byProvider = new Map<string, number[]>();

  for (const row of rows) {
    if (row.costUsd == null || !(row.costUsd > 0)) continue;
    if (row.metricType === SUBSCRIPTION_METRIC_TYPE) continue;
    if (isClaudeCodeAnalyticsTelemetry(row)) continue;
    if (
      isReceiptCashEvent({
        sourceApp: row.sourceApp,
        service: row.service,
        label: row.label,
        metricType: row.metricType,
        billingMode: row.billingMode,
      })
    ) {
      continue;
    }

    const day = utcDayIndex(row.occurredAt, monthStart);
    if (day < 0 || day >= dayCount) continue;

    const key = canonicalProviderKey(row.provider) || row.provider.toLowerCase();
    let series = byProvider.get(key);
    if (!series) {
      series = Array.from({ length: dayCount }, () => 0);
      byProvider.set(key, series);
    }
    series[day] = (series[day] ?? 0) + row.costUsd;
  }

  return byProvider;
}

/**
 * Build a dense day-1..today series from cumulative poll-snapshot peaks
 * (same peak-per-day + difference approach as anomaly-loader).
 */
export function dailyIncrementsFromSnapshotPeaks(
  dayPeaks: ReadonlyMap<string, number>,
  monthStart: Date,
  now: Date
): number[] {
  const dayCount = Math.max(1, utcDayIndex(now, monthStart) + 1);
  const cumulative: number[] = Array.from({ length: dayCount }, () => 0);
  for (const [dayKey, peak] of dayPeaks) {
    const dayDate = new Date(`${dayKey}T00:00:00.000Z`);
    if (Number.isNaN(dayDate.getTime())) continue;
    const idx = utcDayIndex(dayDate, monthStart);
    if (idx < 0 || idx >= dayCount) continue;
    cumulative[idx] = Math.max(cumulative[idx] ?? 0, peak);
  }
  // Forward-fill cumulative peaks within the month (polls may skip days).
  for (let i = 1; i < dayCount; i++) {
    cumulative[i] = Math.max(cumulative[i] ?? 0, cumulative[i - 1] ?? 0);
  }
  const increments = Array.from({ length: dayCount }, () => 0);
  for (let i = 0; i < dayCount; i++) {
    const prev = i === 0 ? 0 : (cumulative[i - 1] ?? 0);
    const curr = cumulative[i] ?? 0;
    // Month-to-date totals can drop on correction; clamp to zero for forecast.
    increments[i] = Math.max(0, curr - prev);
  }
  return increments;
}

/** Element-wise max of two same-length daily series (or the non-null one). */
export function maxDailySeries(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined
): number[] | null {
  if ((!a || a.length === 0) && (!b || b.length === 0)) return null;
  if (!a || a.length === 0) return [...(b as number[])];
  if (!b || b.length === 0) return [...a];
  const len = Math.max(a.length, b.length);
  const out = Array.from({ length: len }, () => 0);
  for (let i = 0; i < len; i++) {
    out[i] = Math.max(a[i] ?? 0, b[i] ?? 0);
  }
  return out;
}
