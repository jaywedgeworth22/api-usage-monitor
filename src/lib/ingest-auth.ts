import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

// Shared bearer/header auth for every ingest-style route (the existing
// POST /api/ingest/usage and the new POST /api/otlp/v1/{metrics,logs}).
// Deliberately reuses the SAME env var (USAGE_INGEST_TOKEN) and the same
// two accepted header forms, per the task's "same bearer/header scheme as
// the existing ingest endpoint" requirement — this is not a new secret to
// provision, it's the token operators already have configured.

export function tokenFromRequest(request: NextRequest, headerName: string): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get(headerName)?.trim() ?? "";
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isUsageIngestAuthorized(request: NextRequest): boolean {
  const expected = process.env.USAGE_INGEST_TOKEN?.trim();
  if (!expected) return false;
  const actual = tokenFromRequest(request, "x-usage-ingest-token");
  return Boolean(actual) && safeEqual(actual, expected);
}

// Read-only token check, mirroring GET /api/budget-status's inline
// expectedToken()/tokenFromRequest/safeEqual pattern: a dedicated
// USAGE_READ_TOKEN if configured, otherwise the ingest token is reused (a
// consuming app that can push already holds it). Used by GET
// /api/subscriptions so a headless sibling app can read the subscription/
// knobEnv list without a dashboard session cookie.
export function isUsageReadAuthorized(request: NextRequest): boolean {
  const expected = process.env.USAGE_READ_TOKEN?.trim() || process.env.USAGE_INGEST_TOKEN?.trim();
  if (!expected) return false;
  const actual = tokenFromRequest(request, "x-usage-ingest-token");
  return Boolean(actual) && safeEqual(actual, expected);
}
