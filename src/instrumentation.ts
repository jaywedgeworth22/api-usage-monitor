export function isUsageSchedulerEnabled(
  configured = process.env.USAGE_SCHEDULER_ENABLED
): boolean {
  return configured?.trim().toLowerCase() !== "false";
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Bound native (non-heap) SQLite memory before any request or scheduler
  // tick can issue a query. Next.js guarantees register() completes before
  // the server accepts a request, so this ordering is safe without an
  // explicit lock. Applied unconditionally - HTTP requests use Prisma even
  // when the polling scheduler below is emergency-disabled. See the
  // comment on applySqliteNativeMemoryPragmas in src/lib/prisma.ts.
  const { applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");
  await applySqliteNativeMemoryPragmas();

  // Keep legacy provider evidence, but prevent the retired/dormant built-ins
  // from making another external request. This is a small idempotent update
  // and intentionally runs even when the scheduler is emergency-disabled.
  const { deactivateDecommissionedBuiltInProviders } = await import(
    "@/lib/provider-retirement"
  );
  await deactivateDecommissionedBuiltInProviders();

  // NOTE: an earlier revision warmed the budget-status SWR caches here at
  // boot. It was removed after it crash-looped production: warming
  // computeProjectBudgetStatus runs its internal Promise.all
  // (computeBudgetStatus's ~336k-row groupBy AND sumMonthToDateExternalCost-
  // Attribution's ~336k-row groupBy) concurrently, and two of those
  // aggregations at once peaked past the 512MB instance limit and OOM-killed
  // the instance ~40-100s into every boot. The SWR cache still works fine
  // populated lazily on first request; it just must not be forced at boot on
  // this box. Reducing that per-compute footprint (so warming is safe again)
  // is tracked as a follow-up. See @/lib/budget-status.

  if (!isUsageSchedulerEnabled()) {
    console.warn(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
    return;
  }
  const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
  startUsagePollingScheduler();
}
