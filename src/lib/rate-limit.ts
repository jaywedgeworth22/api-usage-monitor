/**
 * Simple in-memory rate limiter with automatic entry cleanup.
 *
 * Uses a Map to track request counts per key (e.g., IP address) within a
 * sliding window. Old entries are purged on every check to prevent memory
 * leaks - no external dependencies required.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

export interface RateLimiter {
  /**
   * Returns true if the request should be allowed, false if rate-limited.
   * Calling this also increments the counter for `key`.
   */
  check(key: string): boolean;
}

/**
 * Creates a rate limiter that allows at most `maxRequests` per `windowMs`
 * window per distinct key.
 *
 * @param windowMs  Duration of the rate-limit window in milliseconds.
 * @param maxRequests  Maximum number of requests allowed per key in the window.
 */
export function createRateLimiter(
  windowMs: number,
  maxRequests: number
): RateLimiter {
  const store = new Map<string, RateLimitEntry>();

  // Purge expired entries. Called inline on every check so we never need a
  // background timer - the cleanup cost is just iterating the Map, which is
  // fine for the request volumes this app handles.
  function purgeExpired(now: number): void {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) {
        store.delete(key);
      }
    }
  }

  return {
    check(key: string): boolean {
      const now = Date.now();

      // Clean up old entries first
      purgeExpired(now);

      const existing = store.get(key);

      if (!existing || now >= existing.resetAt) {
        // First request in this window (or window expired)
        store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      if (existing.count < maxRequests) {
        existing.count += 1;
        return true;
      }

      // Rate limit exceeded
      return false;
    },
  };
}

/**
 * Extracts the client IP from a Next.js request, checking common proxy headers.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "127.0.0.1"
  );
}
