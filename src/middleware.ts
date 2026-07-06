import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export const config = {
  runtime: "nodejs",
  matcher: [
    // Exclusions are anchored to full path segments (via `(?:/|$)`) so that
    // routes merely *prefixed* with an excluded name (e.g. /api/crontab,
    // /api/ingestor, /loginpage) are NOT accidentally left unauthenticated.
    // api/otlp is excluded for the same reason as api/ingest: both routes
    // authenticate pushed telemetry with their own Bearer USAGE_INGEST_TOKEN
    // check (see src/lib/ingest-auth.ts), not the dashboard session cookie —
    // an OTLP exporter (Claude Code) has no way to obtain that cookie.
    // api/budget-status is excluded for the same reason: it authenticates its
    // own Bearer/x-usage-ingest-token check (USAGE_READ_TOKEN, falling back to
    // USAGE_INGEST_TOKEN — see src/app/api/budget-status/route.ts) so sibling
    // apps can poll spend before an LLM call. Such a caller has no session
    // cookie, so leaving this in the matcher 401'd every request before the
    // route's own token check ever ran.
    "/((?!_next/static|_next/image|favicon\\.ico|login(?:/|$)|api/auth/login(?:/|$)|api/cron(?:/|$)|api/ingest(?:/|$)|api/otlp(?:/|$)|api/budget-status(?:/|$)|api/health(?:/|$)).*)",
  ],
};

export function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (verifySessionToken(token)) {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}
