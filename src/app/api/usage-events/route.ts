import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  classifyCostCoverage,
  summarizeExternalUsageEvents,
} from "@/lib/external-usage-events";
import { getExternalEventRawCutoff } from "@/lib/data-retention";
import { resolveProviderIdentity } from "@/lib/provider-identity";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 365)
    : 30;
  // Optional per-project filter: `?projectId=<id>` narrows to one project, and
  // `?projectId=none` narrows to unattributed usage.
  const projectFilter = searchParams.get("projectId");
  const since = new Date();
  since.setDate(since.getDate() - days);

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
    days,
    totalCostUsd: groups.reduce((sum, group) => sum + group.totalCostUsd, 0),
    ...costCounts,
    costCoverage: classifyCostCoverage(costCounts),
    totalRequests: groups.reduce((sum, group) => sum + group.totalRequests, 0),
    eventCount: groups.reduce((sum, group) => sum + group.eventCount, 0),
    groups,
  });
}
