import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface ExternalUsageEventInput {
  idempotencyKey: string;
  sourceApp: string;
  environment?: string;
  provider: string;
  service?: string;
  label?: string;
  keyRef?: string;
  billingMode: string;
  metricType: string;
  quantity?: number;
  unit?: string;
  costUsd?: number;
  requests?: number;
  credits?: number;
  limit?: number;
  limitWindow?: string;
  tier?: string;
  confidence?: string;
  windowStart?: Date;
  windowEnd?: Date;
  occurredAt: Date;
  metadata?: Prisma.InputJsonObject;
}

export interface PersistExternalUsageEventsResult {
  attempted: number;
  persisted: number;
  skippedPrunedDuplicates: number;
}

export interface ExternalUsageEventSummaryGroup {
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

function toCreateData(event: ExternalUsageEventInput): Prisma.ExternalUsageEventCreateInput {
  return {
    idempotencyKey: event.idempotencyKey,
    sourceApp: event.sourceApp,
    environment: event.environment,
    provider: event.provider,
    service: event.service,
    label: event.label,
    keyRef: event.keyRef,
    billingMode: event.billingMode,
    metricType: event.metricType,
    quantity: event.quantity,
    unit: event.unit,
    costUsd: event.costUsd,
    requests: event.requests,
    credits: event.credits,
    limit: event.limit,
    limitWindow: event.limitWindow,
    tier: event.tier,
    confidence: event.confidence,
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    occurredAt: event.occurredAt,
    metadata: event.metadata,
  };
}

export async function persistExternalUsageEvents(
  events: ExternalUsageEventInput[]
): Promise<PersistExternalUsageEventsResult> {
  if (events.length === 0) {
    return { attempted: 0, persisted: 0, skippedPrunedDuplicates: 0 };
  }

  const idempotencyKeys = events.map((event) => event.idempotencyKey);
  const tombstones = await prisma.externalUsageEventTombstone.findMany({
    where: { idempotencyKey: { in: idempotencyKeys } },
    select: { idempotencyKey: true },
  });
  const prunedKeys = new Set(tombstones.map((row) => row.idempotencyKey));
  const activeEvents = events.filter((event) => !prunedKeys.has(event.idempotencyKey));

  if (activeEvents.length > 0) {
    await prisma.$transaction(
      activeEvents.map((event) =>
        prisma.externalUsageEvent.upsert({
          where: { idempotencyKey: event.idempotencyKey },
          create: toCreateData(event),
          update: {},
        })
      )
    );
  }

  return {
    attempted: events.length,
    persisted: activeEvents.length,
    skippedPrunedDuplicates: events.length - activeEvents.length,
  };
}

function summaryGroupKey(group: {
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
}): string {
  return [
    group.sourceApp,
    group.environment ?? "",
    group.provider,
    group.service ?? "",
  ].join("|");
}

function mergeSummaryGroup(
  target: Map<string, ExternalUsageEventSummaryGroup>,
  group: ExternalUsageEventSummaryGroup
): void {
  const key = summaryGroupKey(group);
  const existing = target.get(key);
  if (!existing) {
    target.set(key, group);
    return;
  }

  existing.eventCount += group.eventCount;
  existing.totalCostUsd += group.totalCostUsd;
  existing.totalRequests += group.totalRequests;
  existing.totalQuantity += group.totalQuantity;
  existing.limit = existing.limit ?? group.limit;
  existing.limitWindow = existing.limitWindow ?? group.limitWindow;
  if (group.latestAt > existing.latestAt) {
    existing.latestAt = group.latestAt;
  }
}

export async function summarizeExternalUsageEvents(
  since: Date,
  rawCutoff: Date
): Promise<{
  eventCount: number;
  groups: ExternalUsageEventSummaryGroup[];
}> {
  const groups = new Map<string, ExternalUsageEventSummaryGroup>();
  const rawSince = since > rawCutoff ? since : rawCutoff;

  const [rawEvents, rollups] = await Promise.all([
    prisma.externalUsageEvent.findMany({
      where: { occurredAt: { gte: rawSince } },
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
    }),
    since < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: {
              gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())),
              lt: rawCutoff,
            },
          },
          select: {
            sourceApp: true,
            environment: true,
            provider: true,
            service: true,
            eventCount: true,
            totalCostUsd: true,
            totalRequests: true,
            totalQuantity: true,
            maxLimit: true,
            limitWindow: true,
            latestOccurredAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  for (const event of rawEvents) {
    mergeSummaryGroup(groups, {
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
  }

  for (const rollup of rollups) {
    mergeSummaryGroup(groups, {
      sourceApp: rollup.sourceApp,
      environment: rollup.environment,
      provider: rollup.provider,
      service: rollup.service,
      eventCount: rollup.eventCount,
      totalCostUsd: rollup.totalCostUsd,
      totalRequests: rollup.totalRequests,
      totalQuantity: rollup.totalQuantity,
      limit: rollup.maxLimit,
      limitWindow: rollup.limitWindow,
      latestAt: rollup.latestOccurredAt.toISOString(),
    });
  }

  const summaries = Array.from(groups.values()).sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );

  return {
    eventCount:
      rawEvents.length + rollups.reduce((sum, rollup) => sum + rollup.eventCount, 0),
    groups: summaries,
  };
}

export async function sumMonthToDateExternalCostByProvider(
  monthStart: Date,
  rawCutoff: Date
): Promise<Map<string, number>> {
  const rawSince = monthStart > rawCutoff ? monthStart : rawCutoff;

  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider"],
      where: { occurredAt: { gte: rawSince }, costUsd: { not: null } },
      _sum: { costUsd: true },
    }),
    monthStart < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: { gte: monthStart, lt: rawCutoff },
          },
          select: {
            provider: true,
            totalCostUsd: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const totals = new Map<string, number>();
  for (const row of rawGroups) {
    totals.set(row.provider.toLowerCase(), row._sum.costUsd ?? 0);
  }
  for (const rollup of rollups) {
    const key = rollup.provider.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + rollup.totalCostUsd);
  }
  return totals;
}

export async function sumMonthToDateExternalCostBySourceApp(
  monthStart: Date,
  rawCutoff: Date
): Promise<Map<string, number>> {
  const rawSince = monthStart > rawCutoff ? monthStart : rawCutoff;

  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp"],
      where: { occurredAt: { gte: rawSince }, costUsd: { not: null } },
      _sum: { costUsd: true },
    }),
    monthStart < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: { gte: monthStart, lt: rawCutoff },
          },
          select: {
            sourceApp: true,
            totalCostUsd: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const totals = new Map<string, number>();
  for (const row of rawGroups) {
    totals.set(row.sourceApp.toLowerCase(), row._sum.costUsd ?? 0);
  }
  for (const rollup of rollups) {
    const key = rollup.sourceApp.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + rollup.totalCostUsd);
  }
  return totals;
}
