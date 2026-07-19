import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import * as helpers from "@/lib/adapters/helpers";

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let verifyOpenRouterGenerations: typeof import("../usage-maintenance").verifyOpenRouterGenerations;
let reconcileProviderUsage: typeof import("../usage-maintenance").reconcileProviderUsage;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPENROUTER_MANAGEMENT_KEY = "test-key";
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-reconciliation-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ verifyOpenRouterGenerations, reconcileProviderUsage } = await import("../usage-maintenance"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ENCRYPTION_KEY;
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
});

beforeEach(async () => {
  await prisma.providerUsageReconciliation.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
  vi.restoreAllMocks();
});

describe("verifyOpenRouterGenerations", () => {
  it("verifies and fails events based on API responses", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "openrouter",
        displayName: "OpenRouter",
        apiKey: "encryptedKey",
      },
    });

    const event1 = await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "key-1",
        sourceApp: "app-1",
        provider: "openrouter",
        keyRef: "gen-123",
        occurredAt: new Date(),
      },
    });

    const event2 = await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "key-2",
        sourceApp: "app-1",
        provider: "openrouter",
        keyRef: "gen-456",
        occurredAt: new Date(),
      },
    });

    const event3 = await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "key-3",
        sourceApp: "app-1",
        provider: "openrouter",
        keyRef: "not-gen",
        occurredAt: new Date(),
      },
    });

    const fetchJsonSpy = vi.spyOn(helpers, "fetchJson");
    fetchJsonSpy.mockImplementation(async (url) => {
      if (url.includes("gen-123")) {
        return {
          ok: true,
          status: 200,
          data: { data: { id: "gen-123", total_cost: 0.0001 } },
          headers: new Headers(),
        };
      }
      if (url.includes("gen-456")) {
        return {
          ok: false,
          status: 404,
          data: null,
          headers: new Headers(),
        };
      }
      return {
        ok: false,
        status: 500,
        data: null,
        headers: new Headers(),
      };
    });

    const verifiedCount = await verifyOpenRouterGenerations();
    expect(verifiedCount).toBe(1);

    const stored1 = await prisma.externalUsageEvent.findUniqueOrThrow({ where: { id: event1.id } });
    expect(stored1.verificationStatus).toBe("verified");

    const stored2 = await prisma.externalUsageEvent.findUniqueOrThrow({ where: { id: event2.id } });
    expect(stored2.verificationStatus).toBe("failed");

    const stored3 = await prisma.externalUsageEvent.findUniqueOrThrow({ where: { id: event3.id } });
    expect(stored3.verificationStatus).toBeNull(); // Skipped because it doesn't start with gen-
  });
});

describe("reconcileProviderUsage", () => {
  it("reconciles usage and detects discrepancies", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "verifiable-provider",
        displayName: "Verifiable Provider",
      },
    });

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Create snapshot in current month
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: now,
        totalCost: 100.0,
      },
    });

    // Create local usage event in current month
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "evt-1",
        sourceApp: "app-1",
        provider: "verifiable-provider",
        costUsd: 95.0,
        occurredAt: now,
      },
    });

    // Reconcile
    const count = await reconcileProviderUsage();
    expect(count).toBe(1);

    const reconciliation = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });

    expect(reconciliation.verifiedCostUsd).toBe(100.0);
    expect(reconciliation.reportedCostUsd).toBe(95.0);
    expect(reconciliation.deltaUsd).toBe(5.0);
    expect(reconciliation.status).toBe("discrepancy");
  });

  it("marks as ok if discrepancy is within threshold", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "verifiable-provider-2",
        displayName: "Verifiable Provider 2",
      },
    });

    const now = new Date();

    // Create snapshot in current month
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: now,
        totalCost: 10.005,
      },
    });

    // Create local usage event in current month
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "evt-2",
        sourceApp: "app-1",
        provider: "verifiable-provider-2",
        costUsd: 10.01,
        occurredAt: now,
      },
    });

    await reconcileProviderUsage();

    const reconciliation = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });

    expect(reconciliation.status).toBe("ok"); // |10.005 - 10.01| = 0.005 <= 0.01
  });
});
