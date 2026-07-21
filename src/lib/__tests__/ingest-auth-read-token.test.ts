import { describe, expect, it } from "vitest";
import { resolveUsageReadToken } from "@/lib/ingest-auth";

describe("resolveUsageReadToken (C10)", () => {
  it("prefers USAGE_READ_TOKEN when set", () => {
    expect(
      resolveUsageReadToken({
        USAGE_READ_TOKEN: "read-secret",
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toBe("read-secret");
  });

  it("denies ingest fallback in production by default", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toBeUndefined();
  });

  it("allows ingest fallback outside production", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toBe("ingest-secret");
  });

  it("allows explicit production fallback opt-in", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
        USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK: "true",
      } as NodeJS.ProcessEnv)
    ).toBe("ingest-secret");
  });
});
