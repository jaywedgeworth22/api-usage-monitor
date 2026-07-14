import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  ExternalUsageIdempotencyCollisionError,
  persistExternalUsageEvents,
  syncStatusToUsageSnapshot,
} from "@/lib/external-usage-events";
import { parseUsageTelemetryBatch } from "@/lib/usage-telemetry";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { isUsageIngestAuthorized } from "@/lib/ingest-auth";
import { resolveProjectIdsByName } from "@/lib/project-resolver";
import { canonicalProjectKey } from "@/lib/provider-identity";
import {
  INGEST_ADMISSION_RETRY_AFTER_SECONDS,
  tryAcquireIngestAdmission,
} from "@/lib/ingest-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 10 requests per second per source IP — generous enough for normal
// fire-and-forget telemetry pushes while preventing abuse.
const ingestRateLimiter = createRateLimiter(1_000, 10);

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const ip = getClientIp(request);
  if (!ingestRateLimiter.check(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": "1" } }
    );
  }

  if (!isUsageIngestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let events;
  try {
    events = parseUsageTelemetryBatch(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const releaseAdmission = tryAcquireIngestAdmission();
  if (!releaseAdmission) {
    return NextResponse.json(
      { error: "Usage ingest is busy. Retry later." },
      {
        status: 503,
        headers: { "Retry-After": String(INGEST_ADMISSION_RETRY_AFTER_SECONDS) },
      }
    );
  }

  try {
    // Resolve any top-level `project` field to a Project.id. Unknown names stay
    // null but are preserved in metadata so a later-created Project can be
    // back-filled.
    const projectIdByName = await resolveProjectIdsByName(
      events.map((event) => event.project).filter((name): name is string => !!name)
    );

    let persistResult: Awaited<ReturnType<typeof persistExternalUsageEvents>>;
    try {
      persistResult = await persistExternalUsageEvents(
        events.map((event) => {
          const projectId = event.project
            ? projectIdByName.get(canonicalProjectKey(event.project)) ?? null
            : null;
          const metadata =
            event.project && !(event.metadata && "project" in event.metadata)
              ? { ...(event.metadata ?? {}), project: event.project }
              : event.metadata;
          return {
            idempotencyKey: event.idempotencyKey,
            sourceApp: event.sourceApp,
            environment: event.environment,
            provider: event.provider,
            service: event.service,
            projectId,
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
            metadata: metadata as Prisma.InputJsonObject | undefined,
          };
        })
      );
    } catch (error) {
      if (error instanceof ExternalUsageIdempotencyCollisionError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    // Cross-app status metrics integration: Generate UsageSnapshot rows for absolute metrics.
    await syncStatusToUsageSnapshot(persistResult.newEvents);

    return NextResponse.json(
      {
        ok: true,
        accepted: persistResult.persisted,
        ignoredPruned: persistResult.skippedPrunedDuplicates,
      },
      { status: 202 }
    );
  } finally {
    releaseAdmission();
  }
}
