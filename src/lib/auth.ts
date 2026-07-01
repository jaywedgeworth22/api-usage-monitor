import crypto, { timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "dashboard_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // seconds, 30 days

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyPassword(candidate: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD?.trim();
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

export function createSessionToken(): string {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) {
    throw new Error("DASHBOARD_PASSWORD environment variable is not set");
  }
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  const sig = crypto.createHmac("sha256", password).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiresAtRaw, sig] = parts;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) return false;

  const expectedSig = crypto.createHmac("sha256", password).update(String(expiresAt)).digest("hex");
  return safeEqual(sig, expectedSig);
}
