import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface UsageEventGroup {
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  eventCount: number;
  totalCostUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 365)
    : 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const events = await prisma.externalUsageEvent.findMany({
    where: { occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
    take: 5000,
    select: {
      sourceApp: true,
      environment: true,
      provider: true,
      service: true,
      quantity: true,
      costUsd: true,
      requests: true,
      limit: true,
      limitWindow: true,
      occurredAt: true,
    },
  });

  const groups = new Map<string, UsageEventGroup>();
  for (const event of events) {
    const key = [
      event.sourceApp,
      event.environment ?? "",
      event.provider,
      event.service ?? "",
    ].join("|");
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        sourceApp: event.sourceApp,
        environment: event.environment,
        provider: event.provider,
        service: event.service,
        eventCount: 1,
        totalCostUsd: event.costUsd ?? 0,
        totalRequests: event.requests ?? 0,
        totalQuantity: event.quantity ?? 0,
        limit: event.limit,
        limitWindow: event.limitWindow,
        latestAt: event.occurredAt.toISOString(),
      });
      continue;
    }
    existing.eventCount += 1;
    existing.totalCostUsd += event.costUsd ?? 0;
    existing.totalRequests += event.requests ?? 0;
    existing.totalQuantity += event.quantity ?? 0;
    existing.limit = existing.limit ?? event.limit;
    existing.limitWindow = existing.limitWindow ?? event.limitWindow;
    if (event.occurredAt.toISOString() > existing.latestAt) {
      existing.latestAt = event.occurredAt.toISOString();
    }
  }

  const summaries = Array.from(groups.values()).sort(
    (a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt)
  );

  return NextResponse.json({
    days,
    totalCostUsd: summaries.reduce((sum, group) => sum + group.totalCostUsd, 0),
    totalRequests: summaries.reduce((sum, group) => sum + group.totalRequests, 0),
    eventCount: events.length,
    groups: summaries,
  });
}
