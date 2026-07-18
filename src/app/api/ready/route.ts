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
const DATABASE_FAILURE_RETRY_MS = 60 * 1_000;

type DatabaseCheck = {
  ok: boolean;
  latencyMs: number;
  checkedAt: string;
  cached: boolean;
  retryAfter: string | null;
  probeInFlight: boolean;
  probeSkipped?: boolean;
  healthCheckCompatibilityActive?: boolean;
};

type DatabaseFailureCache = Omit<DatabaseCheck, "cached" | "probeInFlight"> & {
  retryAfterMs: number;
};

// Prisma does not cancel the underlying SQLite query when Promise.race's
// timeout wins. Reusing one outstanding probe prevents repeated readiness
// requests from queueing another query every few seconds while SQLite is busy;
// caching a completed failure extends that protection across Render's polling
// interval. The tracked promise always resolves, so a late database failure
// cannot become an unhandled rejection after the HTTP response is returned.
let databaseProbeInFlight: Promise<DatabaseCheck> | null = null;
let databaseProbeHasSucceeded = false;
let databaseFailureCache: DatabaseFailureCache | null = null;

function databaseProbe(): Promise<DatabaseCheck> {
  const now = Date.now();
  if (databaseFailureCache && now < databaseFailureCache.retryAfterMs) {
    return Promise.resolve({
      ok: false,
      latencyMs: databaseFailureCache.latencyMs,
      checkedAt: databaseFailureCache.checkedAt,
      cached: true,
      retryAfter: databaseFailureCache.retryAfter,
      probeInFlight: false,
    });
  }

  if (databaseProbeInFlight) return databaseProbeInFlight;

  const startedAt = Date.now();
  const query = Promise.resolve()
    .then(() =>
      prisma.$queryRawUnsafe<Array<Record<string, number>>>("SELECT 1")
    )
    .then(
      () => {
        databaseProbeHasSucceeded = true;
        databaseFailureCache = null;
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString(),
          cached: false,
          retryAfter: null,
          probeInFlight: false,
        };
      },
      () => {
        const completedAt = Date.now();
        const retryAfterMs = completedAt + DATABASE_FAILURE_RETRY_MS;
        databaseFailureCache = {
          ok: false,
          latencyMs: completedAt - startedAt,
          checkedAt: new Date(completedAt).toISOString(),
          retryAfter: new Date(retryAfterMs).toISOString(),
          retryAfterMs,
        };
        return {
          ok: false,
          latencyMs: databaseFailureCache.latencyMs,
          checkedAt: databaseFailureCache.checkedAt,
          cached: false,
          retryAfter: databaseFailureCache.retryAfter,
          probeInFlight: false,
        };
      }
    );
  let tracked: Promise<DatabaseCheck>;
  tracked = query.finally(() => {
    if (databaseProbeInFlight === tracked) databaseProbeInFlight = null;
  });
  databaseProbeInFlight = tracked;
  return tracked;
}

async function checkDatabase(): Promise<DatabaseCheck> {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      databaseProbe(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(
          () => resolve(null),
          DATABASE_TIMEOUT_MS
        );
        timeout.unref?.();
      }),
    ]);
    if (result) return result;
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      cached: false,
      retryAfter: null,
      probeInFlight: true,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      cached: false,
      retryAfter: null,
      probeInFlight: false,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function skippedDatabaseCheck(): DatabaseCheck {
  return {
    ok: false,
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
    cached: false,
    retryAfter: null,
    probeInFlight: false,
    probeSkipped: true,
    healthCheckCompatibilityActive: true,
  };
}

export async function GET(request: Request) {
  // Live evidence showed a native Prisma query could outlive JavaScript's
  // timeout and the host continued polling this route even after its service
  // metadata named /api/health. The temporary flag keeps strict diagnostics
  // without starting the blocking probe at all.
  const databaseHealthCheckCompatibilityRequested =
    process.env.RENDER_READINESS_HTTP_COMPATIBILITY === "true";
  const [database, scheduler, backup, startup] = await Promise.all([
    databaseHealthCheckCompatibilityRequested
      ? Promise.resolve(skippedDatabaseCheck())
      : checkDatabase(),
    Promise.resolve(getSchedulerRuntimeStatus()),
    Promise.resolve(getBackupRuntimeStatus()),
    Promise.resolve(getStartupRuntimeStatus()),
  ]);
  const schedulerReadiness = getSchedulerReadiness();
  const schedulerReady = schedulerReadiness.ok;
  const backupReady = !backup.required || backup.active;
  const startupReady = !startup.required || startup.active;
  const ok = database.ok && schedulerReady && backupReady && startupReady;
  const databaseOnlyFailure =
    !database.ok && schedulerReady && backupReady && startupReady;
  // Render currently points its process health check at this strict dependency
  // endpoint. Give a newly-started process a bounded window to finish opening a
  // large SQLite/Litestream database without creating a restart loop. The grace
  // applies only to a database-only failure, ends after five minutes, and can
  // never reactivate after this process has completed one successful probe.
  const databaseColdStartGraceActive =
    databaseOnlyFailure &&
    !databaseHealthCheckCompatibilityRequested &&
    !databaseProbeHasSucceeded &&
    process.uptime() * 1_000 < DATABASE_COLD_START_GRACE_MS;
  const status = ok
    ? "ready"
    : databaseColdStartGraceActive
      ? "starting"
      : "not_ready";
  // Render's internal liveness probe must keep receiving HTTP 200 from the
  // historical route, but independent uptime monitors need transport-level
  // failure semantics. `?strict=1` is public and returns 503 whenever the
  // dependency body says not ready; it adds no extra database work because it
  // reuses this request's already-bounded probe result.
  const strictTransport =
    new URL(request.url).searchParams.get("strict") === "1";

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
          // Provider-fetch degradation (most attempted provider polls
          // failing) never flips `ok` above - this app is still serving,
          // the outage is upstream. It's surfaced here so a monitor can
          // alert on it independently of readiness.
          providerFetchDegraded: schedulerReadiness.providerFetchDegraded,
          providerFetchDegradedTickThreshold:
            schedulerReadiness.providerFetchDegradedTickThreshold,
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
      // Render's live service configuration still points its process health
      // check at /api/ready even though render.yaml now names /api/health.
      // A dependency-level 503 here therefore kills the only SQLite process
      // and can turn a temporary lock into a restart loop. Keep the body
      // semantically strict (`ok`, `status`, and every check) while making the
      // transport status liveness-safe until Render applies the configured
      // health-check path.
      status: strictTransport && !ok ? 503 : 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Readiness-Status": status,
      },
    }
  );
}

if (process.env.NODE_ENV === "test") {
  (globalThis as any).resetReadinessStateForTests = () => {
    databaseProbeInFlight = null;
    databaseProbeHasSucceeded = false;
    databaseFailureCache = null;
  };
}
