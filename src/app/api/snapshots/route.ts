import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get("providerId");
  const days = parseInt(searchParams.get("days") || "30", 10);

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
  });

  return NextResponse.json(snapshots);
}
