import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

/**
 * Wave E / E6: historical daily rollups written before projectId joined the
 * groupKey formula must rehash (and merge) so new prune passes do not leave
 * permanent dual buckets for the same dimensions.
 */
describe("external daily rollup groupKey rehash (Wave E / E6)", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let computeExternalRollupGroupKey: typeof import("../data-retention").computeExternalRollupGroupKey;
  let rehashStaleExternalUsageEventDailyRollupGroupKeys: typeof import("../data-retention").rehashStaleExternalUsageEventDailyRollupGroupKeys;

  const day = new Date("2026-06-01T00:00:00.000Z");

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollup-rehash-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);
    ({ prisma } = await import("@/lib/prisma"));
    ({
      computeExternalRollupGroupKey,
      rehashStaleExternalUsageEventDailyRollupGroupKeys,
    } = await import("../data-retention"));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    await prisma.externalUsageEventDailyRollup.deleteMany();
  });

  function baseDims(projectId: string | null) {
    return {
      sourceApp: "socratic-trade",
      environment: "prod" as string | null,
      provider: "openai",
      service: "chat",
      label: null as string | null,
      keyRef: "k1",
      billingMode: "actual",
      metricType: "cost",
      unit: "usd",
      limitWindow: null as string | null,
      tier: null as string | null,
      confidence: "exact",
      projectId,
    };
  }

  it("rewrites a stale pre-projectId groupKey in place", async () => {
    const dims = baseDims(null);
    const correctKey = computeExternalRollupGroupKey(dims);
    await prisma.externalUsageEventDailyRollup.create({
      data: {
        day,
        groupKey: "stale-pre-project-hash",
        ...dims,
        eventCount: 3,
        pricedEventCount: 3,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 12.5,
        totalRequests: 3,
        totalQuantity: 0,
        totalCredits: 0,
        latestOccurredAt: day,
      },
    });

    const result = await rehashStaleExternalUsageEventDailyRollupGroupKeys({
      batchSize: 50,
      maxBatches: 2,
    });
    expect(result.scanned).toBe(1);
    expect(result.rewritten).toBe(1);
    expect(result.merged).toBe(0);

    const rows = await prisma.externalUsageEventDailyRollup.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupKey).toBe(correctKey);
    expect(rows[0]!.totalCostUsd).toBe(12.5);
  });

  it("merges a stale key into an existing canonical rollup without double rows", async () => {
    const dims = baseDims("proj-1");
    const correctKey = computeExternalRollupGroupKey(dims);

    await prisma.externalUsageEventDailyRollup.create({
      data: {
        day,
        groupKey: correctKey,
        ...dims,
        eventCount: 2,
        pricedEventCount: 2,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 10,
        totalRequests: 2,
        totalQuantity: 0,
        totalCredits: 0,
        latestOccurredAt: day,
      },
    });
    await prisma.externalUsageEventDailyRollup.create({
      data: {
        day,
        groupKey: "stale-duplicate-bucket",
        ...dims,
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 4,
        totalRequests: 1,
        totalQuantity: 0,
        totalCredits: 0,
        latestOccurredAt: new Date("2026-06-01T12:00:00.000Z"),
      },
    });

    const result = await rehashStaleExternalUsageEventDailyRollupGroupKeys({
      batchSize: 50,
      maxBatches: 2,
    });
    expect(result.merged).toBe(1);
    expect(result.rewritten).toBe(1);

    const rows = await prisma.externalUsageEventDailyRollup.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupKey).toBe(correctKey);
    expect(rows[0]!.eventCount).toBe(3);
    expect(rows[0]!.totalCostUsd).toBe(14);
  });
});
