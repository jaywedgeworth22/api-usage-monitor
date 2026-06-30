import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordProviderUsage } from "@/lib/usage-recorder";

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || cronSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  return NextResponse.json({
    total: providers.length,
    successes,
    failures,
    skipped,
    errors,
  });
}
