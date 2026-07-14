import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const externalUsageMocks = vi.hoisted(() => ({
  persist: vi.fn(),
  syncStatus: vi.fn(),
}));
const resolveProjects = vi.hoisted(() => vi.fn());

vi.mock("@/lib/external-usage-events", () => ({
  ExternalUsageIdempotencyCollisionError: class extends Error {},
  persistExternalUsageEvents: externalUsageMocks.persist,
  syncStatusToUsageSnapshot: externalUsageMocks.syncStatus,
}));
vi.mock("@/lib/project-resolver", () => ({
  resolveProjectIdsByName: resolveProjects,
}));

import { POST } from "../route";
import { tryAcquireIngestAdmission } from "@/lib/ingest-admission";

let ipCounter = 0;
function request(): NextRequest {
  ipCounter += 1;
  return new NextRequest("https://usage.jays.services/api/ingest/usage", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "x-forwarded-for": `10.1.0.${ipCounter}`,
    },
    body: JSON.stringify({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "cost",
      costUsd: 0,
      occurredAt: "2026-07-14T00:00:00.000Z",
      idempotencyKey: "admission-test-event",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("USAGE_INGEST_TOKEN", "test-token");
  resolveProjects.mockResolvedValue(new Map());
  externalUsageMocks.persist.mockResolvedValue({
    persisted: 1,
    skippedPrunedDuplicates: 0,
    newEvents: [],
  });
  externalUsageMocks.syncStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ingest/usage admission", () => {
  it("rejects an overlapping writer before any database helper runs", async () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    try {
      const response = await POST(request());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(resolveProjects).not.toHaveBeenCalled();
      expect(externalUsageMocks.persist).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("releases admission after a successful ingest", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("releases admission when persistence throws", async () => {
    externalUsageMocks.persist.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(POST(request())).rejects.toThrow("database unavailable");

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });
});
