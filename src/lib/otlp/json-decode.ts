import type { OtlpExportLogsServiceRequest, OtlpExportMetricsServiceRequest } from "./types";

// OTLP/HTTP with `Content-Type: application/json` sends the protobuf
// message's canonical proto3 JSON mapping directly (no framing, no base64
// body wrapper) — see https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding.
// Decoding it is just "trust the JSON shape", which is why this file is thin:
// the real validation happens per-field in claude-code-mapper.ts (missing/
// malformed numeric fields become `undefined` and are skipped, never thrown).

export function decodeMetricsJson(body: unknown): OtlpExportMetricsServiceRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("OTLP metrics payload must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record.resourceMetrics !== undefined && !Array.isArray(record.resourceMetrics)) {
    throw new Error("resourceMetrics must be an array");
  }
  return body as OtlpExportMetricsServiceRequest;
}

export function decodeLogsJson(body: unknown): OtlpExportLogsServiceRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("OTLP logs payload must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record.resourceLogs !== undefined && !Array.isArray(record.resourceLogs)) {
    throw new Error("resourceLogs must be an array");
  }
  return body as OtlpExportLogsServiceRequest;
}
