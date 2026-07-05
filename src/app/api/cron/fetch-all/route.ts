import { NextRequest, NextResponse } from "next/server";
import { fetchAllDueProviders } from "@/lib/usage-recorder";
import { runUsageMaintenance } from "@/lib/usage-maintenance";

// This endpoint is no longer called on a schedule (usage polling now runs
// in-process, see src/instrumentation.ts / src/lib/usage-recorder.ts). It's
// kept as an authenticated manual-trigger/debug route - cheap to keep and
// useful for on-demand triggering.
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || cronSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await fetchAllDueProviders();
  const maintenance = await runUsageMaintenance();

  return NextResponse.json({ ...result, maintenance });
}
