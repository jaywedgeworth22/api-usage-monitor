import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let deliverProviderAlerts: typeof import("../alert-delivery").deliverProviderAlerts;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-delivery-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ deliverProviderAlerts } = await import("../alert-delivery"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.providerAlertNotification.deleteMany();
  await prisma.externalUsageEventTombstone.deleteMany();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshotDailyRollup.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

describe("alert delivery", () => {
  it("sends one alert, suppresses reminders until due, and resolves cleared alerts", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "twilio",
        displayName: "Twilio",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: {
            billingMode: "actual",
            lowBalanceUsd: 10,
          },
        },
      },
    });

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
        balance: 5,
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/webhook" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(first.sent).toBe(1);
    expect(first.activeAlerts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const notifications = await prisma.providerAlertNotification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].sendCount).toBe(1);
    expect(notifications[0].resolvedAt).toBeNull();

    const second = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T14:00:00.000Z"),
        balance: 25,
      },
    });

    const third = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:30:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(third.resolved).toBe(1);

    const resolved = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(resolved.resolvedAt).not.toBeNull();
  });
});
