import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startUsagePollingScheduler: vi.fn(),
}));

vi.mock("@/lib/usage-recorder", () => ({
  startUsagePollingScheduler: mocks.startUsagePollingScheduler,
}));

import { isUsageSchedulerEnabled, register } from "@/instrumentation";

describe("usage scheduler instrumentation", () => {
  beforeEach(() => {
    mocks.startUsagePollingScheduler.mockReset();
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

  it("does not start the Node scheduler in non-Node runtimes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "true");

    await register();

    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
  });
});
