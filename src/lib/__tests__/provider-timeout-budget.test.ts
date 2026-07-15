import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies that fetchAllDueProviders enforces a per-provider time budget: a
// single hung provider is counted as a failure (with a "timed out after Nms"
// error) and the sequential loop continues to the next provider instead of
// stalling the whole poll pass.
//
// prisma and the adapter layer are mocked so no DB or network is touched, and
// the per-provider timeout is driven with Vitest fake timers so nothing waits
// the real 90s budget.

const findMany = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const fetchProviderUsage = vi.fn();
const runUsageMaintenance = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: { findMany: () => findMany(), create: vi.fn() },
    usageSnapshot: {
      create: (args: unknown) => create(args),
      findFirst: (args: unknown) => findFirst(args),
    },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({ usageSnapshot: { create: (args: unknown) => create(args) } }),
  },
}));

vi.mock("@/lib/adapters", () => ({
  fetchProviderUsage: (provider: unknown) => fetchProviderUsage(provider),
}));

vi.mock("@/lib/usage-maintenance", () => ({
  runUsageMaintenance: () => runUsageMaintenance(),
  isUsageMaintenanceHealthy: (result: {
    alerts: { deferredError: unknown; persistenceDegraded: unknown[] };
  }) =>
    result.alerts.deferredError === null &&
    result.alerts.persistenceDegraded.length === 0,
}));

function providerRow(name: string) {
  return {
    id: `id-${name}`,
    name,
    refreshIntervalMin: 60,
    // no prior snapshots => always "due"
    snapshots: [],
  };
}

describe("fetchAllDueProviders per-provider timeout budget", () => {
  beforeEach(() => {
    vi.resetModules();
    findMany.mockReset();
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
    create.mockReset();
    fetchProviderUsage.mockReset();
    runUsageMaintenance.mockReset();
    process.env.ADAPTER_PROVIDER_TIMEOUT_MS = "5000";
    create.mockResolvedValue({ id: "snap" });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ADAPTER_PROVIDER_TIMEOUT_MS;
  });

  it("counts a hung provider as a timeout failure and still processes the others", async () => {
    vi.useFakeTimers();
    findMany.mockResolvedValue([providerRow("fast"), providerRow("hung")]);

    // "fast" resolves immediately; "hung" never resolves so the 5s budget wins.
    fetchProviderUsage.mockImplementation((provider: { name: string }) => {
      if (provider.name === "hung") {
        return new Promise(() => {
          /* never resolves */
        });
      }
      return Promise.resolve({
        balance: 1,
        totalCost: null,
        totalRequests: null,
        credits: null,
        rawData: {},
      });
    });

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const promise = fetchAllDueProviders();
    // Let the "fast" provider settle, then blow past the 5s budget for "hung".
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.total).toBe(2);
    expect(result.successes).toBe(1);
    expect(result.failures).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("hung");
    expect(result.errors[0].error).toBe("Provider hung timed out after 5000ms");
    expect(result.errors[0]).toMatchObject({
      code: "TIMEOUT",
      status: null,
      retryable: true,
    });
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      "success",
      "failure",
    ]);
  });

  it("classifies an intentionally unsupported push-only poll as skipped", async () => {
    findMany.mockResolvedValue([providerRow("push-only")]);
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage.mockRejectedValue(
      new AdapterError("Use pushed telemetry or a manual plan.", {
        code: "UNSUPPORTED",
      })
    );

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 0,
      failures: 0,
      skipped: 1,
      errors: [],
    });
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        name: "push-only",
        status: "skipped",
        errorCode: "UNSUPPORTED",
      }),
    ]);
  });

  it("rolls back a late result after a newer attempt supersedes it", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    fetchProviderUsage
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; })
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSecond = resolve; })
      );
    const usage = {
      balance: 1,
      totalCost: 10,
      totalRequests: 1,
      credits: null,
      rawData: {},
    };
    const { recordProviderUsage } = await import("@/lib/usage-recorder");
    const provider = providerRow("race");
    const first = recordProviderUsage(provider as never);
    const second = recordProviderUsage(provider as never);

    resolveSecond?.(usage);
    await expect(second).resolves.toEqual({ id: "snap" });
    resolveFirst?.({ ...usage, totalCost: 999 });
    await expect(first).rejects.toMatchObject({ code: "SUPERSEDED" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalCost: 10 }),
      })
    );
  });

  it("marks a completed scheduler tick unhealthy when alert bookkeeping is deferred", async () => {
    const markTickStarted = vi.fn();
    const markTickCompleted = vi.fn();
    const fetchProviders = vi.fn(async () => ({
      total: 2,
      successes: 1,
      failures: 1,
      skipped: 0,
      errors: [],
      outcomes: [],
    }));
    const runMaintenance = vi.fn(async () => ({
      subscriptions: { examined: 0, charged: 0, eventsWritten: 0 },
      providerRenewals: { examined: 0, advanced: 0 },
      retention: { skipped: true as const, reason: "interval" as const },
      alerts: {
        evaluatedProviders: 2,
        activeAlerts: 1,
        sent: 1,
        resolved: 0,
        skipped: 0,
        errors: [],
        persistenceDegraded: [],
        deferredError: {
          stage: "alerts" as const,
          operation: "post_send_notification_summary" as const,
          code: "P1008" as const,
          model: "ProviderAlertNotification" as const,
          message: "busy",
        },
      },
    }));
    const { runUsagePollingSchedulerTick } = await import("@/lib/usage-recorder");

    await runUsagePollingSchedulerTick({
      fetchProviders,
      runMaintenance,
      markTickStarted,
      markTickCompleted,
    });

    expect(markTickStarted).toHaveBeenCalledOnce();
    expect(markTickCompleted).toHaveBeenCalledWith(false, {
      total: 2,
      successes: 1,
      failures: 1,
      skipped: 0,
    });
  });

  it("marks a completed scheduler tick unhealthy on channel-state persistence degradation", async () => {
    const markTickStarted = vi.fn();
    const markTickCompleted = vi.fn();
    const fetchProviders = vi.fn(async () => ({
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
      errors: [],
      outcomes: [],
    }));
    const runMaintenance = vi.fn(async () => ({
      subscriptions: { examined: 0, charged: 0, eventsWritten: 0 },
      providerRenewals: { examined: 0, advanced: 0 },
      retention: { skipped: true as const, reason: "interval" as const },
      alerts: {
        evaluatedProviders: 1,
        activeAlerts: 1,
        sent: 0,
        resolved: 0,
        skipped: 0,
        errors: [],
        persistenceDegraded: [
          {
            stage: "channel_state" as const,
            operation: "trigger_success_outcome" as const,
            code: "P1008" as const,
            model: "ProviderAlertChannelDelivery" as const,
            providerId: "id-one",
            alertCode: "balance_low",
            channel: "webhook" as const,
            message: "busy",
          },
        ],
        deferredError: null,
      },
    }));
    const { runUsagePollingSchedulerTick } = await import("@/lib/usage-recorder");

    await runUsagePollingSchedulerTick({
      fetchProviders,
      runMaintenance,
      markTickStarted,
      markTickCompleted,
    });

    expect(markTickCompleted).toHaveBeenCalledWith(false, {
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
    });
  });

  it("persists a safe partial snapshot before surfacing postPersistError", async () => {
    const { AdapterError } = await import("@/lib/adapters/helpers");
    const postPersistError = new AdapterError(
      "Billing sync failed: secret-that-must-not-persist",
      {
        code: "HTTP_ERROR",
        status: 503,
        retryable: true,
      }
    );
    fetchProviderUsage.mockResolvedValue({
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: 90,
      rawData: {
        keyValidation: { outcome: "valid", status: 200 },
        billing: { configured: true, status: "error" },
      },
      postPersistError,
    });

    const { recordProviderUsage } = await import("@/lib/usage-recorder");

    await expect(
      recordProviderUsage(providerRow("partial") as never)
    ).rejects.toBe(postPersistError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerId: "id-partial",
          totalCost: null,
          credits: 90,
          rawData: expect.objectContaining({
            keyValidation: { outcome: "valid", status: 200 },
            billing: { configured: true, status: "error" },
            __apiUsageMonitor: {
              version: 1,
              partialFailure: {
                code: "HTTP_ERROR",
                status: 503,
                retryable: true,
              },
            },
          }),
        }),
      })
    );
    const persistedRawData = create.mock.calls[0]?.[0]?.data?.rawData;
    expect(JSON.stringify(persistedRawData)).not.toContain(
      "secret-that-must-not-persist"
    );
    expect(JSON.stringify(persistedRawData)).not.toContain("Billing sync failed");
  });

  it("retries a fresh retryable partial snapshot on the next scheduler tick", async () => {
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage.mockResolvedValueOnce({
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: 90,
      rawData: { billing: { configured: true, status: "error" } },
      postPersistError: new AdapterError("Temporary billing outage", {
        code: "HTTP_ERROR",
        status: 503,
        retryable: true,
      }),
    });

    const { fetchAllDueProviders, recordProviderUsage } = await import(
      "@/lib/usage-recorder"
    );
    await expect(
      recordProviderUsage(providerRow("partial-retry") as never)
    ).rejects.toMatchObject({ code: "HTTP_ERROR", retryable: true });

    const firstWrite = create.mock.calls[0]?.[0]?.data;
    findMany.mockResolvedValue([
      {
        ...providerRow("partial-retry"),
        snapshots: [
          {
            fetchedAt: new Date(firstWrite.fetchedAt.getTime() + 1_000),
            rawData: null,
          },
        ],
      },
    ]);
    findFirst.mockResolvedValueOnce({
      fetchedAt: firstWrite.fetchedAt,
      rawData: firstWrite.rawData,
    });
    fetchProviderUsage.mockResolvedValueOnce({
      balance: 1,
      totalCost: 2,
      totalRequests: 3,
      credits: 4,
      rawData: {},
    });
    create.mockClear();

    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
    });
    expect(fetchProviderUsage).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        providerId: "id-partial-retry",
        rawData: { not: expect.anything() },
      },
      orderBy: { fetchedAt: "desc" },
      select: { fetchedAt: true, rawData: true },
    });
  });

  it("does not let a fresh pushed snapshot hide a stale poll", async () => {
    const now = new Date();
    findMany.mockResolvedValue([
      {
        ...providerRow("stale-poll"),
        snapshots: [{ fetchedAt: now, rawData: null }],
      },
    ]);
    findFirst.mockResolvedValueOnce({
      fetchedAt: new Date(now.getTime() - 61 * 60 * 1000),
      rawData: { providerPoll: "complete" },
    });
    fetchProviderUsage.mockResolvedValueOnce({
      balance: 1,
      totalCost: 2,
      totalRequests: 3,
      credits: 4,
      rawData: {},
    });

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
    });
    expect(fetchProviderUsage).toHaveBeenCalledOnce();
  });

  it("uses a fresh poll behind a pushed snapshot for interval skipping", async () => {
    const now = new Date();
    findMany.mockResolvedValue([
      {
        ...providerRow("fresh-poll"),
        snapshots: [{ fetchedAt: now, rawData: null }],
      },
    ]);
    findFirst.mockResolvedValueOnce({
      fetchedAt: new Date(now.getTime() - 30 * 60 * 1000),
      rawData: { providerPoll: "complete" },
    });

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 0,
      failures: 0,
      skipped: 1,
    });
    expect(fetchProviderUsage).not.toHaveBeenCalled();
  });

  it("respects the normal interval after a nonretryable partial snapshot", async () => {
    findMany.mockResolvedValue([
      {
        ...providerRow("partial-terminal"),
        snapshots: [
          {
            fetchedAt: new Date(),
            rawData: {
              __apiUsageMonitor: {
                version: 1,
                partialFailure: {
                  code: "HTTP_ERROR",
                  status: 404,
                  retryable: false,
                },
              },
            },
          },
        ],
      },
    ]);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 0,
      failures: 0,
      skipped: 1,
    });
    expect(fetchProviderUsage).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("strips adapter-supplied retry metadata instead of trusting it", async () => {
    fetchProviderUsage.mockResolvedValue({
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      rawData: {
        providerField: "preserved",
        __apiUsageMonitor: {
          version: 1,
          partialFailure: {
            code: "HTTP_ERROR",
            status: 503,
            retryable: true,
          },
        },
      },
    });

    const { recordProviderUsage } = await import("@/lib/usage-recorder");
    await recordProviderUsage(providerRow("spoof") as never);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawData: { providerField: "preserved" },
        }),
      })
    );
  });
});
