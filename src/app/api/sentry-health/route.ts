import { NextResponse } from "next/server";
import { fetchSentryHealth } from "@/lib/sentry-health";

// GET /api/sentry-health — dashboard-only (gated by the same session-cookie
// middleware as every other non-ingest route; see src/middleware.ts). Never
// exposes SENTRY_READ_TOKEN to the client: this route runs entirely
// server-side and the response body only ever contains derived counts/links.
//
// Returns { configured: false } when SENTRY_READ_TOKEN/SENTRY_ORG aren't set,
// so the dashboard card can render nothing rather than an error state for
// the common case (most deployments of this app won't have Sentry wired up).

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await fetchSentryHealth();
  return NextResponse.json(health);
}
