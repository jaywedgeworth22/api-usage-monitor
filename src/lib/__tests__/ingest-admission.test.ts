import { describe, expect, it } from "vitest";
import {
  isOtlpMetricsIngestEnabled,
  tryAcquireIngestAdmission,
} from "../ingest-admission";

describe("ingest admission", () => {
  it("keeps OTLP metrics enabled unless explicitly set to false", () => {
    expect(isOtlpMetricsIngestEnabled(undefined)).toBe(true);
    expect(isOtlpMetricsIngestEnabled("")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("true")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("0")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("  FaLsE  ")).toBe(false);
  });

  it("admits one writer and rejects overlap until it releases", () => {
    const releaseFirst = tryAcquireIngestAdmission();
    expect(releaseFirst).not.toBeNull();
    expect(tryAcquireIngestAdmission()).toBeNull();

    releaseFirst?.();
    const releaseSecond = tryAcquireIngestAdmission();
    expect(releaseSecond).not.toBeNull();
    releaseSecond?.();
  });

  it("makes release idempotent without releasing a later owner", () => {
    const releaseFirst = tryAcquireIngestAdmission();
    expect(releaseFirst).not.toBeNull();
    releaseFirst?.();

    const releaseSecond = tryAcquireIngestAdmission();
    expect(releaseSecond).not.toBeNull();
    releaseFirst?.();
    expect(tryAcquireIngestAdmission()).toBeNull();
    releaseSecond?.();
  });
});
