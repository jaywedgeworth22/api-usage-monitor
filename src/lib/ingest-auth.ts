import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

// Shared bearer/header parsing for ingest-style routes. Ordinary usage and
// OTLP use USAGE_INGEST_TOKEN; private-safe billing receipt imports use their
// own canonical token so a compromised telemetry producer cannot forge cash
// evidence. The server never selects alternate credentials from the request
// URL or forwarded peer identity.

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

export function isBillingReceiptIngestAuthorized(request: NextRequest): boolean {
  const expected = process.env.BILLING_RECEIPT_INGEST_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const actual = tokenFromRequest(request, "x-billing-receipt-ingest-token");
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
