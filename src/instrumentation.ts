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

  if (!isUsageSchedulerEnabled()) {
    console.warn(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
    return;
  }
  const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
  startUsagePollingScheduler();
}
