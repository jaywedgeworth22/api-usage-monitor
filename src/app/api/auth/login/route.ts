import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  createSessionToken,
  verifyPassword,
} from "@/lib/auth";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 5 attempts per IP per minute
const loginRateLimiterByIp = createRateLimiter(60_000, 5);

// IP-independent backstop: caps total login attempts across every client, so
// no X-Forwarded-For/IP value - spoofed, rotated, or genuinely distinct -
// lets an attacker escape limiting altogether by fanning out across "IPs".
// Deliberately looser than the per-IP cap so it only bites during sustained
// multi-source brute-forcing, not normal single-user traffic.
const GLOBAL_LOGIN_KEY = "__global__";
const globalLoginRateLimiter = createRateLimiter(60_000, 20);

export async function POST(request: NextRequest) {
  if (!process.env.DASHBOARD_PASSWORD?.trim()) {
    return NextResponse.json(
      { error: "Dashboard auth is not configured" },
      { status: 503 }
    );
  }

  const ip = getClientIp(request);
  // Check both unconditionally (not `||`) so this request always consumes
  // from both budgets, even when one is already exhausted.
  const withinIpLimit = loginRateLimiterByIp.check(ip);
  const withinGlobalLimit = globalLoginRateLimiter.check(GLOBAL_LOGIN_KEY);
  if (!withinIpLimit || !withinGlobalLimit) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  let password: unknown;
  try {
    const body = await request.json();
    password = body?.password;
  } catch {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  if (typeof password !== "string" || !password || !verifyPassword(password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
