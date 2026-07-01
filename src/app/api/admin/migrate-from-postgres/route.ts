import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { prisma } from "@/lib/prisma";

// TEMPORARY one-time migration endpoint. Render's one-off Jobs API does not
// get the service's persistent disk mounted (only the primary running
// instance does), so scripts/migrate-postgres-to-sqlite.mjs can't run as a
// Job against the real /data disk. This route runs the same migration logic
// in-process inside the already-running, disk-mounted web service instead.
// Protected by the normal dashboard session middleware (no bespoke secret).
// Delete this route once the one-time migration is done.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let sourceDatabaseUrl: string;
  try {
    const body = await request.json();
    sourceDatabaseUrl = typeof body?.sourceDatabaseUrl === "string" ? body.sourceDatabaseUrl : "";
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!sourceDatabaseUrl) {
    return NextResponse.json({ error: "sourceDatabaseUrl is required" }, { status: 400 });
  }

  const pg = new Client({ connectionString: sourceDatabaseUrl });
  const log: string[] = [];

  try {
    await pg.connect();
    log.push("Connected to source Postgres database.");

    const providerRows = (await pg.query('SELECT * FROM "Provider"')).rows;
    log.push(`Provider: ${providerRows.length} rows found in source.`);
    const providerPlanRows = (await pg.query('SELECT * FROM "ProviderPlan"')).rows;
    log.push(`ProviderPlan: ${providerPlanRows.length} rows found in source.`);
    const usageSnapshotRows = (await pg.query('SELECT * FROM "UsageSnapshot"')).rows;
    log.push(`UsageSnapshot: ${usageSnapshotRows.length} rows found in source.`);
    const externalUsageEventRows = (await pg.query('SELECT * FROM "ExternalUsageEvent"')).rows;
    log.push(`ExternalUsageEvent: ${externalUsageEventRows.length} rows found in source.`);

    await prisma.$transaction(async (tx) => {
      for (const row of providerRows) {
        await tx.provider.create({
          data: {
            id: row.id,
            name: row.name,
            displayName: row.displayName,
            type: row.type,
            apiKey: row.apiKey,
            config: row.config ?? undefined,
            isActive: row.isActive,
            credits: row.credits,
            refreshIntervalMin: row.refreshIntervalMin,
            groupId: row.groupId,
            label: row.label,
            createdAt: row.createdAt,
          },
        });
      }
      log.push(`Provider: ${providerRows.length} rows migrated.`);

      for (const row of providerPlanRows) {
        await tx.providerPlan.create({
          data: {
            id: row.id,
            providerId: row.providerId,
            billingMode: row.billingMode,
            fixedMonthlyCostUsd: row.fixedMonthlyCostUsd,
            monthlyBudgetUsd: row.monthlyBudgetUsd,
            monthlyRequestLimit: row.monthlyRequestLimit,
            lowBalanceUsd: row.lowBalanceUsd,
            lowCredits: row.lowCredits,
            renewalDate: row.renewalDate,
            mustKeepFunded: row.mustKeepFunded,
            notes: row.notes,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        });
      }
      log.push(`ProviderPlan: ${providerPlanRows.length} rows migrated.`);

      for (const row of usageSnapshotRows) {
        await tx.usageSnapshot.create({
          data: {
            id: row.id,
            providerId: row.providerId,
            fetchedAt: row.fetchedAt,
            balance: row.balance,
            totalCost: row.totalCost,
            totalRequests: row.totalRequests,
            credits: row.credits,
            rawData: row.rawData ?? undefined,
            createdAt: row.createdAt,
          },
        });
      }
      log.push(`UsageSnapshot: ${usageSnapshotRows.length} rows migrated.`);

      for (const row of externalUsageEventRows) {
        await tx.externalUsageEvent.create({
          data: {
            id: row.id,
            idempotencyKey: row.idempotencyKey,
            sourceApp: row.sourceApp,
            environment: row.environment,
            provider: row.provider,
            service: row.service,
            label: row.label,
            keyRef: row.keyRef,
            billingMode: row.billingMode,
            metricType: row.metricType,
            quantity: row.quantity,
            unit: row.unit,
            costUsd: row.costUsd,
            requests: row.requests,
            credits: row.credits,
            limit: row.limit,
            limitWindow: row.limitWindow,
            tier: row.tier,
            confidence: row.confidence,
            windowStart: row.windowStart,
            windowEnd: row.windowEnd,
            occurredAt: row.occurredAt,
            metadata: row.metadata ?? undefined,
            createdAt: row.createdAt,
          },
        });
      }
      log.push(`ExternalUsageEvent: ${externalUsageEventRows.length} rows migrated.`);
    });

    log.push("Migration complete.");
    return NextResponse.json({ ok: true, log });
  } catch (error) {
    return NextResponse.json(
      { ok: false, log, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  } finally {
    await pg.end().catch(() => {});
  }
}
