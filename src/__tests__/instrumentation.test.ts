import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startUsagePollingScheduler: vi.fn(),
  applySqliteNativeMemoryPragmas: vi.fn().mockResolvedValue(undefined),
  computeBudgetStatus: vi.fn().mockResolvedValue({}),
  computeProjectBudgetStatus: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/usage-recorder", () => ({
  startUsagePollingScheduler: mocks.startUsagePollingScheduler,
}));

vi.mock("@/lib/prisma", () => ({
  applySqliteNativeMemoryPragmas: mocks.applySqliteNativeMemoryPragmas,
}));

vi.mock("@/lib/budget-status", () => ({
  computeBudgetStatus: mocks.computeBudgetStatus,
  computeProjectBudgetStatus: mocks.computeProjectBudgetStatus,
}));

import { isUsageSchedulerEnabled, register } from "@/instrumentation";

describe("usage scheduler instrumentation", () => {
  beforeEach(() => {
    mocks.startUsagePollingScheduler.mockReset();
    mocks.applySqliteNativeMemoryPragmas.mockClear();
    mocks.computeBudgetStatus.mockClear();
    mocks.computeBudgetStatus.mockResolvedValue({});
    mocks.computeProjectBudgetStatus.mockClear();
    mocks.computeProjectBudgetStatus.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  // Regression guard: register() must NOT warm the budget-status caches at
  // boot. A previous revision did (deferred setTimeout, warming both caches),
  // and it crash-looped production - warming computeProjectBudgetStatus runs
  // its internal Promise.all (computeBudgetStatus's ~336k-row groupBy AND the
  // attribution ~336k-row groupBy) concurrently, and two such aggregations at
  // once peaked past the 512MB instance limit and OOM-killed the box ~40-100s
  // into every boot. The SWR cache must stay lazily populated on first
  // request. Advancing timers here catches a re-introduced deferred warm-up,
  // not just a synchronous one.
  it("does not warm the budget-status caches at boot (OOM'd the 512MB instance)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "");

    await register();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.computeBudgetStatus).not.toHaveBeenCalled();
    expect(mocks.computeProjectBudgetStatus).not.toHaveBeenCalled();
  });
});
