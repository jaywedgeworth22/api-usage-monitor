import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";
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

export async function fetchAllDueProviders(): Promise<{
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  errors: Array<{ providerId: string; name: string; error: string }>;
}> {
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
}

const POLL_INTERVAL_MS = 15 * 60 * 1000; // matches the old external cron's */15 schedule exactly - don't change the cadence, only where it runs
let schedulerStarted = false;

export function startUsagePollingScheduler(): void {
  if (schedulerStarted) return; // instrumentation.register() can fire more than once in some Next.js scenarios - guard against double-scheduling
  schedulerStarted = true;
  const tick = async () => {
    try {
      await fetchAllDueProviders();
    } catch (error) {
      console.error("[usage-scheduler] tick failed", error);
    }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  void tick(); // also run once immediately on boot, don't wait a full interval
}
