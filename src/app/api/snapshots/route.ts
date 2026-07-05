import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSnapshotRawCutoff } from "@/lib/data-retention";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get("providerId");
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 365)
    : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const rawCutoff = getSnapshotRawCutoff();
  const rawSince = since > rawCutoff ? since : rawCutoff;

  const where: Record<string, unknown> = {
    fetchedAt: { gte: rawSince },
  };

  if (providerId) {
    where.providerId = providerId;
  }

  const rollupWhere: Record<string, unknown> = {
    day:
      since < rawCutoff
        ? {
            gte: new Date(
              Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
            ),
            lt: rawCutoff,
          }
        : undefined,
  };
  if (providerId) {
    rollupWhere.providerId = providerId;
  }

  const [snapshots, rollups] = await Promise.all([
    prisma.usageSnapshot.findMany({
      where,
      orderBy: { fetchedAt: "asc" },
      select: {
        id: true,
        providerId: true,
        fetchedAt: true,
        balance: true,
        totalCost: true,
        totalRequests: true,
        credits: true,
        createdAt: true,
      },
    }),
    rollupWhere.day
      ? prisma.usageSnapshotDailyRollup.findMany({
          where: rollupWhere,
          orderBy: { day: "asc" },
          select: {
            id: true,
            providerId: true,
            lastFetchedAt: true,
            latestBalance: true,
            latestTotalCost: true,
            latestTotalRequests: true,
            latestCredits: true,
            updatedAt: true,
            sampleCount: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const rollupSnapshots = rollups.map((rollup) => ({
    id: `rollup:${rollup.id}`,
    providerId: rollup.providerId,
    fetchedAt: rollup.lastFetchedAt,
    balance: rollup.latestBalance,
    totalCost: rollup.latestTotalCost,
    totalRequests: rollup.latestTotalRequests,
    credits: rollup.latestCredits,
    createdAt: rollup.updatedAt,
    rollup: true,
    sampleCount: rollup.sampleCount,
  }));

  return NextResponse.json(
    [...snapshots, ...rollupSnapshots].sort(
      (left, right) => left.fetchedAt.getTime() - right.fetchedAt.getTime()
    )
  );
}
