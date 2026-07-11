import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBackupRuntimeStatus,
  getRuntimeIdentity,
  getSchedulerRuntimeStatus,
  getStartupRuntimeStatus,
  markSchedulerStarted,
  markSchedulerTickCompleted,
  markSchedulerTickStarted,
  resetRuntimeHealthForTests,
} from "../runtime-health";

describe("runtime health state", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeHealthForTests();
  });

  it("records scheduler lifecycle without exposing adapter errors", () => {
    const startedAt = new Date("2026-07-11T12:00:00.000Z");
    const tickAt = new Date("2026-07-11T12:01:00.000Z");
    const completedAt = new Date("2026-07-11T12:01:05.000Z");

    markSchedulerStarted(startedAt);
    markSchedulerTickStarted(tickAt);
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      startedAt: startedAt.toISOString(),
      tickInProgress: true,
      lastTickStartedAt: tickAt.toISOString(),
    });

    markSchedulerTickCompleted(
      true,
      { total: 4, successes: 2, failures: 1, skipped: 1 },
      completedAt
    );
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      tickInProgress: false,
      lastTickCompletedAt: completedAt.toISOString(),
      lastTickSucceeded: true,
      lastRun: { total: 4, successes: 2, failures: 1, skipped: 1 },
    });
  });

  it("reports release identity and backup enforcement from non-secret env", () => {
    vi.stubEnv("RENDER_SERVICE_NAME", "usage-prod");
    vi.stubEnv("RENDER_GIT_COMMIT", "abc123");
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");

    expect(getRuntimeIdentity()).toMatchObject({
      service: "usage-prod",
      revision: "abc123",
    });
    expect(getBackupRuntimeStatus()).toEqual({ required: true, active: true });
    expect(getStartupRuntimeStatus()).toEqual({
      required: false,
      active: false,
      entrypoint: null,
    });
  });
});
