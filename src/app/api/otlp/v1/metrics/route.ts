import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { persistExternalUsageEvents } from "@/lib/external-usage-events";
import { isUsageIngestAuthorized } from "@/lib/ingest-auth";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { decodeMetricsJson } from "@/lib/otlp/json-decode";
import { decodeMetricsProtobuf } from "@/lib/otlp/protobuf-decode";
import { mapClaudeCodeMetrics } from "@/lib/otlp/claude-code-mapper";
import { mapSystemMetrics } from "@/lib/otlp/system-mapper";
import { ensureAnthropicProviderSeeded } from "@/lib/otlp/ensure-anthropic-provider";
import { resolveProjectIdsByName } from "@/lib/project-resolver";

// OTLP-HTTP metrics ingest: POST /api/otlp/v1/metrics
//
// This is the standard OTLP-HTTP receiver path (the "/v1/metrics" suffix is
// part of the OTLP spec itself, not app-specific routing:
// https://opentelemetry.io/docs/specs/otlp/#otlphttp-request). Point Claude
// Code (or any OTLP exporter) at this with:
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://usage.jays.services/api/otlp
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/json   (or http/protobuf)
//   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <USAGE_INGEST_TOKEN>
//
// Encodings accepted:
//   - Content-Type: application/json         -> decodeMetricsJson (primary target)
//   - Content-Type: application/x-protobuf    -> decodeMetricsProtobuf
// NOT accepted: gRPC (OTEL_EXPORTER_OTLP_PROTOCOL=grpc, Claude Code's
// default). gRPC needs HTTP/2 + trailers, which a plain Next.js Route
// Handler cannot terminate. A gRPC-configured client gets a 415 with a
// message pointing at the two supported protocol env var values, rather
// than a confusing hang/connection-reset.
//
// Auth: identical bearer/header scheme to POST /api/ingest/usage
// (Authorization: Bearer <USAGE_INGEST_TOKEN>, or x-usage-ingest-token
// header) — see src/lib/ingest-auth.ts.
//
// Idempotency: OTLP exporters retry an entire export batch on transient
// failure (e.g. a 5xx or timeout), which would double-count usage/cost on
// naive insert. Every mapped row's idempotencyKey is a hash of the metric
// name + all resource/point attributes + the data point's time window +
// its value (see claude-code-mapper.ts's deriveIdempotencyKey) and rows are
// upserted on that key exactly like the existing usage-ingest route, so a
// byte-identical retry is a no-op.
//
// Unknown metrics: never rejected or 500'd. mapClaudeCodeMetrics tallies any
// metric name outside the known Claude Code set and this route logs it once
// per request (not once per data point, to avoid log-spam from a single
// unrecognized high-cardinality metric) via console.warn — future Claude
// Code releases that add new metrics degrade to "ignored" rather than
// breaking ingest.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same generosity as /api/ingest/usage: OTLP exporters batch on a fixed
// interval (default 60s) rather than per-event, so request volume is low,
// but keep a rate limiter for the same abuse-prevention reasons.
const otlpMetricsRateLimiter = createRateLimiter(1_000, 10);

const loggedUnknownMetrics = new Set<string>();

function unsupportedProtocolResponse(contentType: string) {
  return NextResponse.json(
    {
      error:
        `Unsupported Content-Type "${contentType}" for OTLP metrics ingest. ` +
        "Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json or http/protobuf (gRPC is not supported by this endpoint).",
    },
    { status: 415 }
  );
}

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const ip = getClientIp(request);
  if (!otlpMetricsRateLimiter.check(ip)) {
    return NextResponse.json({ error: "Too many requests. Slow down." }, { status: 429 });
  }

  if (!isUsageIngestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  let parsed;
  try {
    if (contentType === "" || contentType === "application/json") {
      parsed = decodeMetricsJson(await request.json());
    } else if (contentType === "application/x-protobuf" || contentType === "application/protobuf") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      parsed = decodeMetricsProtobuf(bytes);
    } else {
      return unsupportedProtocolResponse(contentType);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid OTLP payload" },
      { status: 400 }
    );
  }

  const claudeResult = mapClaudeCodeMetrics(parsed);
  const systemResult = mapSystemMetrics(parsed);

  const events = [...claudeResult.events, ...systemResult.events];
  
  // A metric is only truly "unknown" if neither mapper understood it
  const unknownMetrics = claudeResult.unknownMetrics.filter((claudeUnknown) => 
    systemResult.unknownMetrics.some(sysUnknown => sysUnknown.name === claudeUnknown.name)
  );

  for (const unknown of unknownMetrics) {
    const key = unknown.name;
    if (!loggedUnknownMetrics.has(key)) {
      loggedUnknownMetrics.add(key);
      console.warn(
        `[otlp/metrics] unrecognized metric "${unknown.name}" (${unknown.dataPointCount} data point(s) this request) — accepted, not mapped`
      );
    }
  }

  let skippedPrunedDuplicates = 0;
  if (events.length > 0) {
    // Resolve any `project` resource attribute (OTEL_RESOURCE_ATTRIBUTES) to a
    // Project.id. Unknown names stay null; the raw name is already preserved in
    // metadata via the mapper's cleanMetadata, so a later-created Project can be
    // back-filled.
    const projectIdByName = await resolveProjectIdsByName(
      events.map((event) => event.projectName).filter((name): name is string => !!name)
    );

    const persistResult = await persistExternalUsageEvents(
      events.map((event) => ({
        idempotencyKey: event.idempotencyKey,
        sourceApp: event.sourceApp,
        environment: event.environment,
        provider: event.provider,
        service: event.service,
        projectId: event.projectName
          ? projectIdByName.get(event.projectName.trim().toLowerCase()) ?? null
          : null,
        label: event.label,
        keyRef: event.keyRef,
        billingMode: event.billingMode,
        metricType: event.metricType,
        quantity: event.quantity,
        unit: event.unit,
        costUsd: event.costUsd,
        requests: event.requests,
        occurredAt: event.occurredAt,
        metadata: event.metadata as Prisma.InputJsonObject,
      }))
    );
    skippedPrunedDuplicates = persistResult.skippedPrunedDuplicates;

    // Best-effort: give the owner a Provider row to attach a budget to (see
    // ensure-anthropic-provider.ts for why this is lazy-on-first-ingest
    // rather than a one-off seed script, and why it's a no-op if an
    // "anthropic" provider already exists from the poll adapter). Never lets
    // a seeding failure fail the ingest itself — the usage row above is
    // already durably written by this point.
    try {
      await ensureAnthropicProviderSeeded();
    } catch (error) {
      console.warn(
        "[otlp/metrics] failed to seed anthropic provider row (non-fatal):",
        error instanceof Error ? error.message : error
      );
    }
  }

  return NextResponse.json(
    {
      ok: true,
      accepted: events.length - skippedPrunedDuplicates,
      ignoredPruned: skippedPrunedDuplicates || undefined,
      unknownMetrics: unknownMetrics.length > 0 ? unknownMetrics : undefined,
    },
    { status: 202 }
  );
}
