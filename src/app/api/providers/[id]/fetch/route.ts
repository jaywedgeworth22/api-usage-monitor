import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const usage = await fetchProviderUsage(provider);

    const snapshot = await prisma.usageSnapshot.create({
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

    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
