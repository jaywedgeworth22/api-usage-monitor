import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startUsagePollingScheduler: vi.fn(),
  applySqliteNativeMemoryPragmas: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/usage-recorder", () => ({
  startUsagePollingScheduler: mocks.startUsagePollingScheduler,
}));

vi.mock("@/lib/prisma", () => ({
  applySqliteNativeMemoryPragmas: mocks.applySqliteNativeMemoryPragmas,
}));

import { isUsageSchedulerEnabled, register } from "@/instrumentation";

describe("usage scheduler instrumentation", () => {
  beforeEach(() => {
    mocks.startUsagePollingScheduler.mockReset();
    mocks.applySqliteNativeMemoryPragmas.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults the scheduler on and recognizes only an explicit false value", () => {
    expect(isUsageSchedulerEnabled(undefined)).toBe(true);
    expect(isUsageSchedulerEnabled("")).toBe(true);
    expect(isUsageSchedulerEnabled("true")).toBe(true);
    expect(isUsageSchedulerEnabled(" FALSE ")).toBe(false);
  });

  it("starts polling in the Node runtime by default", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "");

    await register();

    expect(mocks.startUsagePollingScheduler).toHaveBeenCalledOnce();
  });

  it("bounds native SQLite memory before deciding whether polling is enabled", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    // Applied even on the emergency-disabled path: HTTP requests still use
    // Prisma whether or not the polling scheduler itself is running.
    expect(mocks.applySqliteNativeMemoryPragmas).toHaveBeenCalledOnce();
  });

  it("does not import or start polling when the emergency gate is false", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
  });

  it("does not start the Node scheduler or touch SQLite in non-Node runtimes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "true");

    await register();

    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
    expect(mocks.applySqliteNativeMemoryPragmas).not.toHaveBeenCalled();
  });
});
