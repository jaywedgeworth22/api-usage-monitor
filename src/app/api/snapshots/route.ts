import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get("providerId");
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 365)
    : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);

  const where: Record<string, unknown> = {
    fetchedAt: { gte: since },
  };

  if (providerId) {
    where.providerId = providerId;
  }

  const snapshots = await prisma.usageSnapshot.findMany({
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
  });

  return NextResponse.json(snapshots);
}
