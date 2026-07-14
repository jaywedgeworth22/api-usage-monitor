import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let deliverProviderAlerts: typeof import("../alert-delivery").deliverProviderAlerts;
let AlertNotificationSummaryPersistenceTimeout: typeof import("../alert-delivery").AlertNotificationSummaryPersistenceTimeout;
let encrypt: typeof import("@/lib/crypto").encrypt;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-delivery-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ encrypt } = await import("@/lib/crypto"));
  ({ deliverProviderAlerts, AlertNotificationSummaryPersistenceTimeout } = await import(
    "../alert-delivery"
  ));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
  delete process.env.ENCRYPTION_KEY;
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.providerAlertChannelDelivery.deleteMany();
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

  it("persists channel success before a notification-summary timeout so the next cycle does not resend", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "summary-timeout",
        displayName: "Summary Timeout",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/summary-timeout" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };
    const notificationDelegate = new Proxy(prisma.providerAlertNotification, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args: Parameters<typeof prisma.providerAlertNotification.updateMany>[0]) => {
            if ("lastSentAt" in args.data) {
              throw Object.assign(new Error("SQLite socket timeout"), {
                code: "P1008",
                meta: { modelName: "ProviderAlertNotification" },
              });
            }
            return prisma.providerAlertNotification.updateMany(args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const db = {
      provider: prisma.provider,
      providerAlertNotification: notificationDelegate,
      providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
    } as unknown as AlertDb;

    const failure = await deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
        db,
      })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AlertNotificationSummaryPersistenceTimeout);
    expect(failure).toMatchObject({
      code: "P1008",
      model: "ProviderAlertNotification",
      operation: "post_send_notification_summary",
      partialResult: {
        evaluatedProviders: 1,
        activeAlerts: 1,
        sent: 1,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const channelState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(channelState.lastSucceededAt).toEqual(new Date("2026-07-20T12:00:00.000Z"));
    expect(notification.lastSentAt).toBeNull();
    expect(notification.sendCount).toBe(0);

    const next = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(next.skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const repaired = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(repaired.lastSentAt).toEqual(
      new Date("2026-07-20T12:00:00.000Z")
    );
    expect(repaired.sendCount).toBe(1);
  });

  it("keeps raw warning incidents open when severity policy is raised and does not resend when lowered", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "severity-policy-eligibility",
        displayName: "Severity Policy Eligibility",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const warningConfig = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/severity-policy" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config: warningConfig,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ activeAlerts: 1, sent: 1, resolved: 0 });

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T13:00:00.000Z"),
        config: { ...warningConfig, minSeverity: "critical" as const },
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ activeAlerts: 1, sent: 0, resolved: 0 });
    expect(
      await prisma.providerAlertNotification.findUniqueOrThrow({
        where: { stateKey: `${provider.id}:balance_low` },
      })
    ).toMatchObject({ incidentGeneration: 1, resolvedAt: null, sendCount: 1 });

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T14:00:00.000Z"),
        config: warningConfig,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ activeAlerts: 1, sent: 0, resolved: 0, skipped: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      await prisma.providerAlertNotification.findUniqueOrThrow({
        where: { stateKey: `${provider.id}:balance_low` },
      })
    ).toMatchObject({ incidentGeneration: 1, resolvedAt: null, sendCount: 1 });
  });

  it("refuses a stale notification summary after the parent operation is replaced and the incident closes", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "summary-parent-cas",
        displayName: "Summary Parent CAS",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    let replacedParent = false;
    const notificationDelegate = new Proxy(prisma.providerAlertNotification, {
      get(target, property) {
        if (property === "updateMany") {
          return async (
            args: Parameters<typeof prisma.providerAlertNotification.updateMany>[0]
          ) => {
            if (!replacedParent && "lastSentAt" in args.data) {
              replacedParent = true;
              const notification =
                await prisma.providerAlertNotification.findUniqueOrThrow({
                  where: { stateKey: `${provider.id}:balance_low` },
                });
              await prisma.providerAlertNotification.update({
                where: { id: notification.id },
                data: {
                  resolvedAt: new Date("2026-07-20T12:00:01.000Z"),
                  evidenceWatermarkAt: new Date("2026-07-20T12:00:01.000Z"),
                  evidenceWatermarkState: "clear",
                  operationClaimToken: "replacement-parent-operation",
                  operationClaimGeneration: { increment: 1 },
                  operationClaimExpiresAt: new Date(
                    "2026-07-20T12:10:00.000Z"
                  ),
                },
              });
            }
            return prisma.providerAlertNotification.updateMany(args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;

    const failure = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [
          { kind: "webhook", url: "https://alerts.example/summary-parent-cas" },
        ],
        minSeverity: "warning",
        reminderHours: 24,
      },
      fetchImpl: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      db: {
        provider: prisma.provider,
        providerAlertNotification: notificationDelegate,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    }).catch((error: unknown) => error);

    expect(replacedParent).toBe(true);
    expect(failure).toMatchObject({
      name: "TriggerDeliveryClaimLostError",
      message: "Alert delivery claim was lost before its outcome could be persisted",
    });
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.resolvedAt).toEqual(
      new Date("2026-07-20T12:00:01.000Z")
    );
    expect(notification.lastSentAt).toBeNull();
    expect(notification.sendCount).toBe(0);
    expect(notification.operationClaimToken).toBe("replacement-parent-operation");
  });

  it("continues across providers after a deferred summary timeout and reports complete accounting", async () => {
    for (const name of ["alpha-summary-timeout", "beta-summary-success"]) {
      await prisma.provider.create({
        data: {
          name,
          displayName: name,
          type: "builtin",
          refreshIntervalMin: 60,
          plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
          snapshots: {
            create: {
              fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
              balance: 5,
            },
          },
        },
      });
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    let failedFirstSummary = false;
    const notificationDelegate = new Proxy(prisma.providerAlertNotification, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args: Parameters<typeof prisma.providerAlertNotification.updateMany>[0]) => {
            if (!failedFirstSummary && "lastSentAt" in args.data) {
              failedFirstSummary = true;
              throw Object.assign(new Error("first provider summary timed out"), {
                code: "P1008",
                meta: { modelName: "ProviderAlertNotification" },
              });
            }
            return prisma.providerAlertNotification.updateMany(args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const db = {
      provider: prisma.provider,
      providerAlertNotification: notificationDelegate,
      providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
    } as unknown as AlertDb;

    const failure = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "webhook", url: "https://alerts.example/multi-summary" }],
        minSeverity: "warning",
        reminderHours: 24,
      },
      fetchImpl: fetchMock,
      db,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AlertNotificationSummaryPersistenceTimeout);
    expect(failure).toMatchObject({
      partialResult: {
        evaluatedProviders: 2,
        activeAlerts: 2,
        sent: 2,
        errors: [],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notifications = await prisma.providerAlertNotification.findMany({
      orderBy: { providerName: "asc" },
    });
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.lastSentAt).toBeNull();
    expect(notifications[1]?.lastSentAt).toEqual(
      new Date("2026-07-20T12:00:00.000Z")
    );
  });

  it("keeps same-model timeouts before the post-send summary operation fatal", async () => {
    await prisma.provider.create({
      data: {
        name: "notification-read-timeout",
        displayName: "Notification Read Timeout",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const timeout = Object.assign(new Error("notification read timed out"), {
      code: "P1008",
      meta: { modelName: "ProviderAlertNotification" },
    });
    const notificationDelegate = new Proxy(prisma.providerAlertNotification, {
      get(target, property) {
        if (property === "findMany") return async () => Promise.reject(timeout);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const db = {
      provider: prisma.provider,
      providerAlertNotification: notificationDelegate,
      providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
    } as unknown as AlertDb;
    const fetchMock = vi.fn();

    await expect(
      deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config: {
          channels: [{ kind: "webhook", url: "https://alerts.example/read-timeout" }],
          minSeverity: "warning",
          reminderHours: 24,
        },
        fetchImpl: fetchMock,
        db,
      })
    ).rejects.toBe(timeout);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("durably defers a resend when success-state persistence times out after delivery", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "channel-success-timeout",
        displayName: "Channel Success Timeout",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/state-timeout" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };
    let failedSuccessWrite = false;
    const channelDelegate = new Proxy(prisma.providerAlertChannelDelivery, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args: Parameters<typeof prisma.providerAlertChannelDelivery.updateMany>[0]) => {
            if (!failedSuccessWrite && args.data && "lastSucceededAt" in args.data) {
              failedSuccessWrite = true;
              throw Object.assign(new Error("channel success state timed out"), {
                code: "P1008",
                meta: { modelName: "ProviderAlertChannelDelivery" },
              });
            }
            return prisma.providerAlertChannelDelivery.updateMany(args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const db = {
      provider: prisma.provider,
      providerAlertNotification: prisma.providerAlertNotification,
      providerAlertChannelDelivery: channelDelegate,
    } as unknown as AlertDb;

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
      db,
    });
    expect(first.sent).toBe(0);
    expect(first.errors).toEqual([
      expect.objectContaining({
        providerId: provider.id,
        alertCode: "balance_low",
        channel: "webhook",
        error: expect.stringContaining("automatic retry is deferred"),
      }),
    ]);
    expect(first.persistenceDegraded).toEqual([
      expect.objectContaining({
        stage: "channel_state",
        operation: "trigger_success_outcome",
        code: "P1008",
        model: "ProviderAlertChannelDelivery",
        providerId: provider.id,
        alertCode: "balance_low",
        channel: "webhook",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const uncertainState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(uncertainState.lastAttemptAt).toEqual(new Date("2026-07-20T12:00:00.000Z"));
    expect(uncertainState.lastSucceededAt).toBeNull();
    expect(uncertainState.lastError).toBe("delivery_outcome_unknown");

    const deferred = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(deferred.skipped).toBe(1);
    expect(deferred.errors[0]?.error).toContain("automatic retry is deferred");
    expect(fetchMock).toHaveBeenCalledOnce();

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-21T12:30:00.000Z"),
        balance: 5,
      },
    });
    const reminder = await deliverProviderAlerts({
      now: new Date("2026-07-21T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(reminder.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("atomically claims one trigger generation across concurrent delivery workers", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "concurrent-trigger-claim",
        displayName: "Concurrent Trigger Claim",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        })
    );
    const now = new Date("2026-07-20T12:00:00.000Z");
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/concurrent" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    const { PrismaClient } = await import("@prisma/client");
    const contenderPrisma = new PrismaClient();
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const contenderDb = {
      provider: contenderPrisma.provider,
      providerAlertNotification: contenderPrisma.providerAlertNotification,
      providerAlertChannelDelivery: contenderPrisma.providerAlertChannelDelivery,
    } as AlertDb;

    const owner = deliverProviderAlerts({ now, config, fetchImpl: fetchMock });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const contender = await deliverProviderAlerts({
      now,
      config,
      fetchImpl: fetchMock,
      db: contenderDb,
    });
    await contenderPrisma.$disconnect();
    expect(contender.sent).toBe(0);
    expect(contender.skipped).toBe(1);
    expect(contender.errors).toEqual([
      expect.objectContaining({
        providerId: provider.id,
        channel: "incident",
        error: expect.stringContaining("already claimed by another worker"),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();

    expect(releaseFetch).toBeTypeOf("function");
    releaseFetch?.(new Response("ok", { status: 200 }));
    await expect(owner).resolves.toMatchObject({ sent: 1, errors: [] });

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(state.triggerClaimGeneration).toBe(1);
    expect(state.triggerClaimToken).toBeNull();
    expect(state.triggerClaimExpiresAt).toBeNull();
    expect(state.successCount).toBe(1);
  });

  it("advances a reopened incident once and emits one trigger when both workers observed the resolved row", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "concurrent-reopen",
        displayName: "Concurrent Reopen",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const config = {
      channels: [
        { kind: "webhook" as const, url: "https://alerts.example/reopen-cas" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    const setupFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: setupFetch,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });
    await deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: setupFetch,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T14:00:00.000Z"),
        balance: 5,
      },
    });

    const { PrismaClient } = await import("@prisma/client");
    const contenderPrisma = new PrismaClient();
    let observedResolvedReads = 0;
    let releaseBarrier: (() => void) | undefined;
    const bothObserved = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const wrapNotificationDelegate = (
      client: typeof prisma
    ): typeof prisma.providerAlertNotification =>
      new Proxy(client.providerAlertNotification, {
        get(target, property) {
          if (property === "findUnique") {
            return async (
              args: Parameters<typeof client.providerAlertNotification.findUnique>[0]
            ) => {
              const row = await client.providerAlertNotification.findUnique(args);
              if (row?.resolvedAt && "stateKey" in args.where) {
                observedResolvedReads += 1;
                if (observedResolvedReads === 2) releaseBarrier?.();
                await bothObserved;
              }
              return row;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const ownerDb = {
      provider: prisma.provider,
      providerAlertNotification: wrapNotificationDelegate(prisma),
      providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
    } as unknown as AlertDb;
    const contenderDb = {
      provider: contenderPrisma.provider,
      providerAlertNotification: wrapNotificationDelegate(
        contenderPrisma as unknown as typeof prisma
      ),
      providerAlertChannelDelivery: contenderPrisma.providerAlertChannelDelivery,
    } as unknown as AlertDb;
    const reopenFetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const outcomes = await Promise.all([
      deliverProviderAlerts({
        now: new Date("2026-07-20T14:30:00.000Z"),
        config,
        fetchImpl: reopenFetch,
        db: ownerDb,
      }),
      deliverProviderAlerts({
        now: new Date("2026-07-20T14:30:00.000Z"),
        config,
        fetchImpl: reopenFetch,
        db: contenderDb,
      }),
    ]).finally(() => contenderPrisma.$disconnect());

    expect(observedResolvedReads).toBe(2);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.sent, 0)).toBe(1);
    expect(reopenFetch).toHaveBeenCalledOnce();
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.incidentGeneration).toBe(2);
    expect(notification.firstDetectedAt).toEqual(
      new Date("2026-07-20T14:30:00.000Z")
    );
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(state.lastSucceededIncidentGeneration).toBe(2);
  });

  it("suppresses a stale activator after newer healthy evidence resolves the incident", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "resolver-activator-race",
        displayName: "Resolver Activator Race",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const config = {
      channels: [
        { kind: "webhook" as const, url: "https://alerts.example/resolve-activate" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });

    let releaseActivatorRead: (() => void) | undefined;
    const resolverWon = new Promise<void>((resolve) => {
      releaseActivatorRead = resolve;
    });
    let activatorObservedOpen = false;
    const notificationDelegate = new Proxy(prisma.providerAlertNotification, {
      get(target, property) {
        if (property === "findUnique") {
          return async (
            args: Parameters<typeof prisma.providerAlertNotification.findUnique>[0]
          ) => {
            const row = await prisma.providerAlertNotification.findUnique(args);
            if (
              !activatorObservedOpen &&
              row?.resolvedAt === null &&
              "stateKey" in args.where
            ) {
              activatorObservedOpen = true;
              await resolverWon;
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const activatorFetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const activator = deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: activatorFetch,
      db: {
        provider: prisma.provider,
        providerAlertNotification: notificationDelegate,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    });
    await vi.waitFor(() => expect(activatorObservedOpen).toBe(true));

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:01.000Z"),
        balance: 25,
      },
    });
    const { PrismaClient } = await import("@prisma/client");
    const resolverPrisma = new PrismaClient();
    const resolver = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:02.000Z"),
      config,
      fetchImpl: activatorFetch,
      db: {
        provider: resolverPrisma.provider,
        providerAlertNotification: resolverPrisma.providerAlertNotification,
        providerAlertChannelDelivery: resolverPrisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    }).finally(() => resolverPrisma.$disconnect());
    expect(resolver.resolved).toBe(1);
    const closedGeneration =
      await prisma.providerAlertNotification.findUniqueOrThrow({
        where: { stateKey: `${provider.id}:balance_low` },
      });
    expect(closedGeneration.incidentGeneration).toBe(1);
    expect(closedGeneration.resolvedAt).not.toBeNull();

    releaseActivatorRead?.();
    const stale = await activator;
    expect(stale).toMatchObject({ sent: 0, skipped: 1 });
    expect(stale.errors[0]?.error).toContain("older than the durable incident watermark");
    expect(activatorFetch).not.toHaveBeenCalled();
    const stillClosed = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(stillClosed.incidentGeneration).toBe(1);
    expect(stillClosed.resolvedAt).not.toBeNull();
    expect(stillClosed.evidenceWatermarkAt).toEqual(
      new Date("2026-07-20T13:00:01.000Z")
    );
    expect(stillClosed.evidenceWatermarkState).toBe("clear");
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: stillClosed.id },
    });
    expect(state.lastSucceededIncidentGeneration).toBe(1);
  });

  it("lets newer active evidence preempt a resolver parent before any external resolve", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "resolver-newer-active-parent-race",
        displayName: "Resolver Newer Active Parent Race",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const config = {
      channels: [{ kind: "pagerduty" as const, routingKey: "resolver-parent-race" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 202 }));
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });

    const { PrismaClient } = await import("@prisma/client");
    const resolverPrisma = new PrismaClient();
    let signalResolverParent: (() => void) | undefined;
    let releaseResolverParent: (() => void) | undefined;
    const resolverParentReached = new Promise<void>((resolve) => {
      signalResolverParent = resolve;
    });
    const resolverParentBarrier = new Promise<void>((resolve) => {
      releaseResolverParent = resolve;
    });
    let heldResolverParent = false;
    const resolverChannelDelegate = new Proxy(
      resolverPrisma.providerAlertChannelDelivery,
      {
        get(target, property) {
          if (property === "findMany") {
            return async (
              args: Parameters<typeof resolverPrisma.providerAlertChannelDelivery.findMany>[0]
            ) => {
              const rows = await resolverPrisma.providerAlertChannelDelivery.findMany(args);
              if (!heldResolverParent) {
                heldResolverParent = true;
                signalResolverParent?.();
                await resolverParentBarrier;
              }
              return rows;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }
    );
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const resolver = deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock,
      db: {
        provider: resolverPrisma.provider,
        providerAlertNotification: resolverPrisma.providerAlertNotification,
        providerAlertChannelDelivery: resolverChannelDelegate,
      } as unknown as AlertDb,
    });
    await resolverParentReached;

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T14:00:00.000Z"),
        balance: 3,
      },
    });
    const fresh = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:30:00.000Z"),
      config,
      fetchImpl: fetchMock,
      db: {
        provider: prisma.provider,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as AlertDb,
    });
    expect(fresh).toMatchObject({ resolved: 0, sent: 0, skipped: 1 });

    releaseResolverParent?.();
    const staleResolver = await resolver.finally(() => resolverPrisma.$disconnect());
    expect(staleResolver.resolved).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification).toMatchObject({
      resolvedAt: null,
      evidenceSourceAt: new Date("2026-07-20T14:00:00.000Z"),
      message: "Balance $3.00 is at or below $10.00.",
    });
  });

  it("never sends a stale trigger message after newer evidence replaces its parent claim", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "stale-trigger-message-race",
        displayName: "Stale Trigger Message Race",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const noChannels = {
      channels: [],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: noChannels,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 4,
      },
    });

    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/stale-message" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    let signalStaleChild: (() => void) | undefined;
    let releaseStaleChild: (() => void) | undefined;
    const staleChildReached = new Promise<void>((resolve) => {
      signalStaleChild = resolve;
    });
    const staleChildBarrier = new Promise<void>((resolve) => {
      releaseStaleChild = resolve;
    });
    let heldStaleChild = false;
    const staleChannelDelegate = new Proxy(prisma.providerAlertChannelDelivery, {
      get(target, property) {
        if (property === "updateMany") {
          return async (
            args: Parameters<typeof prisma.providerAlertChannelDelivery.updateMany>[0]
          ) => {
            if (!heldStaleChild) {
              heldStaleChild = true;
              signalStaleChild?.();
              await staleChildBarrier;
            }
            return prisma.providerAlertChannelDelivery.updateMany(args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const staleTrigger = deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock,
      db: {
        provider: prisma.provider,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: staleChannelDelegate,
      } as unknown as AlertDb,
    });
    await staleChildReached;

    const { PrismaClient } = await import("@prisma/client");
    const freshPrisma = new PrismaClient();
    try {
      await freshPrisma.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: new Date("2026-07-20T14:00:00.000Z"),
          balance: 3,
        },
      });
      const fresh = await deliverProviderAlerts({
        now: new Date("2026-07-20T14:30:00.000Z"),
        config,
        fetchImpl: fetchMock,
        db: {
          provider: freshPrisma.provider,
          providerAlertNotification: freshPrisma.providerAlertNotification,
          providerAlertChannelDelivery: freshPrisma.providerAlertChannelDelivery,
        } as unknown as AlertDb,
      });
      expect(fresh).toMatchObject({ sent: 1 });
    } finally {
      releaseStaleChild?.();
      await freshPrisma.$disconnect();
    }

    expect(await staleTrigger).toMatchObject({ sent: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.alert.message).toBe("Balance $3.00 is at or below $10.00.");
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification).toMatchObject({
      resolvedAt: null,
      evidenceSourceAt: new Date("2026-07-20T14:00:00.000Z"),
      message: "Balance $3.00 is at or below $10.00.",
      sendCount: 1,
    });
  });

  it("treats no-snapshot evidence as older than every real snapshot", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "missing-snapshot-watermark",
        displayName: "Missing Snapshot Watermark",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
      },
    });
    const config = {
      channels: [
        { kind: "webhook" as const, url: "https://alerts.example/no-snapshot" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });

    let releaseStaleRead: (() => void) | undefined;
    let signalStaleRead: (() => void) | undefined;
    const staleReadReached = new Promise<void>((resolve) => {
      signalStaleRead = resolve;
    });
    const staleReadBarrier = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    let heldStaleRead = false;
    const notificationDelegate = new Proxy(prisma.providerAlertNotification, {
      get(target, property) {
        if (property === "findUnique") {
          return async (
            args: Parameters<typeof prisma.providerAlertNotification.findUnique>[0]
          ) => {
            const row = await prisma.providerAlertNotification.findUnique(args);
            if (
              !heldStaleRead &&
              row?.resolvedAt === null &&
              "stateKey" in args.where
            ) {
              heldStaleRead = true;
              signalStaleRead?.();
              await staleReadBarrier;
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const staleActivator = deliverProviderAlerts({
      now: new Date("2026-07-20T15:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
      db: {
        provider: prisma.provider,
        providerAlertNotification: notificationDelegate,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    });
    await staleReadReached;

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        // Backfilled provider evidence may legitimately predate the evaluator
        // that first observed the absence.
        fetchedAt: new Date("2026-07-20T12:00:00.000Z"),
        balance: 25,
      },
    });
    const { PrismaClient } = await import("@prisma/client");
    const resolverPrisma = new PrismaClient();
    const resolved = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
      db: {
        provider: resolverPrisma.provider,
        providerAlertNotification: resolverPrisma.providerAlertNotification,
        providerAlertChannelDelivery: resolverPrisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    }).finally(() => resolverPrisma.$disconnect());
    expect(resolved.resolved).toBe(1);

    releaseStaleRead?.();
    const stale = await staleActivator;
    expect(stale).toMatchObject({ sent: 0, skipped: 1 });
    expect(stale.errors[0]?.error).toContain(
      "older than the durable incident watermark"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:missing_snapshot` },
    });
    expect(notification.incidentGeneration).toBe(1);
    expect(notification.resolvedAt).not.toBeNull();
    expect(notification.evidenceWatermarkAt).toEqual(
      new Date("2026-07-20T12:00:00.000Z")
    );
    expect(notification.evidenceWatermarkState).toBe("clear");
  });

  it("reopens stale-snapshot evidence when the unchanged fresh snapshot crosses its deterministic deadline", async () => {
    const firstSnapshotAt = new Date("2026-07-18T08:00:00.000Z");
    const freshSnapshotAt = new Date("2026-07-20T11:00:00.000Z");
    const provider = await prisma.provider.create({
      data: {
        name: "stale-snapshot-recurrence",
        displayName: "Stale Snapshot Recurrence",
        type: "builtin",
        refreshIntervalMin: 60,
        snapshots: { create: { fetchedAt: firstSnapshotAt } },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/stale-recurrence" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });

    await prisma.usageSnapshot.create({
      data: { providerId: provider.id, fetchedAt: freshSnapshotAt },
    });
    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T12:30:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ resolved: 1 });

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-21T11:00:00.001Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:stale_snapshot` },
    });
    expect(notification).toMatchObject({
      incidentGeneration: 2,
      evidenceSourceAt: freshSnapshotAt,
      evidenceWatermarkState: "active",
      resolvedAt: null,
    });
    expect(notification.evidenceWatermarkAt).toEqual(
      new Date("2026-07-21T11:00:00.000Z")
    );
  });

  it("reopens no-snapshot evidence after disable and re-enable revisions", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "missing-snapshot-config-revision",
        displayName: "Missing Snapshot Config Revision",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const config = {
      channels: [
        {
          kind: "webhook" as const,
          url: "https://alerts.example/no-snapshot-config-revision",
        },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });
    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        isActive: false,
        alertConfigGeneration: { increment: 1 },
      },
    });
    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T13:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ resolved: 1 });
    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        isActive: true,
        alertConfigGeneration: { increment: 1 },
      },
    });

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T14:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:missing_snapshot` },
    });
    expect(notification).toMatchObject({
      incidentGeneration: 2,
      evidenceConfigGeneration: 2,
      evidenceWatermarkState: "active",
      resolvedAt: null,
    });
    expect(notification.evidenceWatermarkAt).toEqual(new Date(0));
  });

  it("reopens unchanged no-snapshot evidence when Anthropic polling capability returns", async () => {
    const encryptedAdminKey = encrypt("sk-ant-admin01-alert-test");
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        apiKey: encryptedAdminKey,
        refreshIntervalMin: 60,
      },
    });
    const config = {
      channels: [
        {
          kind: "webhook" as const,
          url: "https://alerts.example/anthropic-snapshot-capability",
        },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });

    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        apiKey: null,
        alertConfigGeneration: { increment: 1 },
      },
    });
    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T13:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ resolved: 1 });

    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        apiKey: encryptedAdminKey,
        alertConfigGeneration: { increment: 1 },
      },
    });
    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T14:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:missing_snapshot` },
    });
    expect(notification).toMatchObject({
      incidentGeneration: 2,
      evidenceConfigGeneration: 2,
      evidenceWatermarkState: "active",
      resolvedAt: null,
    });
    expect(notification.evidenceWatermarkAt).toEqual(new Date(0));
  });

  it("reopens unchanged low-balance snapshot evidence after disable and re-enable revisions", async () => {
    const snapshotAt = new Date("2026-07-20T08:00:00.000Z");
    const provider = await prisma.provider.create({
      data: {
        name: "unchanged-balance-config-revision",
        displayName: "Unchanged Balance Config Revision",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: { create: { fetchedAt: snapshotAt, balance: 5 } },
      },
    });
    const config = {
      channels: [
        {
          kind: "webhook" as const,
          url: "https://alerts.example/unchanged-balance-config-revision",
        },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T12:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });
    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        isActive: false,
        alertConfigGeneration: { increment: 1 },
      },
    });
    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T13:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ resolved: 1 });
    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        isActive: true,
        alertConfigGeneration: { increment: 1 },
      },
    });

    expect(
      await deliverProviderAlerts({
        now: new Date("2026-07-20T14:00:00.000Z"),
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification).toMatchObject({
      incidentGeneration: 2,
      evidenceConfigGeneration: 2,
      evidenceWatermarkState: "active",
      resolvedAt: null,
    });
    expect(notification.evidenceWatermarkAt).toEqual(snapshotAt);
    expect(await prisma.usageSnapshot.count({ where: { providerId: provider.id } })).toBe(1);
  });

  it("fences a two-client stale rev0 activator across disable rev1 and re-enable rev2", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "config-generation-two-client-race",
        displayName: "Config Generation Two Client Race",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const config = {
      channels: [
        {
          kind: "webhook" as const,
          url: "https://alerts.example/config-generation-two-client-race",
        },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });

    let releaseRev0Read: (() => void) | undefined;
    let signalRev0Read: (() => void) | undefined;
    const rev0ReadReached = new Promise<void>((resolve) => {
      signalRev0Read = resolve;
    });
    const rev0ReadBarrier = new Promise<void>((resolve) => {
      releaseRev0Read = resolve;
    });
    let heldRev0Read = false;
    const providerDelegate = new Proxy(prisma.provider, {
      get(target, property) {
        if (property === "findMany") {
          return async (args: Parameters<typeof prisma.provider.findMany>[0]) => {
            const rows = await prisma.provider.findMany(args);
            if (!heldRev0Read) {
              heldRev0Read = true;
              signalRev0Read?.();
              await rev0ReadBarrier;
            }
            return rows;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const staleFetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const staleRev0 = deliverProviderAlerts({
      now: new Date("2026-07-20T12:30:00.000Z"),
      config,
      fetchImpl: staleFetch,
      db: {
        provider: providerDelegate,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    });
    await rev0ReadReached;

    const { PrismaClient } = await import("@prisma/client");
    const configClient = new PrismaClient();
    try {
      await configClient.provider.update({
        where: { id: provider.id },
        data: {
          isActive: false,
          alertConfigGeneration: { increment: 1 },
        },
      });
      const rev1 = await deliverProviderAlerts({
        now: new Date("2026-07-20T13:00:00.000Z"),
        config,
        fetchImpl: staleFetch,
        db: {
          provider: configClient.provider,
          providerAlertNotification: configClient.providerAlertNotification,
          providerAlertChannelDelivery: configClient.providerAlertChannelDelivery,
        } as unknown as AlertDb,
      });
      expect(rev1).toMatchObject({ resolved: 1 });
      await configClient.provider.update({
        where: { id: provider.id },
        data: {
          isActive: true,
          alertConfigGeneration: { increment: 1 },
        },
      });

      releaseRev0Read?.();
      const stale = await staleRev0;
      expect(stale).toMatchObject({ sent: 0, skipped: 1 });
      expect(staleFetch).not.toHaveBeenCalled();

      const freshFetch = vi
        .fn()
        .mockResolvedValue(new Response("ok", { status: 200 }));
      const rev2 = await deliverProviderAlerts({
        now: new Date("2026-07-20T14:00:00.000Z"),
        config,
        fetchImpl: freshFetch,
        db: {
          provider: configClient.provider,
          providerAlertNotification: configClient.providerAlertNotification,
          providerAlertChannelDelivery: configClient.providerAlertChannelDelivery,
        } as unknown as AlertDb,
      });
      expect(rev2).toMatchObject({ sent: 1 });
      expect(freshFetch).toHaveBeenCalledOnce();
    } finally {
      releaseRev0Read?.();
      await configClient.$disconnect();
    }

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification).toMatchObject({
      incidentGeneration: 2,
      evidenceConfigGeneration: 2,
      evidenceWatermarkState: "active",
      resolvedAt: null,
    });
    expect(
      await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } })
    ).toMatchObject({ alertConfigGeneration: 2, isActive: true });
  });

  it("does not move last-detected time backward for the same evidence", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "monotonic-last-detected",
        displayName: "Monotonic Last Detected",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [
        { kind: "webhook" as const, url: "https://alerts.example/monotonic" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T15:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });

    const stale = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(stale).toMatchObject({ sent: 0, skipped: 1 });
    expect(stale.errors[0]?.error).toContain(
      "older than the durable incident watermark"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.lastDetectedAt).toEqual(
      new Date("2026-07-20T15:00:00.000Z")
    );
  });

  it("floors a delayed reopen against prior resolution, newer evidence, and the actual claim clock", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "reopen-time-floor",
        displayName: "Reopen Time Floor",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/reopen-time-floor" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T15:00:00.000Z"),
        balance: 25,
      },
    });
    await deliverProviderAlerts({
      now: new Date("2026-07-20T15:30:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T16:00:00.000Z"),
        balance: 4,
      },
    });

    const actualClaimAt = new Date("2026-07-20T17:00:00.000Z");
    expect(
      await deliverProviderAlerts({
        // Simulates a delayed worker whose cycle timestamp predates the prior
        // resolution and the evidence it eventually observes.
        now: new Date("2026-07-20T14:00:00.000Z"),
        clock: () => actualClaimAt,
        config,
        fetchImpl: fetchMock,
      })
    ).toMatchObject({ sent: 1 });

    const reopened = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(reopened).toMatchObject({
      incidentGeneration: 2,
      firstDetectedAt: actualClaimAt,
      lastDetectedAt: actualClaimAt,
      resolvedAt: null,
    });
  });

  it("uses actual claim and outcome times instead of moving timestamps back to cycle start", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "claim-clock",
        displayName: "Claim Clock",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        })
    );
    const claimTime = new Date("2026-07-20T12:05:00.000Z");
    const outcomeTime = new Date("2026-07-20T12:05:10.000Z");
    let logicalNow = claimTime;
    const delivery = deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      clock: () => logicalNow,
      config: {
        channels: [
          { kind: "webhook", url: "https://alerts.example/claim-clock" },
        ],
        minSeverity: "warning",
        reminderHours: 24,
        timeoutMs: 1_000,
        maxAttempts: 1,
        retryBaseMs: 0,
      },
      fetchImpl: fetchMock,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const claimed = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(claimed.lastAttemptAt).toEqual(claimTime);
    expect(claimed.triggerClaimExpiresAt).toEqual(
      new Date("2026-07-20T12:05:31.000Z")
    );

    logicalNow = outcomeTime;
    releaseFetch?.(new Response("ok", { status: 200 }));
    await expect(delivery).resolves.toMatchObject({ sent: 1 });
    const completed = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(completed.lastAttemptAt).toEqual(outcomeTime);
    expect(completed.lastSucceededAt).toEqual(outcomeTime);
  });

  it("does not mark an aggregate send complete while another due channel is unknown", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "aggregate-unknown-channel",
        displayName: "Aggregate Unknown Channel",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const webhook = { kind: "webhook" as const, url: "https://alerts.example/unknown" };
    const slack = { kind: "slack" as const, url: "https://hooks.slack.test/aggregate" };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket reset after request write"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const uncertain = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [webhook],
        minSeverity: "warning",
        reminderHours: 24,
        maxAttempts: 1,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(uncertain.sent).toBe(0);

    const partial = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config: {
        channels: [webhook, slack],
        minSeverity: "warning",
        reminderHours: 24,
        maxAttempts: 1,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(partial.sent).toBe(0);
    expect(partial.errors).toEqual([
      expect.objectContaining({
        providerId: provider.id,
        channel: "webhook",
        error: expect.stringContaining("automatic retry is deferred"),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.lastSentAt).toBeNull();
    expect(notification.sendCount).toBe(0);
    const states = await prisma.providerAlertChannelDelivery.findMany({
      where: { notificationId: notification.id },
      orderBy: { channelKind: "asc" },
    });
    expect(states.find((state) => state.channelKind === "slack")?.successCount).toBe(1);
    expect(states.find((state) => state.channelKind === "webhook")?.lastError).toBe(
      "delivery_outcome_unknown"
    );
  });

  it("retries only the failed channel while preserving successful channel state", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "partial-delivery",
        displayName: "Partial Delivery",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const slackUrl = "https://hooks.slack.test/services/channel";
    const webhookUrl = "https://alerts.example/webhook";
    let webhookCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === slackUrl) return new Response("ok", { status: 200 });
      webhookCalls += 1;
      return new Response(webhookCalls === 1 ? "down" : "ok", {
        status: webhookCalls === 1 ? 429 : 200,
      });
    });
    const config = {
      channels: [
        { kind: "slack" as const, url: slackUrl },
        { kind: "webhook" as const, url: webhookUrl },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(first.sent).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const channelStates = await prisma.providerAlertChannelDelivery.findMany({
      where: { notificationId: notification.id },
      orderBy: { channelKind: "asc" },
    });
    expect(channelStates).toHaveLength(2);
    expect(channelStates.find((state) => state.channelKind === "slack")?.lastSucceededAt).not.toBeNull();
    expect(channelStates.find((state) => state.channelKind === "webhook")?.lastSucceededAt).toBeNull();

    // Simulate an aggregate lastSentAt written by the pre-channel-state
    // implementation. A real failed channel row must remain authoritative;
    // the legacy aggregate fallback applies only when that channel has no row.
    await prisma.providerAlertNotification.update({
      where: { id: notification.id },
      data: { lastSentAt: new Date("2026-07-20T12:00:00.000Z") },
    });

    const second = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(second.sent).toBe(1);
    expect(second.errors).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toBe(webhookUrl);

    const third = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(third.skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry an ambiguous transport timeout and defers until the reminder", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "timeout-retry",
        displayName: "Timeout Retry",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));

    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "webhook", url: "https://alerts.example/timeout" }],
        minSeverity: "warning",
        reminderHours: 24,
        timeoutMs: 5,
        maxAttempts: 2,
        retryBaseMs: 0,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.sent).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        channel: "webhook",
        error: expect.stringContaining("delivery may have been accepted"),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const channelState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(channelState.attemptCount).toBe(1);
    expect(channelState.successCount).toBe(0);
    expect(channelState.lastError).toBe("delivery_outcome_unknown");
  });

  it.each([
    [
      "Slack",
      { kind: "slack" as const, url: "https://hooks.slack.test/ambiguous-503" },
    ],
    [
      "generic webhook",
      { kind: "webhook" as const, url: "https://alerts.example/ambiguous-503" },
    ],
    [
      "Resend",
      {
        kind: "email" as const,
        apiKey: "re_test",
        from: "alerts@example.com",
        to: "oncall@example.com",
      },
    ],
  ])("does not retry an ambiguous %s HTTP 5xx without idempotency", async (_label, channel) => {
    const provider = await prisma.provider.create({
      data: {
        name: `ambiguous-503-${channel.kind}`,
        displayName: `Ambiguous 503 ${channel.kind}`,
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream uncertain", { status: 503 }))
      .mockResolvedValueOnce(new Response("would duplicate", { status: 200 }));

    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [channel],
        minSeverity: "warning",
        reminderHours: 24,
        maxAttempts: 2,
        retryBaseMs: 0,
      },
      fetchImpl: fetchMock,
    });

    expect(result.sent).toBe(0);
    expect(result.errors[0]?.error).toContain("delivery may have been accepted");
    expect(fetchMock).toHaveBeenCalledOnce();
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(state.lastError).toBe("delivery_outcome_unknown");
  });

  it("retries a definitive HTTP rejection within the bounded attempt budget", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "http-retry",
        displayName: "HTTP Retry",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("retry", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "webhook", url: "https://alerts.example/http-retry" }],
        minSeverity: "warning",
        reminderHours: 24,
        maxAttempts: 2,
        retryBaseMs: 0,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.sent).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const channelState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(channelState.attemptCount).toBe(2);
    expect(channelState.successCount).toBe(1);
    expect(channelState.lastError).toBeNull();
  });

  it("retries ambiguous PagerDuty 5xx responses with the same incident dedup key", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-idempotent-retry",
        displayName: "PagerDuty Idempotent Retry",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("uncertain", { status: 503 }))
      .mockResolvedValueOnce(new Response("accepted", { status: 202 }));

    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "pagerduty", routingKey: "pd-idempotent-key" }],
        minSeverity: "warning",
        reminderHours: 24,
        maxAttempts: 2,
        retryBaseMs: 0,
      },
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ sent: 1, errors: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body ?? "{}"))
    );
    expect(new Set(bodies.map((body) => body.dedup_key))).toEqual(
      new Set([
        `api-usage-monitor:${provider.id}:balance_low:incident-1`,
      ])
    );
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(state.attemptCount).toBe(2);
    expect(state.lastSucceededIncidentGeneration).toBe(1);
  });

  it("supports email delivery via Resend", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "test_email",
        displayName: "Test Email",
        type: "builtin",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [
        { kind: "email" as const, apiKey: "test-api-key", from: "alerts@example.com", to: "oncall@example.com" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };

    // We need an alert to be triggered, let's create a snapshot to trigger a balance low
    await prisma.providerPlan.create({
      data: {
        providerId: provider.id,
        billingMode: "actual",
        lowBalanceUsd: 10,
      }
    });

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
        balance: 5,
      },
    });

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });

    expect(first.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://api.resend.com/emails");
    expect(callArgs[1].headers).toMatchObject({
      Authorization: "Bearer test-api-key",
    });
    const body = JSON.parse(String(callArgs[1]?.body ?? "{}"));
    expect(body.to).toBe("oncall@example.com");
    expect(body.from).toBe("alerts@example.com");
    expect(body.subject).toContain("Test Email");
    expect(body.html).toContain("Test Email");
  });

  it("retries an idempotent PagerDuty resolve after an unknown trigger and failed resolve", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-unknown-trigger",
        displayName: "PagerDuty Unknown Trigger",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset after request write"))
      .mockResolvedValueOnce(new Response("rejected", { status: 503 }))
      .mockResolvedValueOnce(new Response("accepted", { status: 202 }));
    const config = {
      channels: [{ kind: "pagerduty" as const, routingKey: "unknown-trigger-routing-key" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };

    const trigger = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(trigger.sent).toBe(0);
    expect(trigger.errors[0]?.error).toContain("delivery may have been accepted");

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });
    const failedResolve = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(failedResolve.resolved).toBe(0);
    expect(failedResolve.errors[0]?.error).toBe("PagerDuty API HTTP 503");

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const afterFailedResolve = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id, channelKind: "pagerduty" },
    });
    expect(afterFailedResolve.lastError).toBe("delivery_outcome_unknown");
    expect(afterFailedResolve.lastResolveError).toBe("PagerDuty API HTTP 503");
    expect(notification.resolvedAt).toBeNull();

    const resolved = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resolved.resolved).toBe(1);

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body ?? "{}"))
    );
    expect(bodies.map((body) => body.event_action)).toEqual([
      "trigger",
      "resolve",
      "resolve",
    ]);
    expect(new Set(bodies.map((body) => body.dedup_key))).toEqual(
      new Set([`api-usage-monitor:${provider.id}:balance_low:incident-1`])
    );
    const finalState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id, channelKind: "pagerduty" },
    });
    expect(finalState.lastResolvedAt).toEqual(new Date("2026-07-20T14:00:00.000Z"));
    expect(finalState.lastResolveError).toBeNull();
  });

  it("defers PagerDuty resolve until an in-flight trigger claim settles", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-trigger-resolve-race",
        displayName: "PagerDuty Trigger Resolve Race",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    let releaseTrigger: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseTrigger = resolve;
          })
      )
      .mockResolvedValue(new Response("accepted", { status: 202 }));
    const config = {
      channels: [{ kind: "pagerduty" as const, routingKey: "race-routing-key" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };

    const triggerOwner = deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const inFlightNotification =
      await prisma.providerAlertNotification.findUniqueOrThrow({
        where: { stateKey: `${provider.id}:balance_low` },
      });
    const triggerClaimBeforeResolve =
      await prisma.providerAlertChannelDelivery.findFirstOrThrow({
        where: { notificationId: inFlightNotification.id },
      });
    expect(triggerClaimBeforeResolve.triggerClaimToken).not.toBeNull();

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T12:00:05.000Z"),
        balance: 25,
      },
    });
    const racingResolve = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:10.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(racingResolve.resolved).toBe(0);
    expect(racingResolve.errors[0]?.error).toContain(
      "already claimed by another worker"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const triggerClaimAfterResolve =
      await prisma.providerAlertChannelDelivery.findFirstOrThrow({
        where: { notificationId: inFlightNotification.id },
      });
    expect(triggerClaimAfterResolve.triggerClaimToken).toBe(
      triggerClaimBeforeResolve.triggerClaimToken
    );
    expect(triggerClaimAfterResolve.triggerClaimGeneration).toBe(
      triggerClaimBeforeResolve.triggerClaimGeneration
    );
    expect(triggerClaimAfterResolve.triggerClaimExpiresAt).toEqual(
      triggerClaimBeforeResolve.triggerClaimExpiresAt
    );

    expect(releaseTrigger).toBeTypeOf("function");
    releaseTrigger?.(new Response("accepted", { status: 202 }));
    await expect(triggerOwner).resolves.toMatchObject({ sent: 1 });

    const resolved = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:20.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resolved.resolved).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body ?? "{}"))
    );
    expect(bodies.map((body) => body.event_action)).toEqual(["trigger", "resolve"]);
    expect(bodies[0]?.dedup_key).toBe(bodies[1]?.dedup_key);
  });

  it("rejects a stale trigger outcome after an expired resolve takeover closes the incident", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-stale-trigger-outcome",
        displayName: "PagerDuty Stale Trigger Outcome",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    let releaseTriggerOutcome: (() => void) | undefined;
    let signalTriggerOutcome: (() => void) | undefined;
    const triggerOutcomeReached = new Promise<void>((resolve) => {
      signalTriggerOutcome = resolve;
    });
    const triggerOutcomeBarrier = new Promise<void>((resolve) => {
      releaseTriggerOutcome = resolve;
    });
    let heldTriggerOutcome = false;
    const triggerChannelDelegate = new Proxy(
      prisma.providerAlertChannelDelivery,
      {
        get(target, property) {
          if (property === "updateMany") {
            return async (
              args: Parameters<
                typeof prisma.providerAlertChannelDelivery.updateMany
              >[0]
            ) => {
              if (!heldTriggerOutcome && "lastSucceededAt" in args.data) {
                heldTriggerOutcome = true;
                signalTriggerOutcome?.();
                await triggerOutcomeBarrier;
              }
              return prisma.providerAlertChannelDelivery.updateMany(args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }
    );
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "stale-trigger-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      timeoutMs: 5_000,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    const triggerOwner = deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      clock: () => new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("accepted", { status: 202 })),
      db: {
        provider: prisma.provider,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: triggerChannelDelegate,
      } as unknown as AlertDb,
    });
    await triggerOutcomeReached;

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });
    const resolver = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      clock: () => new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("accepted", { status: 202 })),
      db: {
        provider: prisma.provider,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    });
    expect(resolver).toMatchObject({ resolved: 1 });

    releaseTriggerOutcome?.();
    const staleTriggerFailure = await triggerOwner.catch(
      (error: unknown) => error
    );
    expect(staleTriggerFailure).toMatchObject({
      name: "TriggerDeliveryClaimLostError",
    });
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.resolvedAt).not.toBeNull();
    expect(notification.evidenceWatermarkAt).toEqual(
      new Date("2026-07-20T13:00:00.000Z")
    );
    expect(notification.evidenceWatermarkState).toBe("clear");
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(state.triggerClaimToken).toBeNull();
    expect(state.triggerClaimGeneration).toBe(2);
    expect(state.lastSucceededAt).toBeNull();
    expect(state.lastResolvedAt).toEqual(new Date("2026-07-20T14:00:00.000Z"));
    expect(state.lastResolvedIncidentGeneration).toBe(1);
  });

  it("rejects a stale resolver outcome after an expired trigger takeover restores active evidence", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-stale-resolve-outcome",
        displayName: "PagerDuty Stale Resolve Outcome",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "stale-resolve-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 0,
      timeoutMs: 5_000,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      clock: () => new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("accepted", { status: 202 })),
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });

    let releaseResolveOutcome: (() => void) | undefined;
    let signalResolveOutcome: (() => void) | undefined;
    const resolveOutcomeReached = new Promise<void>((resolve) => {
      signalResolveOutcome = resolve;
    });
    const resolveOutcomeBarrier = new Promise<void>((resolve) => {
      releaseResolveOutcome = resolve;
    });
    let heldResolveOutcome = false;
    const resolveChannelDelegate = new Proxy(
      prisma.providerAlertChannelDelivery,
      {
        get(target, property) {
          if (property === "updateMany") {
            return async (
              args: Parameters<
                typeof prisma.providerAlertChannelDelivery.updateMany
              >[0]
            ) => {
              if (!heldResolveOutcome && "lastResolvedAt" in args.data) {
                heldResolveOutcome = true;
                signalResolveOutcome?.();
                await resolveOutcomeBarrier;
              }
              return prisma.providerAlertChannelDelivery.updateMany(args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }
    );
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const resolverOwner = deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      clock: () => new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("accepted", { status: 202 })),
      db: {
        provider: prisma.provider,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: resolveChannelDelegate,
      } as unknown as AlertDb,
    });
    await resolveOutcomeReached;

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T14:00:00.000Z"),
        balance: 5,
      },
    });
    const reactivated = await deliverProviderAlerts({
      now: new Date("2026-07-20T15:00:00.000Z"),
      clock: () => new Date("2026-07-20T15:00:00.000Z"),
      config,
      fetchImpl: vi.fn().mockResolvedValue(new Response("accepted", { status: 202 })),
      db: {
        provider: prisma.provider,
        providerAlertNotification: prisma.providerAlertNotification,
        providerAlertChannelDelivery: prisma.providerAlertChannelDelivery,
      } as unknown as AlertDb,
    });
    expect(reactivated).toMatchObject({ sent: 1 });

    releaseResolveOutcome?.();
    const staleResolveFailure = await resolverOwner.catch(
      (error: unknown) => error
    );
    expect(staleResolveFailure).toMatchObject({
      name: "TriggerDeliveryClaimLostError",
    });
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.resolvedAt).toBeNull();
    expect(notification.evidenceWatermarkAt).toEqual(
      new Date("2026-07-20T14:00:00.000Z")
    );
    expect(notification.evidenceWatermarkState).toBe("active");
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(state.resolveClaimToken).toBeNull();
    expect(state.resolveClaimGeneration).toBe(3);
    expect(state.lastResolvedAt).toBeNull();
    expect(state.lastResolvedIncidentGeneration).toBeNull();
    expect(state.lastResolveError).toBeNull();
    expect(state.lastSucceededAt).toEqual(new Date("2026-07-20T15:00:00.000Z"));
  });

  it("serializes concurrent PagerDuty resolve workers before the external boundary", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-resolve-claim",
        displayName: "PagerDuty Resolve Claim",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    let releaseResolve: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("accepted", { status: 202 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseResolve = resolve;
          })
      );
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "resolve-claim-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };
    await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });

    const { PrismaClient } = await import("@prisma/client");
    const contenderPrisma = new PrismaClient();
    type AlertDb = NonNullable<
      NonNullable<Parameters<typeof deliverProviderAlerts>[0]>["db"]
    >;
    const contenderDb = {
      provider: contenderPrisma.provider,
      providerAlertNotification: contenderPrisma.providerAlertNotification,
      providerAlertChannelDelivery: contenderPrisma.providerAlertChannelDelivery,
    } as unknown as AlertDb;
    const owner = deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const contender = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
      db: contenderDb,
    }).finally(() => contenderPrisma.$disconnect());
    expect(contender.resolved).toBe(0);
    expect(contender.errors[0]?.error).toContain(
      "already claimed by another worker"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releaseResolve?.(new Response("accepted", { status: 202 }));
    await expect(owner).resolves.toMatchObject({ resolved: 1 });
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const state = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    // The trigger claim invalidates the opposing resolve generation; the
    // later resolve claim advances it again.
    expect(state.resolveClaimGeneration).toBe(2);
    expect(state.resolveClaimToken).toBeNull();
    expect(state.lastResolvedIncidentGeneration).toBe(1);
  });

  it("audits a migrated PagerDuty incident with the legacy dedup key before local closure", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-legacy-audit",
        displayName: "PagerDuty Legacy Audit",
        type: "builtin",
        isActive: false,
      },
    });
    const notification = await prisma.providerAlertNotification.create({
      data: {
        providerId: provider.id,
        stateKey: `${provider.id}:balance_low`,
        alertCode: "balance_low",
        severity: "warning",
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        message: "legacy alert",
        firstDetectedAt: new Date("2026-07-19T12:00:00.000Z"),
        lastDetectedAt: new Date("2026-07-19T12:00:00.000Z"),
        incidentGeneration: 1,
        pagerDutyAuditState: "legacy_unknown",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("accepted", { status: 202 }));

    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [
          { kind: "pagerduty", routingKey: "legacy-audit-routing-key" },
        ],
        minSeverity: "warning",
        reminderHours: 24,
        maxAttempts: 1,
      },
      fetchImpl: fetchMock,
    });

    expect(result.resolved).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body).toMatchObject({
      event_action: "resolve",
      dedup_key: `api-usage-monitor:${provider.id}:balance_low`,
    });
    const closed = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(closed.resolvedAt).not.toBeNull();
    expect(closed.pagerDutyAuditState).toBe("legacy_audited");
  });

  it("keeps a PagerDuty notification open when the original routing key is replaced", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "pagerduty-routing-key-rotation",
        displayName: "PagerDuty Routing Key Rotation",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("accepted", { status: 202 }));
    const baseConfig = {
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
    };

    const trigger = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        ...baseConfig,
        channels: [{ kind: "pagerduty" as const, routingKey: "original-routing-key" }],
      },
      fetchImpl: fetchMock,
    });
    expect(trigger.sent).toBe(1);

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });
    const rotated = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config: {
        ...baseConfig,
        channels: [{ kind: "pagerduty" as const, routingKey: "replacement-routing-key" }],
      },
      fetchImpl: fetchMock,
    });
    expect(rotated.resolved).toBe(0);
    expect(rotated.errors[0]?.error).toContain("original routing key");
    expect(fetchMock).toHaveBeenCalledOnce();
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(notification.resolvedAt).toBeNull();
  });

  it("uses one PagerDuty key per incident across trigger and resolve, then rotates it on reopen", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "test_pd",
        displayName: "Test PD",
        type: "builtin",
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

    const responseStatuses = [202, 503, 202, 202];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: responseStatuses.shift() ?? 202 })
    );
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "test-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    
    expect(first.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(String(callArgs[1]?.body ?? "{}"));
    expect(body.routing_key).toBe("test-routing-key");
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe(
      `api-usage-monitor:${provider.id}:balance_low:incident-1`
    );
    expect(body.payload.source).toBe("API Usage Monitor");
    expect(body.payload.component).toBe("test_pd");
    expect(body.payload.severity).toBe("warning"); // The default balance low is warning

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });
    const failedResolve = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(failedResolve.resolved).toBe(0);
    expect(failedResolve.errors).toHaveLength(1);
    const stillOpen = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(stillOpen.resolvedAt).toBeNull();

    const resolved = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resolved.resolved).toBe(1);
    const resolveBodies = fetchMock.mock.calls
      .slice(1, 3)
      .map((call) => JSON.parse(String(call[1]?.body ?? "{}")));
    expect(resolveBodies.every((payload) => payload.event_action === "resolve")).toBe(true);
    expect(resolveBodies.every((payload) => payload.dedup_key === body.dedup_key)).toBe(true);

    const channelState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: stillOpen.id, channelKind: "pagerduty" },
    });
    expect(channelState.resolveAttemptCount).toBe(2);
    expect(channelState.lastResolvedAt).not.toBeNull();

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T15:00:00.000Z"),
        balance: 5,
      },
    });
    const reopened = await deliverProviderAlerts({
      now: new Date("2026-07-20T15:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(reopened.sent).toBe(1);
    const reopenedBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}"));
    expect(reopenedBody.event_action).toBe("trigger");
    expect(reopenedBody.dedup_key).toBe(
      `api-usage-monitor:${provider.id}:balance_low:incident-2`
    );
    expect(reopenedBody.dedup_key).not.toBe(body.dedup_key);
  });

  it("delivers budget alerts from canonical pushed spend", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: { billingMode: "actual", monthlyBudgetUsd: 10 },
        },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T11:00:00.000Z"),
            totalCost: 0,
          },
        },
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "pushed-budget-warning",
        sourceApp: "claude-code",
        provider: "anthropic",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 9,
        occurredAt: new Date("2026-07-20T10:00:00.000Z"),
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "webhook", url: "https://alerts.example/webhook" }],
        minSeverity: "warning",
        reminderHours: 24,
      },
      fetchImpl: fetchMock,
    });

    expect(result.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.provider.id).toBe(provider.id);
    expect(payload.alert.code).toBe("budget_warning");
    expect(payload.alert.message).toContain("$9.00");
  });

  it("resolves open alerts for a provider after it is deactivated", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "deactivate_resolve_test",
        displayName: "Deactivate Resolve Test",
        type: "builtin",
        refreshIntervalMin: 60,
        isActive: true,
        plan: {
          create: {
            billingMode: "actual",
            lowBalanceUsd: 10,
            monthlyBudgetUsd: 10,
            fixedMonthlyCostUsd: 15, // causes budget conflict/excess
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

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 202 }));
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "test-pd-deactivate-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };

    // 1. Trigger both alerts (balance low + budget exceeded)
    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(first.sent).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const openNotification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(openNotification.resolvedAt).toBeNull();
    const openBudgetNotification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:budget_exceeded` },
    });
    expect(openBudgetNotification.resolvedAt).toBeNull();

    // 2. Deactivate the provider
    await prisma.provider.update({
      where: { id: provider.id },
      data: { isActive: false },
    });

    // 3. Deliver alerts again; since the provider is now inactive, the alerts are no longer active, so they should be resolved
    const second = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(second.resolved).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const resolveBodies = fetchMock.mock.calls
      .slice(2, 4)
      .map((call) => JSON.parse(String(call[1]?.body ?? "{}")));
    expect(resolveBodies.every((payload) => payload.event_action === "resolve")).toBe(true);
    
    const resolveKeys = resolveBodies.map((payload) => payload.dedup_key);
    expect(resolveKeys).toContain(
      `api-usage-monitor:${provider.id}:balance_low:incident-1`
    );
    expect(resolveKeys).toContain(
      `api-usage-monitor:${provider.id}:budget_exceeded:incident-1`
    );

    const resolvedNotification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { id: openNotification.id },
    });
    expect(resolvedNotification.resolvedAt).not.toBeNull();
    const resolvedBudgetNotification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { id: openBudgetNotification.id },
    });
    expect(resolvedBudgetNotification.resolvedAt).not.toBeNull();
  });
});
