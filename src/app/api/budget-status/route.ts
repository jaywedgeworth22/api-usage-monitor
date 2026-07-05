import { NextRequest, NextResponse } from "next/server";
import { computeProjectBudgetStatus } from "@/lib/budget-status";
import { tokenFromRequest, safeEqual } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read token: a dedicated USAGE_READ_TOKEN if configured, otherwise the ingest token is reused
// (a consuming app that can push already holds it). Keeping a separate read token optional lets an
// operator hand out read-only access without granting ingest.
function expectedToken(): string | undefined {
  return process.env.USAGE_READ_TOKEN?.trim() || process.env.USAGE_INGEST_TOKEN?.trim() || undefined;
}

export async function GET(request: NextRequest) {
  const expected = expectedToken();
  if (!expected) {
    return NextResponse.json({ error: "Budget status is not configured" }, { status: 503 });
  }
  const actual = tokenFromRequest(request, "x-usage-ingest-token");
  if (!actual || !safeEqual(actual, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await computeProjectBudgetStatus();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
