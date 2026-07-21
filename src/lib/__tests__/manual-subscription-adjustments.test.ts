import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Prisma } from "@prisma/client";
// Type-only import: erased at compile time, so it does not trigger
// usage-telemetry.ts's module load (and transitively @/lib/prisma) before
// DATABASE_URL is pointed at the test DB below.
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// ---------------------------------------------------------------------------
// Money-math proof (spec item 4): four owner-directed manual subscription
// adjustment events — two positive Apple-billed prior-tier charges, two
// negative pro-rated upgrade-refund estimates — must flow through the REAL
// ingest validation path (usage-telemetry parsing + persistExternalUsageEvents)
// and net out to +23.13 in computeBudgetStatus's anthropic figures, additively
// on top of whatever else the fixture contains, WITHOUT any max()/clamp
// swallowing the negative amounts.
//
//   21.45 + 124.99 - 19.15 - 104.16 = 23.13
//
// Everything that transitively imports @/lib/prisma is loaded dynamically
// after DATABASE_URL points at the test DB (matches the repo's existing
// lib-test pattern in subscription-materializer.test.ts /
// external-billing-subscription-adoption.test.ts), and the clock is frozen
// with the repo's Date-only fake-clock pattern from PR #293's fixture
// stabilization (vi.useFakeTimers({ toFake: ["Date"] })).
// ---------------------------------------------------------------------------

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let parseUsageTelemetryBatch: typeof import("../usage-telemetry").parseUsageTelemetryBatch;
let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
let materializeDueSubscriptions: typeof import("../subscription-materializer").materializeDueSubscriptions;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let initialCycle: typeof import("../subscriptions").initialCycle;

// Frozen "now" the spec calls for: end of the June billing month the four
// events occurred in.
const NOW = new Date("2026-06-30T23:59:00.000Z");
const JUNE_1 = new Date("2026-06-01T00:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "manual-subscription-adjustments-test-")
  );
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ parseUsageTelemetryBatch } = await import("../usage-telemetry"));
  ({ persistExternalUsageEvents } = await import("../external-usage-events"));
  ({ materializeDueSubscriptions } = await import("../subscription-materializer"));
  ({ computeBudgetStatus } = await import("../budget-status"));
  ({ initialCycle } = await import("../subscriptions"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await prisma.externalUsageEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
});

// Mirrors POST /api/ingest/usage's event -> ExternalUsageEventInput mapping
// (src/app/api/ingest/usage/route.ts) exactly, so this test exercises the
// same shape the real route persists, not a hand-rolled shortcut.
function toPersistenceInputs(events: ParsedUsageTelemetryEvent[]) {
  return events.map((event) => ({
    idempotencyKey: event.idempotencyKey,
    sourceApp: event.sourceApp,
    environment: event.environment,
    provider: event.provider,
    service: event.service,
    projectId: null,
    label: event.label,
    keyRef: event.keyRef,
    billingMode: event.billingMode,
    metricType: event.metricType,
    quantity: event.quantity,
    unit: event.unit,
    costUsd: event.costUsd,
    requests: event.requests,
    credits: event.credits,
    limit: event.limit,
    limitWindow: event.limitWindow,
    tier: event.tier,
    confidence: event.confidence,
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    occurredAt: event.occurredAt,
    metadata: event.metadata as Prisma.InputJsonObject | undefined,
  }));
}

describe("manual subscription adjustment events — money-math proof", () => {
  it("nets the four owner-directed events to +23.13 in computeBudgetStatus without swallowing the negatives", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    await prisma.providerPlan.create({
      data: {
        providerId: provider.id,
        billingMode: "actual",
        monthlyBudgetUsd: 500,
      },
    });

    // Baseline: the CURRENT-term Claude Max 5x Monthly subscription, tracked
    // the ordinary materializer way (sourceApp="subscription"), charged for
    // its June period. Proves the historical manual events land ON TOP OF
    // this and that the current-term row is untouched by them.
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: JUNE_1,
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Claude Max 5x Monthly",
        costUsd: 124.99,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: JUNE_1,
        currentPeriodStart,
        nextRenewalAt,
      },
    });
    const materialized = await materializeDueSubscriptions(NOW);
    expect(materialized).toMatchObject({ charged: 1, eventsWritten: 1 });

    // The four owner-directed manual events, parsed through the REAL ingest
    // validation path (parseUsageTelemetryBatch) exactly as
    // scripts/import-manual-subscription-events.mjs and the ingest route
    // build them, then persisted exactly as the route persists them.
    const parsed = parseUsageTelemetryBatch({
      events: [
        {
          idempotencyKey: "manual-adj:claude-pro-monthly-prior-tier:2026-06-13",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: 21.45,
          confidence: "actual",
          label: "Claude Pro Monthly (prior tier, Apple)",
          occurredAt: "2026-06-13T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "apple-receipt",
            tier: "Claude Pro Monthly",
          },
        },
        {
          idempotencyKey: "manual-adj:claude-max-5x-monthly-prior-tier:2026-06-16",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: 124.99,
          confidence: "actual",
          label: "Claude Max 5x Monthly (prior tier, Apple)",
          occurredAt: "2026-06-16T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "apple-receipt",
            tier: "Claude Max 5x Monthly",
          },
        },
        {
          idempotencyKey: "manual-adj:upgrade-refund-pro:2026-06-16",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: -19.15,
          confidence: "estimated",
          label: "Pro-rated upgrade refund (day-count proration estimate)",
          occurredAt: "2026-06-16T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "day-count-proration-estimate",
            formula: "21.45 * 25 / 28",
          },
        },
        {
          idempotencyKey: "manual-adj:upgrade-refund-max:2026-06-21",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: -104.16,
          confidence: "estimated",
          label: "Pro-rated upgrade refund (day-count proration estimate)",
          occurredAt: "2026-06-21T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "day-count-proration-estimate",
            formula: "124.99 * 25 / 30",
          },
        },
      ],
    });
    expect(parsed).toHaveLength(4);
    // The relaxed validation genuinely let the negative amounts through the
    // parser (this is the item-1 acceptance check at the unit level; here it
    // matters because a bug that clamped/rejected them here would make the
    // rest of this test pass for the wrong reason).
    expect(parsed.map((e) => e.costUsd)).toEqual([21.45, 124.99, -19.15, -104.16]);

    const persistResult = await persistExternalUsageEvents(
      toPersistenceInputs(parsed)
    );
    expect(persistResult.persisted).toBe(4);

    // The two refund rows genuinely made it to the database as negative
    // numbers — not stored as zero, not dropped, not sign-flipped.
    const storedNegatives = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "manual-billing-adjustment", costUsd: { lt: 0 } },
      select: { costUsd: true },
      orderBy: { occurredAt: "asc" },
    });
    expect(storedNegatives.map((e) => e.costUsd)).toEqual([-19.15, -104.16]);

    const budget = await computeBudgetStatus(NOW);
    const anthropic = budget.providers.find((row) => row.id === provider.id);
    expect(anthropic).toBeDefined();

    const netManualAdjustmentUsd = 21.45 + 124.99 - 19.15 - 104.16;
    expect(netManualAdjustmentUsd).toBeCloseTo(23.13, 2);

    // subscriptionMonthToDateUsd (pushed.subscriptionPushed) is the additive
    // sum of EVERY metricType="subscription" event regardless of sourceApp:
    // the $124.99 current-term materializer charge plus the four manual
    // events' net of +23.13.
    expect(anthropic!.subscriptionMonthToDateUsd).toBeCloseTo(
      124.99 + netManualAdjustmentUsd,
      2
    );

    // fixedAccruedUsd is a pure sum (fixedMonthlyCostUsd + subscriptionPushed
    // + snapshotFixedCostIncludedUsd - linkedFixedDedupeUsd); anthropic has no
    // fixed plan cost and no provider cost snapshot here, so it equals
    // subscriptionMonthToDateUsd exactly. This is the composition the spec
    // asked to verify is additive, not max()-based.
    expect(anthropic!.fixedAccruedUsd).toBeCloseTo(
      124.99 + netManualAdjustmentUsd,
      2
    );

    // usageCost is observed variable usage only (receipt funding is separate);
    // both usage and receipts are 0 here, so spentUsd = fixedAccruedUsd exactly —
    // the negatives are not swallowed anywhere on the way to spentUsd.
    const expectedSpentUsd = 124.99 + netManualAdjustmentUsd;
    expect(anthropic!.spentUsd).toBeCloseTo(expectedSpentUsd, 2);
    expect(expectedSpentUsd).toBeCloseTo(148.12, 2);

    // Negative-swallowing sentinel: if fixedAccruedUsd (or any composition
    // upstream of it) ran the manual events through Math.max(0, ...) per
    // event or summed only positives, spentUsd would land at 124.99 + 21.45 +
    // 124.99 = 271.43 instead. Assert the two are NOT equal so a future
    // clamp regression fails loudly here, not just via the toBeCloseTo above.
    const wouldBeIfNegativesSwallowed = 124.99 + 21.45 + 124.99;
    expect(anthropic!.spentUsd).not.toBeCloseTo(wouldBeIfNegativesSwallowed, 2);

    // The current-term materializer-owned row is untouched: still exactly one
    // "subscription" sourceApp event, still $124.99.
    const currentTermEvents = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "subscription", metricType: "subscription" },
    });
    expect(currentTermEvents).toHaveLength(1);
    expect(currentTermEvents[0].costUsd).toBe(124.99);

    // percentUsed / spentUsd reflect the net reduction from the refunds
    // relative to a world where only the two positive charges landed.
    expect(anthropic!.percentUsed).toBeCloseTo(expectedSpentUsd / 500, 4);
  });
});
