import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getBackupRuntimeStatus,
  getRuntimeIdentity,
  getSchedulerReadiness,
  getSchedulerRuntimeStatus,
  getStartupRuntimeStatus,
} from "@/lib/runtime-health";

export const dynamic = "force-dynamic";

const DATABASE_TIMEOUT_MS = 2_000;
const DATABASE_COLD_START_GRACE_MS = 5 * 60 * 1_000;

// Prisma does not cancel the underlying SQLite query when Promise.race's
// timeout wins. Reusing one outstanding probe prevents repeated readiness
// requests from queueing another query every few seconds while SQLite is busy.
// The tracked promise always resolves, so a late database failure cannot become
// an unhandled rejection after the HTTP request has already returned 503.
let databaseProbeInFlight: Promise<boolean> | null = null;
let databaseProbeHasSucceeded = false;

function databaseProbe(): Promise<boolean> {
  if (databaseProbeInFlight) return databaseProbeInFlight;

  const query = Promise.resolve()
    .then(() =>
      prisma.$queryRawUnsafe<Array<Record<string, number>>>("SELECT 1")
    )
    .then(
      () => {
        databaseProbeHasSucceeded = true;
        return true;
      },
      () => false
    );
  let tracked: Promise<boolean>;
  tracked = query.finally(() => {
    if (databaseProbeInFlight === tracked) databaseProbeInFlight = null;
  });
  databaseProbeInFlight = tracked;
  return tracked;
}

async function checkDatabase(): Promise<{
  ok: boolean;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const ok = await Promise.race([
      databaseProbe(),
      new Promise<false>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          DATABASE_TIMEOUT_MS
        );
        timeout.unref?.();
      }),
    ]);
    return { ok, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const [database, scheduler, backup, startup] = await Promise.all([
    checkDatabase(),
    Promise.resolve(getSchedulerRuntimeStatus()),
    Promise.resolve(getBackupRuntimeStatus()),
    Promise.resolve(getStartupRuntimeStatus()),
  ]);
  const schedulerReadiness = getSchedulerReadiness();
  const schedulerReady = schedulerReadiness.ok;
  const backupReady = !backup.required || backup.active;
  const startupReady = !startup.required || startup.active;
  const ok = database.ok && schedulerReady && backupReady && startupReady;
  // Render currently points its process health check at this strict dependency
  // endpoint. Give a newly-started process a bounded window to finish opening a
  // large SQLite/Litestream database without creating a restart loop. The grace
  // applies only to a database-only failure, ends after five minutes, and can
  // never reactivate after this process has completed one successful probe.
  const databaseColdStartGraceActive =
    !database.ok &&
    !databaseProbeHasSucceeded &&
    process.uptime() * 1_000 < DATABASE_COLD_START_GRACE_MS &&
    schedulerReady &&
    backupReady &&
    startupReady;
  const status = ok
    ? "ready"
    : databaseColdStartGraceActive
      ? "starting"
      : "not_ready";

  return NextResponse.json(
    {
      ok,
      status,
      ...getRuntimeIdentity(),
      checkedAt: new Date().toISOString(),
      checks: {
        database: {
          ...database,
          coldStartGraceActive: databaseColdStartGraceActive,
        },
        scheduler: {
          ok: schedulerReady,
          readinessReason: schedulerReadiness.reason,
          staleAfterMs: schedulerReadiness.staleAfterMs,
          failureThreshold: schedulerReadiness.failureThreshold,
          ...scheduler,
        },
        backup: {
          ok: backupReady,
          ...backup,
        },
        startup: {
          ok: startupReady,
          ...startup,
        },
      },
    },
    {
      status: ok || databaseColdStartGraceActive ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

export function resetReadinessStateForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Readiness state can only be reset in tests");
  }
  databaseProbeInFlight = null;
  databaseProbeHasSucceeded = false;
}
