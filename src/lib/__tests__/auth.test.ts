import crypto from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionToken,
  verifyPassword,
  verifySessionToken,
} from "../auth";

const ORIGINAL_PASSWORD = process.env.DASHBOARD_PASSWORD;
const ORIGINAL_SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET;

function restoreEnv() {
  if (ORIGINAL_PASSWORD === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = ORIGINAL_PASSWORD;
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
  else process.env.DASHBOARD_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
}

afterEach(() => {
  restoreEnv();
});

describe("verifyPassword", () => {
  afterEach(() => restoreEnv());

  it("returns false when DASHBOARD_PASSWORD is not configured", () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(verifyPassword("anything")).toBe(false);
  });

  it("accepts the exact configured password and rejects others", () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    expect(verifyPassword("correct-horse-battery-staple")).toBe(true);
    expect(verifyPassword("wrong")).toBe(false);
  });
});

describe("createSessionToken / verifySessionToken", () => {
  afterEach(() => restoreEnv());

  it("throws when neither DASHBOARD_PASSWORD nor DASHBOARD_SESSION_SECRET is set", () => {
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.DASHBOARD_SESSION_SECRET;
    expect(() => createSessionToken()).toThrow();
  });

  it("round-trips: a freshly created token verifies successfully", () => {
    process.env.DASHBOARD_PASSWORD = "hunter2-hunter2";
    delete process.env.DASHBOARD_SESSION_SECRET;
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
  });

  it("rejects malformed tokens", () => {
    process.env.DASHBOARD_PASSWORD = "hunter2-hunter2";
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken(null)).toBe(false);
    expect(verifySessionToken("")).toBe(false);
    expect(verifySessionToken("no-dot-here")).toBe(false);
    expect(verifySessionToken("too.many.dots")).toBe(false);
    expect(verifySessionToken("not-a-number.deadbeef")).toBe(false);
  });

  it("rejects an expired token", () => {
    process.env.DASHBOARD_PASSWORD = "hunter2-hunter2";
    const expiresAt = Date.now() - 1000;
    const token = `${expiresAt}.deadbeef`;
    expect(verifySessionToken(token)).toBe(false);
  });

  it("rejects a token with a tampered signature", () => {
    process.env.DASHBOARD_PASSWORD = "hunter2-hunter2";
    const token = createSessionToken();
    const [expiresAt] = token.split(".");
    const tampered = `${expiresAt}.${"0".repeat(64)}`;
    expect(verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a token signed under a different DASHBOARD_PASSWORD", () => {
    process.env.DASHBOARD_PASSWORD = "password-one";
    delete process.env.DASHBOARD_SESSION_SECRET;
    const token = createSessionToken();

    process.env.DASHBOARD_PASSWORD = "password-two";
    expect(verifySessionToken(token)).toBe(false);
  });

  it("does not key the HMAC on the plaintext password directly", () => {
    // Regression guard for the fix: the token's signature must NOT match a
    // raw HMAC-SHA256 keyed on the plaintext DASHBOARD_PASSWORD, which is
    // what a stolen session token would let an attacker verify offline
    // against password guesses before this change (HKDF derivation).
    process.env.DASHBOARD_PASSWORD = "hunter2-hunter2";
    delete process.env.DASHBOARD_SESSION_SECRET;
    const token = createSessionToken();
    const [expiresAt, sig] = token.split(".");

    const naiveSig = crypto
      .createHmac("sha256", process.env.DASHBOARD_PASSWORD)
      .update(expiresAt)
      .digest("hex");

    expect(sig).not.toBe(naiveSig);
  });

  it("prefers DASHBOARD_SESSION_SECRET over DASHBOARD_PASSWORD when both are set", () => {
    process.env.DASHBOARD_PASSWORD = "the-login-password";
    process.env.DASHBOARD_SESSION_SECRET = "a-distinct-session-secret";
    const token = createSessionToken();

    // Changing the login password alone must not invalidate the session,
    // because signing now derives from DASHBOARD_SESSION_SECRET.
    process.env.DASHBOARD_PASSWORD = "a-different-login-password";
    expect(verifySessionToken(token)).toBe(true);

    // But changing the session secret must invalidate it.
    process.env.DASHBOARD_SESSION_SECRET = "a-different-session-secret";
    expect(verifySessionToken(token)).toBe(false);
  });
});
