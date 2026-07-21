import { NextRequest, NextResponse } from "next/server";
import { computeProjectBudgetStatus } from "@/lib/budget-status";
import {
  tokenFromRequest,
  safeEqual,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read token: dedicated USAGE_READ_TOKEN preferred; ingest fallback only outside
// production (or when USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK=true). See C10.
export async function GET(request: NextRequest) {
  const expected = resolveUsageReadToken();
  if (!expected) {
    return NextResponse.json(
      {
        error:
          "Budget status is not configured (set USAGE_READ_TOKEN in production)",
      },
      { status: 503 }
    );
  }
  const actual = tokenFromRequest(request, "x-usage-ingest-token");
  if (!actual || !safeEqual(actual, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await computeProjectBudgetStatus();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
