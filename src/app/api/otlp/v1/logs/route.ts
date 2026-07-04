import { NextRequest, NextResponse } from "next/server";
import { isUsageIngestAuthorized } from "@/lib/ingest-auth";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { decodeLogsJson } from "@/lib/otlp/json-decode";
import { decodeLogsProtobuf } from "@/lib/otlp/protobuf-decode";

// OTLP-HTTP logs ingest: POST /api/otlp/v1/logs
//
// DESIGN CHOICE: accept-and-drop, not stored. This app's usage schema
// (ExternalUsageEvent / UsageSnapshot) has no concept of a discrete log
// event — Claude Code's OTEL_LOGS_EXPORTER stream (claude_code.user_prompt,
// claude_code.api_request, claude_code.tool_result, etc. — see
// https://code.claude.com/docs/en/monitoring-usage) is high-volume,
// free-text-shaped, and overlaps with what Sentry already captures for
// errors/health per the owner's goal split (usage metrics -> this monitor,
// errors/health -> Sentry). Storing it here would mean building a second,
// unrelated event-log feature this app doesn't otherwise have, for data this
// app's dashboards have no way to surface.
//
// This route exists (rather than 404) purely so a Claude Code deployment
// that sets OTEL_LOGS_EXPORTER=otlp against this same OTLP endpoint doesn't
// get spurious 404s/errors in its own export pipeline — every request is
// authenticated and decoded (so malformed payloads are still visible in
// server logs / a 400), counted, and discarded.
//
// If per-event log storage is ever wanted, this is the seam to extend: parse
// resourceLogs[].scopeLogs[].logRecords[] (already modeled in
// src/lib/otlp/types.ts) and write to a new table — do not overload
// ExternalUsageEvent for this, its schema/consumers (budget-status,
// usage-events summary) assume one row = one usage/cost observation.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const otlpLogsRateLimiter = createRateLimiter(1_000, 20);

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const ip = getClientIp(request);
  if (!otlpLogsRateLimiter.check(ip)) {
    return NextResponse.json({ error: "Too many requests. Slow down." }, { status: 429 });
  }

  if (!isUsageIngestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  let logRecordCount = 0;
  try {
    if (contentType === "" || contentType === "application/json") {
      const parsed = decodeLogsJson(await request.json());
      logRecordCount = countLogRecords(parsed.resourceLogs);
    } else if (contentType === "application/x-protobuf" || contentType === "application/protobuf") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const parsed = decodeLogsProtobuf(bytes);
      logRecordCount = countLogRecords(parsed.resourceLogs);
    } else {
      return NextResponse.json(
        {
          error: `Unsupported Content-Type "${contentType}" for OTLP logs ingest. Use application/json or application/x-protobuf.`,
        },
        { status: 415 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid OTLP payload" },
      { status: 400 }
    );
  }

  // Accept-and-drop: counted for the response body (useful for smoke-testing
  // the exporter is reaching this endpoint at all) but never persisted.
  return NextResponse.json({ ok: true, accepted: 0, received: logRecordCount, stored: false }, { status: 202 });
}

function countLogRecords(resourceLogs: { scopeLogs?: { logRecords?: unknown[] }[] }[] | undefined): number {
  let count = 0;
  for (const resource of resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      count += scope.logRecords?.length ?? 0;
    }
  }
  return count;
}
