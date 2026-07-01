import { NextResponse } from "next/server";

// Unauthenticated liveness check for external uptime monitors. Deliberately
// excluded from src/middleware.ts's session gate, since the dashboard's own
// pages/APIs now redirect/401 unauthenticated requests and a health check
// shouldn't need to authenticate (or follow a redirect) just to confirm the
// service is up.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true });
}
