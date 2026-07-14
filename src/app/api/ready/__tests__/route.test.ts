import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markSchedulerStarted,
  markSchedulerTickCompleted,
  resetRuntimeHealthForTests,
} from "@/lib/runtime-health";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
}));

import { GET, resetReadinessStateForTests } from "../route";

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeHealthForTests();
    resetReadinessStateForTests();
    mocks.queryRawUnsafe.mockReset();
    mocks.queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns ready only after the scheduler starts and SQLite responds", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-readiness-status")).toBe("ready");
    expect(body).toMatchObject({
      ok: true,
      status: "ready",
      checks: {
        database: { ok: true },
        scheduler: { ok: true },
        backup: { ok: true, required: false, active: false },
        startup: { ok: true, required: false, active: false },
      },
    });
  });

  it("keeps HTTP liveness-safe while reporting SQLite unavailable", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-readiness-status")).toBe("not_ready");
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: {
          ok: false,
          cached: false,
          probeInFlight: false,
        },
      },
    });
  });

  it("backs off failed SQLite probes and retries after the failure window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const firstResponse = await GET();
    const firstBody = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(firstBody.checks.database).toMatchObject({
      ok: false,
      cached: false,
      checkedAt: "2026-07-14T09:00:00.000Z",
      retryAfter: "2026-07-14T09:01:00.000Z",
      probeInFlight: false,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const cachedResponse = await GET();
    const cachedBody = await cachedResponse.json();
    expect(cachedResponse.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(cachedBody.checks.database).toMatchObject({
      ok: false,
      cached: true,
      checkedAt: "2026-07-14T09:00:00.000Z",
      retryAfter: "2026-07-14T09:01:00.000Z",
      probeInFlight: false,
    });

    mocks.queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);
    await vi.advanceTimersByTimeAsync(55_000);
    const retriedResponse = await GET();
    const retriedBody = await retriedResponse.json();
    expect(retriedResponse.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(retriedBody.checks.database).toMatchObject({
      ok: true,
      cached: false,
      checkedAt: "2026-07-14T09:01:00.000Z",
      retryAfter: null,
      probeInFlight: false,
    });
  });

  it("reports starting over HTTP 200 during a bounded database-only cold start", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(30);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database still opening"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "starting",
      checks: {
        database: { ok: false, coldStartGraceActive: true },
      },
    });
  });

  it("never re-enters cold-start grace after the first successful database probe", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(30);
    expect((await GET()).status).toBe(200);

    mocks.queryRawUnsafe.mockRejectedValue(new Error("database became unavailable"));
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: { ok: false, coldStartGraceActive: false },
      },
    });
  });

  it("reports not-ready after cold-start grace without failing HTTP liveness", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: { ok: false, coldStartGraceActive: false },
      },
    });
  });

  it("reuses a timed-out SQLite probe instead of queueing more uncancelled queries", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "uptime").mockReturnValue(301);
    let finishProbe: ((value: Array<Record<string, number>>) => void) | undefined;
    mocks.queryRawUnsafe.mockReturnValue(
      new Promise<Array<Record<string, number>>>((resolve) => {
        finishProbe = resolve;
      })
    );

    try {
      const firstRequest = GET();
      await vi.advanceTimersByTimeAsync(2_000);
      const firstResponse = await firstRequest;
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toMatchObject({
        status: "not_ready",
        checks: {
          database: {
            ok: false,
            cached: false,
            probeInFlight: true,
          },
        },
      });
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);

      const secondRequest = GET();
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);

      finishProbe?.([{ "1": 1 }]);
      expect((await secondRequest).status).toBe(200);
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays ready after one transient scheduler failure", async () => {
    markSchedulerTickCompleted(false, null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: null,
      consecutiveFailures: 1,
    });
  });

  it("reports scheduler not-ready without failing HTTP liveness", async () => {
    markSchedulerTickCompleted(false, null);
    markSchedulerTickCompleted(false, null);
    markSchedulerTickCompleted(false, null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "not_ready" });
    expect(body.checks.scheduler).toMatchObject({
      ok: false,
      readinessReason: "repeated_tick_failures",
      consecutiveFailures: 3,
    });
  });

  it("reports backup not-ready without failing HTTP liveness", async () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "false");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "not_ready" });
    expect(body.checks.backup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });

  it("reports startup not-ready without failing HTTP liveness", async () => {
    vi.stubEnv("RENDER", "true");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "not_ready" });
    expect(body.checks.startup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });
});
