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
