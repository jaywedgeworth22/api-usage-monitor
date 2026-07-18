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

  // Regression coverage for the boot-starves-the-single-connection bug: the
  // budget-status warm-up used to fire computeBudgetStatus() synchronously
  // (unawaited) from inside register(), so its ~11s cold compute could hold
  // the one pooled DB connection (connection_limit=1) while Next.js was
  // still starting, starving a real request that landed in that window.
  it("defers warming the budget-status caches instead of firing them synchronously from register()", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "");

    await register();

    // register() must resolve before the warm-up fires, so it never delays
    // (or, on a slow/failing DB, blocks) server readiness.
    expect(mocks.computeBudgetStatus).not.toHaveBeenCalled();
    expect(mocks.computeProjectBudgetStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    // Warms BOTH caches - GET /api/providers reads computeBudgetStatus
    // directly, while GET /api/projects and GET /api/budget-status read only
    // computeProjectBudgetStatus.
    expect(mocks.computeBudgetStatus).toHaveBeenCalledOnce();
    expect(mocks.computeProjectBudgetStatus).toHaveBeenCalledOnce();
  });

  it("warns but never crashes boot when the deferred warm-up fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.computeBudgetStatus.mockRejectedValueOnce(new Error("simulated warm-up failure"));

    await expect(register()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(warning).toHaveBeenCalledWith(
      "[budget-status-cache] boot warm-up failed",
      expect.any(Error)
    );
    // The project cache's own warm-up is independent and must still run.
    expect(mocks.computeProjectBudgetStatus).toHaveBeenCalledOnce();
  });
});
