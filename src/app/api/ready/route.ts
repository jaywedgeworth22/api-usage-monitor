import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
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

// ---------------------------------------------------------------------------
// Per-IP rate limiting: max 30 requests per 60-second window.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const readyRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS
);

// ---------------------------------------------------------------------------
// Short-lived success cache: avoids re-querying SQLite when identical probes
// arrive within a brief window. Only successful responses are cached; failures
// and "starting" states always run live so callers see recovery immediately.
// ---------------------------------------------------------------------------
const SUCCESS_CACHE_TTL_MS = 5_000;
let successResponseCache: { body: object; expiresAt: number } | null = null;

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
  // -----------------------------------------------------------------------
  // Per-IP rate limiting — reject excessive polling before doing any work.
  // -----------------------------------------------------------------------
  const clientIp = getClientIp(request);
  if (process.env.NODE_ENV !== "test" && !readyRateLimiter.check(clientIp)) {
    const retryAfterSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1_000);
    return NextResponse.json(
      {
        error: "Too Many Requests",
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
        },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Success cache — serve the most recent successful response for a short
  // TTL to avoid redundant SQLite probes from rapid polling.
  // -----------------------------------------------------------------------
  const strictTransport =
    new URL(request.url).searchParams.get("strict") === "1";

  if (
    process.env.NODE_ENV !== "test" &&
    successResponseCache &&
    Date.now() < successResponseCache.expiresAt
  ) {
    return NextResponse.json(successResponseCache.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Readiness-Status": "ready",
        "X-Response-Cached": "true",
      },
    });
  }

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
  // A preview/cold-standby host deliberately disables its scheduler to avoid
  // becoming a second SQLite writer. That intentional circuit breaker must not
  // make strict HTTP readiness fail; production keeps the default-required
  // behavior whenever the flag is unset or true.
  const schedulerRequired =
    process.env.USAGE_SCHEDULER_ENABLED?.trim().toLowerCase() !== "false";
  const schedulerReady = !schedulerRequired || schedulerReadiness.ok;
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

  const body = {
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
        required: schedulerRequired,
        readinessReason: schedulerRequired
          ? schedulerReadiness.reason
          : "disabled",
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
  };

  // Cache successful responses for a short TTL to absorb rapid polling.
  if (ok) {
    successResponseCache = {
      body,
      expiresAt: Date.now() + SUCCESS_CACHE_TTL_MS,
    };
  }

  return NextResponse.json(body, {
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
  });
}

if (process.env.NODE_ENV === "test") {
  (globalThis as any).resetReadinessStateForTests = () => {
    databaseProbeInFlight = null;
    databaseProbeHasSucceeded = false;
    databaseFailureCache = null;
    successResponseCache = null;
  };
}
