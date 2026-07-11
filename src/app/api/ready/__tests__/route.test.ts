import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markSchedulerStarted,
  resetRuntimeHealthForTests,
} from "@/lib/runtime-health";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
}));

import { GET } from "../route";

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeHealthForTests();
    mocks.queryRawUnsafe.mockReset();
    mocks.queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
  });

  it("returns ready only after the scheduler starts and SQLite responds", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
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

  it("returns 503 when SQLite is unavailable", async () => {
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.database.ok).toBe(false);
  });

  it("returns 503 when backup is required but not active", async () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "false");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.backup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });

  it("returns 503 on Render when the configured startup wrapper was bypassed", async () => {
    vi.stubEnv("RENDER", "true");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.startup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });
});
