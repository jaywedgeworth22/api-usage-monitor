import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Exercises the corrected per-project budget math end to end: explicit projectId
// is authoritative, the sourceApp-name fallback only applies to untagged rows,
// and percentage allocation distributes the true residual without
// double-counting directly-attributed cost.
describe("project attribution (integration)", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
  let computeProjectBudgetStatus: typeof import("../budget-status").computeProjectBudgetStatus;
  let resolveProjectIdsByName: typeof import("../project-resolver").resolveProjectIdsByName;

  const NOW = new Date("2026-07-15T12:00:00.000Z");
  const occurredAt = new Date("2026-07-10T00:00:00.000Z");

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-attribution-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);

    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents } = await import("../external-usage-events"));
    ({ computeProjectBudgetStatus } = await import("../budget-status"));
    ({ resolveProjectIdsByName } = await import("../project-resolver"));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
    await prisma.providerProjectAllocation.deleteMany();
    await prisma.providerPlan.deleteMany();
    await prisma.project.deleteMany();
    await prisma.provider.deleteMany();
  });

  it("resolves project names case-insensitively and leaves unknowns unresolved", async () => {
    const project = await prisma.project.create({
      data: { name: "Socratic Trade", nameKey: "socratic trade" },
    });
    // Producer sends a differently-cased name; it still resolves (keyed by
    // nameKey / lowercased name). An unrelated name does not resolve.
    const map = await resolveProjectIdsByName(["SOCRATIC TRADE", "unknown-app"]);
    expect(map.get("socratic trade")).toBe(project.id);
    expect(map.has("unknown-app")).toBe(false);
  });

  it("rejects case-variant project names at the database level (closes the create race)", async () => {
    await prisma.project.create({ data: { name: "Socratic Trade", nameKey: "socratic trade" } });
    // Two concurrent creates both pass an app-level check but the unique nameKey
    // constraint fails the second insert — the guarantee an app check can't give.
    await expect(
      prisma.project.create({ data: { name: "socratic trade", nameKey: "socratic trade" } })
    ).rejects.toThrow();
  });

  it("attributes projectId-tagged cost directly and never double-counts under allocation", async () => {
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const project = await prisma.project.create({
      data: { name: "Socratic Trade", monthlyBudgetUsd: 100 },
    });

    // $10 tagged to the project, $4 untagged — both under the anthropic provider.
    await persistExternalUsageEvents([
      {
        idempotencyKey: "tagged-1",
        sourceApp: "claude-code",
        provider: "anthropic",
        projectId: project.id,
        billingMode: "actual",
        metricType: "usage",
        costUsd: 10,
        occurredAt,
      },
      {
        idempotencyKey: "untagged-1",
        sourceApp: "some-other-app",
        provider: "anthropic",
        projectId: null,
        billingMode: "actual",
        metricType: "usage",
        costUsd: 4,
        occurredAt,
      },
    ]);

    // Without any allocation, only the directly-tagged $10 lands on the project.
    let status = await computeProjectBudgetStatus(NOW);
    let proj = status.projects.find((p) => p.id === project.id)!;
    expect(proj.directUsd).toBeCloseTo(10);
    expect(proj.allocatedUsd).toBeCloseTo(0);
    expect(proj.spentUsd).toBeCloseTo(10);

    // Allocate 100% of the anthropic provider to the project. The provider's
    // month-to-date spend is $14; $10 is already directly attributed, so the
    // residual distributed by allocation is only $4 — total $14, not $24.
    await prisma.providerProjectAllocation.create({
      data: { providerId: provider.id, projectId: project.id, percentage: 100 },
    });

    status = await computeProjectBudgetStatus(NOW);
    proj = status.projects.find((p) => p.id === project.id)!;
    expect(proj.directUsd).toBeCloseTo(10);
    expect(proj.allocatedUsd).toBeCloseTo(4);
    expect(proj.spentUsd).toBeCloseTo(14);
  });
});
