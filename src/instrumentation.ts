export function isUsageSchedulerEnabled(
  configured = process.env.USAGE_SCHEDULER_ENABLED
): boolean {
  return configured?.trim().toLowerCase() !== "false";
}

// Delay before the budget-status SWR caches (see @/lib/budget-status) are
// warmed in the background. Warming synchronously from register() (as this
// used to do) fires an ~11s computeBudgetStatus/computeProjectBudgetStatus
// query while Next.js is still starting - under connection_limit=1, that
// cold compute holds the single pooled DB connection, so a real request
// landing in roughly the first second (e.g. /api/projects issuing its own
// queries) can pool_timeout (~10s) waiting behind it. Deferring a few
// seconds lets the first real request get the connection first - identical
// to the ordering that existed before this cache did - while still warming
// well before the 60s default cache TTL would otherwise force a cold
// compute on some later request.
const BUDGET_STATUS_WARMUP_DELAY_MS = 5_000;

async function warmBudgetStatusCaches(): Promise<void> {
  try {
    const { computeBudgetStatus, computeProjectBudgetStatus } = await import(
      "@/lib/budget-status"
    );
    // Warm both caches - GET /api/providers reads computeBudgetStatus
    // directly, while GET /api/projects and GET /api/budget-status read only
    // computeProjectBudgetStatus (which internally calls computeBudgetStatus
    // too; the in-flight dedup in the cache means firing both concurrently
    // here doesn't double the DB work). Each has its own catch so one
    // failing never skips warming the other.
    await Promise.all([
      computeBudgetStatus().catch((error) => {
        console.warn("[budget-status-cache] boot warm-up failed", error);
      }),
      computeProjectBudgetStatus().catch((error) => {
        console.warn("[budget-status-cache] boot warm-up failed (project)", error);
      }),
    ]);
  } catch (error) {
    // Must never crash boot - e.g. if the dynamic import itself throws.
    console.warn("[budget-status-cache] boot warm-up failed", error);
  }
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

  // Warm the budget-status SWR caches in the background, deferred (see
  // BUDGET_STATUS_WARMUP_DELAY_MS above) so the dashboard's first request
  // after a deploy doesn't have to eat the cold ~11s recompute itself, and
  // the single pooled connection isn't held by this warm-up before the
  // server has even started accepting requests. Deliberately NOT awaited -
  // a slow or erroring DB at boot must not delay/block server readiness; if
  // this hasn't finished by the time a request lands, that request just
  // computes inline, exactly as it always did before this cache existed.
  const warmupTimer = setTimeout(() => {
    void warmBudgetStatusCaches();
  }, BUDGET_STATUS_WARMUP_DELAY_MS);
  // Don't let a still-pending warm-up timer keep a one-shot/test process
  // alive on its own - mirrors the scheduler's own boot-delay timer.
  warmupTimer.unref?.();

  if (!isUsageSchedulerEnabled()) {
    console.warn(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
    return;
  }
  const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
  startUsagePollingScheduler();
}
