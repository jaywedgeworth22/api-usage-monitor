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
    "/((?!_next/static|_next/image|favicon\\.ico|login(?:/|$)|api/auth/login(?:/|$)|api/cron(?:/|$)|api/ingest(?:/|$)|api/otlp(?:/|$)|api/health(?:/|$)).*)",
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
