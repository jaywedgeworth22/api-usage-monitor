import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { initialCycle } from "../subscriptions";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Everything that transitively imports @/lib/prisma is loaded DYNAMICALLY after
// DATABASE_URL points at the test DB — otherwise the prisma singleton binds to
// the wrong database at module-load time (matches the retention-integration
// test's pattern).
let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let planSubscriptionCharges: typeof import("../subscription-materializer").planSubscriptionCharges;
let materializeDueSubscriptions: typeof import("../subscription-materializer").materializeDueSubscriptions;
let computeProjectBudgetStatus: typeof import("../budget-status").computeProjectBudgetStatus;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let putSubscription: typeof import("@/app/api/subscriptions/[id]/route").PUT;

const NOW = new Date("2026-07-15T12:00:00.000Z");

interface FakeSub {
  id: string;
  name: string;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  projectId: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date;
  lastChargedPeriodStart: Date | null;
  provider: { name: string };
}

function fakeSubscription(overrides: Partial<FakeSub> = {}): FakeSub {
  return {
    id: "sub-1",
    name: "Test plan",
    costUsd: 20,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    projectId: "proj-1",
    autoRenew: true,
    currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
    lastChargedPeriodStart: null,
    provider: { name: "anthropic" },
    ...overrides,
  };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-materializer-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ planSubscriptionCharges, materializeDueSubscriptions } = await import(
    "../subscription-materializer"
  ));
  ({ computeProjectBudgetStatus, computeBudgetStatus } = await import("../budget-status"));
  ({ PUT: putSubscription } = await import("@/app/api/subscriptions/[id]/route"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

describe("planSubscriptionCharges", () => {
  it("charges only the current period on first run", () => {
    const plan = planSubscriptionCharges(fakeSubscription(), new Date("2026-07-15T00:00:00Z"));
    expect(plan).not.toBeNull();
    expect(plan!.inputs).toHaveLength(1);
    expect(plan!.inputs[0].metricType).toBe("subscription");
    expect(plan!.inputs[0].projectId).toBe("proj-1");
    expect(plan!.inputs[0].costUsd).toBe(20);
    expect(plan!.currentPeriodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(plan!.nextRenewalAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("backfills every elapsed period since currentPeriodStart", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ currentPeriodStart: new Date("2026-05-01T00:00:00Z") }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan!.inputs).toHaveLength(3);
    expect(plan!.currentPeriodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("returns null when the current period is already charged", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ lastChargedPeriodStart: new Date("2026-07-01T00:00:00Z") }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan).toBeNull();
  });

  it("gives each period a distinct idempotency key", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ currentPeriodStart: new Date("2026-05-01T00:00:00Z") }),
      new Date("2026-07-15T00:00:00Z")
    );
    const keys = new Set(plan!.inputs.map((i) => i.idempotencyKey));
    expect(keys.size).toBe(3);
  });

  it("charges a non-auto-renewing subscription only for its first term", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({
        autoRenew: false,
        currentPeriodStart: new Date("2026-05-01T00:00:00Z"),
      }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan!.inputs).toHaveLength(1);
    expect(plan!.currentPeriodStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("materializeDueSubscriptions + project attribution (integration)", () => {
  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.providerProjectAllocation.deleteMany();
    await prisma.usageSnapshot.deleteMany();
    await prisma.providerPlan.deleteMany();
    await prisma.project.deleteMany();
    await prisma.provider.deleteMany();
  });

  async function createSubscription(providerId: string, extra: Record<string, unknown> = {}) {
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    return prisma.subscription.create({
      data: {
        providerId,
        name: "Claude Max",
        costUsd: 30,
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart,
        nextRenewalAt,
        ...extra,
      },
    });
  }

  it("materializes one charge per period and attributes it to the project budget", async () => {
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const project = await prisma.project.create({
      data: { name: "Socratic Trade", monthlyBudgetUsd: 100 },
    });
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        projectId: project.id,
        name: "Claude Max",
        costUsd: 30,
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart,
        nextRenewalAt,
      },
    });

    const first = await materializeDueSubscriptions(NOW);
    expect(first.charged).toBe(1);
    expect(first.eventsWritten).toBe(1);

    const events = await prisma.externalUsageEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].metricType).toBe("subscription");
    expect(events[0].projectId).toBe(project.id);
    expect(events[0].costUsd).toBe(30);

    // Re-running is idempotent: no new charge for the same period.
    const second = await materializeDueSubscriptions(NOW);
    expect(second.eventsWritten).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    // The subscription cost shows up as direct project spend.
    const status = await computeProjectBudgetStatus(NOW);
    const projStatus = status.projects.find((p) => p.id === project.id);
    expect(projStatus?.directUsd).toBeCloseTo(30);
    expect(projStatus?.spentUsd).toBeCloseTo(30);
  });

  it("adds a subscription fee ON TOP of a poll-tracked provider's snapshot cost", async () => {
    // Regression: max(snapshot, pushed) must not swallow a disjoint subscription
    // fee. Provider has a $80 metered snapshot AND a $30 subscription -> $110.
    const provider = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 200 } },
      },
    });
    await prisma.usageSnapshot.create({
      data: { providerId: provider.id, fetchedAt: NOW, totalCost: 80 },
    });
    await createSubscription(provider.id);

    await materializeDueSubscriptions(NOW);

    const status = await computeBudgetStatus(NOW);
    const prov = status.providers.find((p) => p.id === provider.id)!;
    expect(prov.spentUsd).toBeCloseTo(110);
  });

  it("does not re-charge already-charged periods when the schedule is edited", async () => {
    // Regression for the critical double-charge: editing the schedule (here via
    // a real PUT that changes the interval) must not re-emit past charges.
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const subscription = await createSubscription(provider.id);

    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    // Edit the subscription: change interval to quarterly (a genuine schedule change).
    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval: "quarterly" }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);

    // Re-materialize: still exactly one charge — no duplicate for July.
    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("does not emit an overlapping charge when the anchor day moves later in the billed month", async () => {
    // Regression for the fix-review finding: charged Jul-1 period, then move
    // anchorDay to 15 — the new Aug-anchored period must not overlap July.
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const subscription = await createSubscription(provider.id);

    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorDay: 15 }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);

    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });
});
