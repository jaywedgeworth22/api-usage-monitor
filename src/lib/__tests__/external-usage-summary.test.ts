import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  externalUsageEvent: { findMany: vi.fn() },
  externalUsageEventDailyRollup: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { summarizeExternalUsageEvents } from "../external-usage-events";

describe("summarizeExternalUsageEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges each raw page directly into the summary and preserves rollup totals", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      id: `raw-${String(index).padStart(4, "0")}`,
      sourceApp: "socratic-trade",
      environment: "prod",
      provider: "openai",
      service: "responses",
      projectId: "project-a",
      metricType: "usage",
      unit: "token",
      quantity: 2,
      costUsd: 1,
      requests: 1,
      limit: 100,
      limitWindow: "month",
      occurredAt: new Date("2026-07-02T00:00:00.000Z"),
    }));
    const finalPage = [
      {
        ...firstPage[0],
        id: "raw-1000",
        occurredAt: new Date("2026-07-03T00:00:00.000Z"),
        limit: 150,
      },
      {
        ...firstPage[0],
        id: "raw-1001",
        occurredAt: new Date("2026-07-04T00:00:00.000Z"),
        limit: 200,
      },
    ];

    prismaMock.externalUsageEvent.findMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(finalPage);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([
      {
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "openai",
        service: "responses",
        projectId: "project-a",
        metricType: "usage",
        unit: "token",
        eventCount: 5,
        totalCostUsd: 5,
        totalRequests: 5,
        totalQuantity: 10,
        maxLimit: 90,
        limitWindow: "month",
        latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ]);

    const result = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: "raw-0999" }, skip: 1 })
    );
    expect(result).toEqual({
      eventCount: 1_007,
      groups: [
        expect.objectContaining({
          eventCount: 1_007,
          totalCostUsd: 1_007,
          totalRequests: 1_007,
          totalQuantity: 2_014,
          limit: 200,
          latestAt: "2026-07-04T00:00:00.000Z",
        }),
      ],
    });
  });

  it("keeps metric units in separate quota groups", async () => {
    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "tokens",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "openai",
        service: "responses",
        projectId: null,
        metricType: "usage",
        unit: "token",
        quantity: 10_000,
        costUsd: null,
        requests: 0,
        limit: 20_000,
        limitWindow: "month",
        occurredAt: new Date("2026-07-12T00:00:00.000Z"),
      },
      {
        id: "requests",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "openai",
        service: "responses",
        projectId: null,
        metricType: "usage",
        unit: "request",
        quantity: 0,
        costUsd: null,
        requests: 10,
        limit: 100,
        limitWindow: "month",
        occurredAt: new Date("2026-07-12T00:00:00.000Z"),
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);

    const result = await summarizeExternalUsageEvents(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(result.groups).toHaveLength(2);
    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: "token", totalQuantity: 10_000, limit: 20_000 }),
        expect.objectContaining({ unit: "request", totalRequests: 10, limit: 100 }),
      ])
    );
  });
});
