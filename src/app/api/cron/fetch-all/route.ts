import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || cronSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = await prisma.provider.findMany({
    where: { isActive: true },
  });

  let successes = 0;
  let failures = 0;

  for (const provider of providers) {
    try {
      const usage = await fetchProviderUsage(provider);
      await prisma.usageSnapshot.create({
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
      successes++;
    } catch {
      failures++;
    }
  }

  return NextResponse.json({
    total: providers.length,
    successes,
    failures,
  });
}
