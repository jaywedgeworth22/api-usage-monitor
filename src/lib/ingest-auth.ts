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

/**
 * Resolve the expected read token for budget-status / subscriptions GET.
 *
 * Prefer a dedicated USAGE_READ_TOKEN. Falling back to USAGE_INGEST_TOKEN is
 * allowed outside production (and when USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK
 * is explicitly true) so local/dev stay ergonomic. In production the fallback
 * is denied by default (Wave C / C10) so a compromised read consumer cannot
 * also forge ingest events with the same secret.
 */
export function resolveUsageReadToken(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const read = env.USAGE_READ_TOKEN?.trim();
  if (read) return read;

  const allowFallback =
    env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK?.trim().toLowerCase() === "true" ||
    env.NODE_ENV !== "production";
  if (!allowFallback) return undefined;

  return env.USAGE_INGEST_TOKEN?.trim() || undefined;
}

// Read-only token check for GET /api/subscriptions (and shared by budget-status).
export function isUsageReadAuthorized(request: NextRequest): boolean {
  const expected = resolveUsageReadToken();
  if (!expected) return false;
  const actual = tokenFromRequest(request, "x-usage-ingest-token");
  return Boolean(actual) && safeEqual(actual, expected);
}
