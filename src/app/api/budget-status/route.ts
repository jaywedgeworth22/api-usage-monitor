import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { computeBudgetStatus } from "@/lib/budget-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read token: a dedicated USAGE_READ_TOKEN if configured, otherwise the ingest token is reused
// (a consuming app that can push already holds it). Keeping a separate read token optional lets an
// operator hand out read-only access without granting ingest.
function expectedToken(): string | undefined {
  return process.env.USAGE_READ_TOKEN?.trim() || process.env.USAGE_INGEST_TOKEN?.trim() || undefined;
}

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

export async function GET(request: NextRequest) {
  const expected = expectedToken();
  if (!expected) {
    return NextResponse.json({ error: "Budget status is not configured" }, { status: 503 });
  }
  const actual = tokenFromRequest(request);
  if (!actual || !safeEqual(actual, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await computeBudgetStatus();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
