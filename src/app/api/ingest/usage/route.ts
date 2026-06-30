import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseUsageTelemetryBatch } from "@/lib/usage-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenFromRequest(request: NextRequest): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get("x-usage-ingest-token")?.trim() ?? "";
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.USAGE_INGEST_TOKEN?.trim();
  if (!expected) return false;
  const actual = tokenFromRequest(request);
  return Boolean(actual) && safeEqual(actual, expected);
}

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  if (!isAuthorized(request)) {
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

  await prisma.externalUsageEvent.createMany({
    data: events.map((event) => ({
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
      metadata: event.metadata as Prisma.InputJsonObject | undefined,
    })),
  });

  return NextResponse.json({ ok: true, accepted: events.length }, { status: 202 });
}
