import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";
import { runUsageMaintenance } from "@/lib/usage-maintenance";
import type { Provider, UsageSnapshot } from "@prisma/client";

export async function recordProviderUsage(
  provider: Provider
): Promise<UsageSnapshot> {
  const usage = await fetchProviderUsage(provider);

  return prisma.usageSnapshot.create({
    data: {
      providerId: provider.id,
      fetchedAt: new Date(),
      balance: usage.balance,
      totalCost: usage.totalCost,
      totalRequests: usage.totalRequests,
      credits: usage.credits,
      rawData: usage.rawData ?? undefined,
    },
  });
}

// Guards fetchAllDueProviders against concurrent callers (scheduler tick vs a
// manual /api/cron/fetch-all trigger, or two overlapping manual triggers)
// both treating the same provider as "due" and firing duplicate fetches.
// This app runs as a single Node process against a local SQLite file, so a
// simple in-process mutex is sufficient - there is no multi-instance/
// multi-process deployment for this service to coordinate across.
let fetchAllInFlight: Promise<{
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  errors: Array<{ providerId: string; name: string; error: string }>;
}> | null = null;

export async function fetchAllDueProviders(): Promise<{
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  errors: Array<{ providerId: string; name: string; error: string }>;
}> {
  // If a run is already in progress, wait for it and return its result
  // instead of starting a second, overlapping pass over the same providers.
  if (fetchAllInFlight) {
    return fetchAllInFlight;
  }

  const run = (async () => {
    const providers = await prisma.provider.findMany({
      where: { isActive: true },
      include: {
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { fetchedAt: true },
        },
      },
    });

    let successes = 0;
    let failures = 0;
    let skipped = 0;
    const errors: Array<{ providerId: string; name: string; error: string }> = [];
    const now = Date.now();

    for (const { snapshots, ...provider } of providers) {
      const latestFetchedAt = snapshots[0]?.fetchedAt.getTime();
      const intervalMs = provider.refreshIntervalMin * 60 * 1000;
      if (latestFetchedAt && now - latestFetchedAt < intervalMs) {
        skipped++;
        continue;
      }

      try {
        await recordProviderUsage(provider);
        successes++;
      } catch (error) {
        failures++;
        errors.push({
          providerId: provider.id,
          name: provider.name,
          error: error instanceof Error ? error.message : "Failed to fetch",
        });
      }
    }

    return {
      total: providers.length,
      successes,
      failures,
      skipped,
      errors,
    };
  })();

  fetchAllInFlight = run;
  try {
    return await run;
  } finally {
    // Only clear the in-flight marker if it's still our own run - avoids a
    // pathological case where a later run somehow got assigned first.
    if (fetchAllInFlight === run) {
      fetchAllInFlight = null;
    }
  }
}

const POLL_INTERVAL_MS = 15 * 60 * 1000; // matches the old external cron's */15 schedule exactly - don't change the cadence, only where it runs
let schedulerStarted = false;

export function startUsagePollingScheduler(): void {
  if (schedulerStarted) return; // instrumentation.register() can fire more than once in some Next.js scenarios - guard against double-scheduling
  schedulerStarted = true;
  const tick = async () => {
    try {
      await fetchAllDueProviders();
      await runUsageMaintenance();
    } catch (error) {
      console.error("[usage-scheduler] tick failed", error);
    }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  void tick(); // also run once immediately on boot, don't wait a full interval
}
