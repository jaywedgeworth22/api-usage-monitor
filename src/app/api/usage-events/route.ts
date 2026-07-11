import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { summarizeExternalUsageEvents } from "@/lib/external-usage-events";
import { getExternalEventRawCutoff } from "@/lib/data-retention";

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

  const [summary, projects] = await Promise.all([
    summarizeExternalUsageEvents(since, getExternalEventRawCutoff()),
    prisma.project.findMany({ select: { id: true, name: true } }),
  ]);

  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  let groups = summary.groups.map((group) => ({
    ...group,
    projectName: group.projectId ? projectNameById.get(group.projectId) ?? null : null,
  }));

  if (projectFilter) {
    groups =
      projectFilter === "none"
        ? groups.filter((group) => group.projectId == null)
        : groups.filter((group) => group.projectId === projectFilter);
  }

  return NextResponse.json({
    days,
    totalCostUsd: groups.reduce((sum, group) => sum + group.totalCostUsd, 0),
    totalRequests: groups.reduce((sum, group) => sum + group.totalRequests, 0),
    eventCount: groups.reduce((sum, group) => sum + group.eventCount, 0),
    groups,
  });
}
