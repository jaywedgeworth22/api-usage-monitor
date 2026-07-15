import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ExternalUsageIdempotencyCollisionError,
  persistExternalUsageEvents,
  syncStatusToUsageSnapshot,
} from "@/lib/external-usage-events";
import { parseUsageTelemetryBatch } from "@/lib/usage-telemetry";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import {
  isBillingReceiptIngestAuthorized,
  isUsageIngestAuthorized,
  safeEqual,
} from "@/lib/ingest-auth";
import { resolveProjectIdsByName } from "@/lib/project-resolver";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  looksLikeReceiptCashEvent,
  receiptCashIdentity,
  stripReceiptTransportSignature,
  verifyReceiptCashEvent,
} from "@/lib/receipt-cash";
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
  const usageToken = process.env.USAGE_INGEST_TOKEN?.trim() ?? "";
  const receiptToken = process.env.BILLING_RECEIPT_INGEST_TOKEN?.trim() ?? "";
  if (!usageToken && !receiptToken) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }
  if (usageToken && receiptToken && safeEqual(usageToken, receiptToken)) {
    return NextResponse.json(
      { error: "Billing receipt ingest token must be distinct from usage ingest" },
      { status: 503 }
    );
  }

  const ip = getClientIp(request);
  if (!ingestRateLimiter.check(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": "1" } }
    );
  }

  const usageAuthorized = isUsageIngestAuthorized(request);
  const receiptAuthorized = isBillingReceiptIngestAuthorized(request);
  if (!usageAuthorized && !receiptAuthorized) {
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

  const receiptLikeEvents = events.filter(looksLikeReceiptCashEvent);
  if (receiptLikeEvents.length > 0) {
    if (!receiptAuthorized) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (receiptLikeEvents.length !== events.length) {
      return NextResponse.json(
        { error: "Billing receipt and ordinary usage events cannot share a batch" },
        { status: 400 }
      );
    }
  } else if (!usageAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    const receiptTargets: Array<{ providerId: string; providerName: string }> = [];
    if (receiptLikeEvents.length > 0) {
      const hmacKey = process.env.BILLING_RECEIPT_HMAC_KEY?.trim() ?? "";
      if (hmacKey.length < 32) {
        return NextResponse.json(
          { error: "Billing receipt signature verification is not configured" },
          { status: 503 }
        );
      }
      for (const event of receiptLikeEvents) {
        const identity = receiptCashIdentity(event);
        if (!identity || !verifyReceiptCashEvent(event, hmacKey)) {
          return NextResponse.json(
            { error: "Billing receipt event signature or format is invalid" },
            { status: 400 }
          );
        }
        receiptTargets.push({
          providerId: identity.providerId,
          providerName: event.provider,
        });
      }
    }
    if (receiptTargets.length > 0) {
      const providerIds = Array.from(
        new Set(receiptTargets.map((target) => target.providerId))
      );
      const providers = await prisma.provider.findMany({
        where: { id: { in: providerIds } },
        select: { id: true, name: true },
      });
      const providerById = new Map(providers.map((provider) => [provider.id, provider]));
      for (const target of receiptTargets) {
        const provider = providerById.get(target.providerId);
        if (
          !provider ||
          canonicalProviderKey(provider.name) !==
            canonicalProviderKey(target.providerName)
        ) {
          return NextResponse.json(
            { error: "Billing receipt provider ID and provider name do not match" },
            { status: 400 }
          );
        }
      }
    }

    const persistenceEvents =
      receiptLikeEvents.length > 0
        ? events.map((event) => ({
            ...event,
            metadata: stripReceiptTransportSignature(event.metadata),
          }))
        : events;

    // Resolve any top-level `project` field to a Project.id. Unknown names stay
    // null but are preserved in metadata so a later-created Project can be
    // back-filled.
    const projectIdByName = await resolveProjectIdsByName(
      persistenceEvents
        .map((event) => event.project)
        .filter((name): name is string => !!name)
    );

    let persistResult: Awaited<ReturnType<typeof persistExternalUsageEvents>>;
    try {
      persistResult = await persistExternalUsageEvents(
        persistenceEvents.map((event) => {
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
