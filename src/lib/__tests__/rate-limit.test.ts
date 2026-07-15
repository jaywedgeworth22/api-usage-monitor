import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, getClientIp } from "../rate-limit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxRequests per key within the window, then blocks", () => {
    const limiter = createRateLimiter(60_000, 3);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("a")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("b")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(false);
  });

  it("resets a key's count once its window elapses", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(limiter.check("a")).toBe(true);
  });
});

describe("getClientIp", () => {
  it("trusts only the rightmost X-Forwarded-For hop", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    // The rightmost entry is the peer address our own proxy observed; the
    // leftmost is client-supplied and must not be trusted for rate limiting.
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("is not fooled by an attacker padding extra spoofed hops onto the header", () => {
    const spoofed = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9, 10.0.0.1",
      },
    });
    const direct = new Request("https://example.com", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    // Rotating every hop except the trusted one must resolve to the same key
    // as the trusted hop alone - otherwise an attacker can bypass a per-IP
    // limiter simply by varying the untrusted, client-controlled prefix.
    expect(getClientIp(spoofed)).toBe(getClientIp(direct));
  });

  it("trims whitespace around the trusted hop", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4 ,  10.0.0.1  " },
    });
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("https://example.com", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });

  it("falls back to 127.0.0.1 when no proxy headers are present", () => {
    const request = new Request("https://example.com");
    expect(getClientIp(request)).toBe("127.0.0.1");
  });

  it("ignores a blank x-forwarded-for value and falls back", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "  ", "x-real-ip": "198.51.100.7" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });
});
