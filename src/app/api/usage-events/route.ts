import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  classifyCostCoverage,
  summarizeExternalUsageEvents,
} from "@/lib/external-usage-events";
import { getExternalEventRawCutoff } from "@/lib/data-retention";
import { resolveProviderIdentity } from "@/lib/provider-identity";

export const dynamic = "force-dynamic";

const MAX_RAW_LIMIT = 200;
const DEFAULT_RAW_LIMIT = 50;

/**
 * GET /api/usage-events
 *
 * Summary mode (default): grouped MTD-style rollup for the dashboard.
 * Raw mode (`?raw=1`): cursor-paginated individual events with deterministic
 * orderBy (Wave K / E15) — never unbounded.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 365)
    : 30;
  const projectFilter = searchParams.get("projectId");
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rawMode =
    searchParams.get("raw") === "1" ||
    searchParams.get("raw") === "true" ||
    searchParams.get("mode") === "raw";

  if (rawMode) {
    const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_RAW_LIMIT);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_RAW_LIMIT)
      : DEFAULT_RAW_LIMIT;
    const cursor = searchParams.get("cursor");
    // order=asc|desc — default newest first for operator debugging.
    const order =
      searchParams.get("order") === "asc" ? ("asc" as const) : ("desc" as const);

    const where = {
      occurredAt: { gte: since },
      ...(projectFilter
        ? projectFilter === "none"
          ? { projectId: null }
          : { projectId: projectFilter }
        : {}),
    };

    const rows = await prisma.externalUsageEvent.findMany({
      where,
      // Wave K / E15: stable composite order (occurredAt, id) so cursor pages
      // never skip/dup under concurrent inserts.
      orderBy: [{ occurredAt: order }, { id: order }],
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        sourceApp: true,
        provider: true,
        service: true,
        projectId: true,
        metricType: true,
        costUsd: true,
        requests: true,
        billingMode: true,
        confidence: true,
        verificationStatus: true,
        occurredAt: true,
        idempotencyKey: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;

    return NextResponse.json({
      mode: "raw",
      days,
      limit,
      order,
      nextCursor,
      hasMore,
      events: page,
    });
  }

  const [summary, projects, providers] = await Promise.all([
    summarizeExternalUsageEvents(since, getExternalEventRawCutoff()),
    prisma.project.findMany({ select: { id: true, name: true } }),
    prisma.provider.findMany({
      select: { id: true, name: true, displayName: true },
    }),
  ]);

  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  let groups = summary.groups.map((group) => {
    const matchedProvider = resolveProviderIdentity(group.provider, providers);
    return {
      ...group,
      projectName: group.projectId
        ? projectNameById.get(group.projectId) ?? null
        : null,
      matchedProvider: matchedProvider
        ? {
            id: matchedProvider.id,
            name: matchedProvider.name,
            displayName: matchedProvider.displayName,
          }
        : null,
    };
  });

  if (projectFilter) {
    groups =
      projectFilter === "none"
        ? groups.filter((group) => group.projectId == null)
        : groups.filter((group) => group.projectId === projectFilter);
  }

  const costCounts = groups.reduce(
    (totals, group) => ({
      pricedEventCount: totals.pricedEventCount + group.pricedEventCount,
      unpricedEventCount: totals.unpricedEventCount + group.unpricedEventCount,
      unclassifiedCostEventCount:
        totals.unclassifiedCostEventCount + group.unclassifiedCostEventCount,
    }),
    { pricedEventCount: 0, unpricedEventCount: 0, unclassifiedCostEventCount: 0 }
  );

  return NextResponse.json({
    mode: "summary",
    days,
    totalCostUsd: groups.reduce((sum, group) => sum + group.totalCostUsd, 0),
    receiptCashPaidUsd: groups.reduce(
      (sum, group) => sum + group.receiptCashPaidUsd,
      0
    ),
    estimatedApiEquivalentUsd: groups.reduce(
      (sum, group) => sum + group.estimatedApiEquivalentUsd,
      0
    ),
    ...costCounts,
    costCoverage: classifyCostCoverage(costCounts),
    totalRequests: groups.reduce((sum, group) => sum + group.totalRequests, 0),
    eventCount: groups.reduce((sum, group) => sum + group.eventCount, 0),
    groups,
  });
}
