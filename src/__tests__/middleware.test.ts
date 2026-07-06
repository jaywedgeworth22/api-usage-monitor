import { describe, expect, it } from "vitest";
import { config } from "@/middleware";

// The session-cookie middleware only runs on paths its `config.matcher`
// selects. Next.js compiles that matcher (a single negative-lookahead string)
// to decide inclusion; here we reproduce the exclusion semantics the matcher
// encodes — anchor the exported pattern and test membership, exactly the way
// the middleware comment reasons about `(?:/|$)` segment anchoring.
//
// matched === true  -> middleware runs   -> request is session-cookie gated
// matched === false -> middleware skipped -> the route's OWN token check governs
function isSessionGated(pathname: string): boolean {
  expect(config.matcher).toHaveLength(1);
  const pattern = config.matcher[0];
  return new RegExp(`^${pattern}$`).test(pathname);
}

describe("middleware matcher — /api/budget-status exclusion (regression for the prod 401 bug)", () => {
  it("does NOT session-gate /api/budget-status, so the route's own token check runs", () => {
    // Regression: the matcher used to lack this exclusion, so the session gate
    // 401'd every bearer-token request from sibling apps before the route's
    // USAGE_READ_TOKEN/USAGE_INGEST_TOKEN check could authenticate it.
    expect(isSessionGated("/api/budget-status")).toBe(false);
    expect(isSessionGated("/api/budget-status/")).toBe(false);
    expect(isSessionGated("/api/budget-status/anything")).toBe(false);
  });

  it("still session-gates prefix-collision paths (anchoring holds)", () => {
    // `(?:/|$)` anchoring must not leak the exclusion to merely-prefixed paths.
    expect(isSessionGated("/api/budget-status-foo")).toBe(true);
    expect(isSessionGated("/api/budget-statusfoo")).toBe(true);
  });

  it("preserves the existing self-authenticating exclusions", () => {
    for (const p of [
      "/api/ingest",
      "/api/ingest/usage",
      "/api/otlp",
      "/api/otlp/v1/metrics",
      "/api/health",
      "/api/cron",
      "/api/auth/login",
    ]) {
      expect(isSessionGated(p)).toBe(false);
    }
  });

  it("still session-gates ordinary dashboard/API routes and prefix collisions of other exclusions", () => {
    for (const p of [
      "/",
      "/dashboard",
      "/api/providers",
      "/api/budget-status-report", // not the excluded segment
      "/api/ingestor", // prefix of api/ingest, must stay gated
      "/api/healthz", // prefix of api/health, must stay gated
    ]) {
      expect(isSessionGated(p)).toBe(true);
    }
  });
});
