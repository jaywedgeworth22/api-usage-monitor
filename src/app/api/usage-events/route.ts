import { NextRequest, NextResponse } from "next/server";
import { summarizeExternalUsageEvents } from "@/lib/external-usage-events";
import { getExternalEventRawCutoff } from "@/lib/data-retention";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 365)
    : 30;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const summary = await summarizeExternalUsageEvents(
    since,
    getExternalEventRawCutoff()
  );

  return NextResponse.json({
    days,
    totalCostUsd: summary.groups.reduce((sum, group) => sum + group.totalCostUsd, 0),
    totalRequests: summary.groups.reduce((sum, group) => sum + group.totalRequests, 0),
    eventCount: summary.eventCount,
    groups: summary.groups,
  });
}
