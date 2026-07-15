import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const PASSWORD = "the-correct-password";

async function freshRoute(): Promise<typeof import("../route")> {
  // Rate limiters are module-level singletons created at import time; reset
  // the module registry so each test that depends on limiter counts starts
  // from a clean state instead of sharing counters with earlier tests.
  vi.resetModules();
  return import("../route");
}

function loginRequest(
  password: unknown,
  forwardedFor: string,
  overrides: Record<string, string> = {}
): NextRequest {
  return new NextRequest("https://usage.jays.services/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      ...overrides,
    },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = PASSWORD;
  });

  afterEach(() => {
    delete process.env.DASHBOARD_PASSWORD;
    vi.resetModules();
  });

  it("returns 503 when DASHBOARD_PASSWORD is not configured", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const { POST } = await freshRoute();
    const res = await POST(loginRequest(PASSWORD, "1.1.1.1"));
    expect(res.status).toBe(503);
  });

  it("logs in successfully with the correct password and sets the session cookie", async () => {
    const { POST } = await freshRoute();
    const res = await POST(loginRequest(PASSWORD, "1.1.1.1"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("dashboard_session")).toBeTruthy();
  });

  it("rejects an incorrect password with 401", async () => {
    const { POST } = await freshRoute();
    const res = await POST(loginRequest("wrong-password", "1.1.1.1"));
    expect(res.status).toBe(401);
  });

  it("blocks after 5 attempts from the same trusted (rightmost) IP", async () => {
    const { POST } = await freshRoute();
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong", "9.9.9.9"));
      expect(res.status).toBe(401);
    }
    const sixth = await POST(loginRequest("wrong", "9.9.9.9"));
    expect(sixth.status).toBe(429);

    // Even the correct password is now rate-limited from this IP.
    const correctButLimited = await POST(loginRequest(PASSWORD, "9.9.9.9"));
    expect(correctButLimited.status).toBe(429);
  });

  it("is not bypassed by rotating the client-controlled (leftmost) XFF prefix", async () => {
    // Every request claims a different attacker-supplied leftmost hop, but
    // the rightmost hop - the one the deployment's proxy actually appended -
    // stays fixed. Per-IP limiting must key off that trusted hop only.
    const { POST } = await freshRoute();
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong", `10.0.0.${i}, 9.9.9.9`));
      expect(res.status).toBe(401);
    }
    const sixth = await POST(loginRequest("wrong", "10.0.0.99, 9.9.9.9"));
    expect(sixth.status).toBe(429);
  });

  it("caps total login attempts globally even when each IP stays under its own per-IP limit", async () => {
    // 20 distinct IPs, one attempt each (well under the 5/IP limit per
    // source), must still eventually trip the IP-independent backstop.
    const { POST } = await freshRoute();
    let sawRateLimited = false;
    for (let i = 0; i < 25; i++) {
      const res = await POST(loginRequest("wrong", `172.16.0.${i}`));
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawRateLimited).toBe(true);
  });
});
