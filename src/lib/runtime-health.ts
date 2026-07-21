import { existsSync, readFileSync, statSync } from "node:fs";
import packageJson from "../../package.json";
import type { CloudflareLegacyHandoffStatus } from "@/lib/external-billing-subscription-adoption";

export interface SchedulerRunSummary {
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  maintenanceHealthy: boolean;
  // Whether THIS tick's provider-fetch phase (successes/failures ratio,
  // skipped excluded) was degraded - see isProviderFetchTickDegraded in
  // usage-recorder.ts. Distinct from maintenanceHealthy: a tick can succeed
  // (maintenance healthy) while most provider polls still failed.
  providerFetchDegraded: boolean;
  cloudflareLegacyHandoff: CloudflareLegacyHandoffStatus;
}

export interface SchedulerRuntimeStatus {
  startedAt: string | null;
  tickInProgress: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickSucceeded: boolean | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  // Streak of consecutive ticks whose provider-fetch phase was degraded.
  // Kept separate from consecutiveFailures/lastTickSucceeded so an upstream
  // provider-fetch outage never flips lastTickSucceeded or feeds the
  // repeated_tick_failures readiness reason - see runUsagePollingSchedulerTick.
  consecutiveProviderFetchDegradedTicks: number;
  firstProviderFetchDegradedAt: string | null;
  lastRun: SchedulerRunSummary | null;
}

export interface SchedulerReadiness {
  ok: boolean;
  reason:
    | "not_started"
    | "repeated_tick_failures"
    | "tick_stalled"
    | "tick_stale"
    | "provider_fetch_degraded"
    | null;
  staleAfterMs: number;
  failureThreshold: number;
  // True once consecutiveProviderFetchDegradedTicks has reached
  // providerFetchDegradedTickThreshold. Reported independently of `reason`
  // (which only names one primary cause) so callers can see a provider-fetch
  // outage even while some other condition is the reported blocking reason.
  providerFetchDegraded: boolean;
  providerFetchDegradedTickThreshold: number;
}

const DEFAULT_SCHEDULER_STALE_AFTER_MS = 45 * 60 * 1_000;
const DEFAULT_SCHEDULER_FAILURE_THRESHOLD = 3;
// Bounded so a single flaky provider poll (one degraded tick) can't flap
// /api/ready's scheduler.readinessReason - only a sustained run of degraded
// ticks (default: 3 in a row, ~45min at the 15min poll cadence) surfaces it.
const DEFAULT_PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD = 3;

function schedulerStaleAfterMs(): number {
  const configured = Number(process.env.SCHEDULER_STALE_AFTER_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SCHEDULER_STALE_AFTER_MS;
}

function schedulerFailureThreshold(): number {
  const configured = Number(process.env.SCHEDULER_FAILURE_THRESHOLD);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_SCHEDULER_FAILURE_THRESHOLD;
}

function providerFetchDegradedTickThreshold(): number {
  const configured = Number(
    process.env.PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD;
}

interface RuntimeHealthState {
  scheduler: SchedulerRuntimeStatus;
}

const globalForRuntimeHealth = globalThis as typeof globalThis & {
  __apiUsageMonitorRuntimeHealth?: RuntimeHealthState;
};

const state =
  globalForRuntimeHealth.__apiUsageMonitorRuntimeHealth ??
  (globalForRuntimeHealth.__apiUsageMonitorRuntimeHealth = {
    scheduler: {
      startedAt: null,
      tickInProgress: false,
      lastTickStartedAt: null,
      lastTickCompletedAt: null,
      lastTickSucceeded: null,
      consecutiveFailures: 0,
      firstFailureAt: null,
      consecutiveProviderFetchDegradedTicks: 0,
      firstProviderFetchDegradedAt: null,
      lastRun: null,
    },
  });

function normalizeSchedulerRunSummary(
  summary: SchedulerRunSummary
): SchedulerRunSummary {
  return {
    total: summary.total,
    successes: summary.successes,
    failures: summary.failures,
    skipped: summary.skipped,
    maintenanceHealthy: summary.maintenanceHealthy,
    providerFetchDegraded: summary.providerFetchDegraded,
    cloudflareLegacyHandoff: summary.cloudflareLegacyHandoff,
  };
}

export function markSchedulerStarted(at = new Date()): void {
  state.scheduler.startedAt ??= at.toISOString();
}

export function markSchedulerTickStarted(at = new Date()): void {
  state.scheduler.tickInProgress = true;
  state.scheduler.lastTickStartedAt = at.toISOString();
}

export function markSchedulerTickCompleted(
  succeeded: boolean,
  lastRun: SchedulerRunSummary | null,
  at = new Date()
): void {
  state.scheduler.tickInProgress = false;
  state.scheduler.lastTickCompletedAt = at.toISOString();
  state.scheduler.lastTickSucceeded = succeeded;
  if (succeeded) {
    state.scheduler.consecutiveFailures = 0;
    state.scheduler.firstFailureAt = null;
  } else {
    state.scheduler.consecutiveFailures += 1;
    state.scheduler.firstFailureAt ??= at.toISOString();
  }
  // A tick with no lastRun (fetch/maintenance threw before producing a
  // summary) carries no provider-fetch signal at all, so it resets the
  // streak rather than extending or clearing it as "recovered" - there is no
  // basis to claim either.
  if (lastRun?.providerFetchDegraded) {
    state.scheduler.consecutiveProviderFetchDegradedTicks += 1;
    state.scheduler.firstProviderFetchDegradedAt ??= at.toISOString();
  } else {
    state.scheduler.consecutiveProviderFetchDegradedTicks = 0;
    state.scheduler.firstProviderFetchDegradedAt = null;
  }
  state.scheduler.lastRun = lastRun
    ? normalizeSchedulerRunSummary(lastRun)
    : null;
}

export function getSchedulerRuntimeStatus(): SchedulerRuntimeStatus {
  return {
    ...state.scheduler,
    lastRun: state.scheduler.lastRun
      ? normalizeSchedulerRunSummary(state.scheduler.lastRun)
      : null,
  };
}

export function getSchedulerReadiness(now = new Date()): SchedulerReadiness {
  const scheduler = state.scheduler;
  const staleAfterMs = schedulerStaleAfterMs();
  const failureThreshold = schedulerFailureThreshold();
  const degradedTickThreshold = providerFetchDegradedTickThreshold();
  const providerFetchDegraded =
    scheduler.consecutiveProviderFetchDegradedTicks >= degradedTickThreshold;
  if (!scheduler.startedAt) {
    return {
      ok: false,
      reason: "not_started",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  if (
    scheduler.tickInProgress &&
    scheduler.lastTickStartedAt &&
    now.getTime() - new Date(scheduler.lastTickStartedAt).getTime() > staleAfterMs
  ) {
    return {
      ok: false,
      reason: "tick_stalled",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  if (
    !scheduler.tickInProgress &&
    scheduler.lastTickCompletedAt &&
    now.getTime() - new Date(scheduler.lastTickCompletedAt).getTime() > staleAfterMs
  ) {
    return {
      ok: false,
      reason: "tick_stale",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  if (scheduler.consecutiveFailures >= failureThreshold) {
    return {
      ok: false,
      reason: "repeated_tick_failures",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  // Provider-fetch degradation never takes the service unready on its own -
  // this app is still serving correctly, the outage is upstream. It only
  // gets its own readinessReason once sustained (see
  // providerFetchDegradedTickThreshold) so a monitor reading this endpoint
  // can alert on it without the deploy being marked not-ready.
  if (providerFetchDegraded) {
    return {
      ok: true,
      reason: "provider_fetch_degraded",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  return {
    ok: true,
    reason: null,
    staleAfterMs,
    failureThreshold,
    providerFetchDegraded,
    providerFetchDegradedTickThreshold: degradedTickThreshold,
  };
}

export function getRuntimeIdentity(): {
  service: string;
  version: string;
  revision: string | null;
  environment: string;
} {
  return {
    service: process.env.RENDER_SERVICE_NAME || "api-usage-monitor",
    version: packageJson.version,
    revision:
      process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT_SHA || null,
    environment: process.env.NODE_ENV || "development",
  };
}

export interface BackupRuntimeStatus {
  required: boolean;
  active: boolean;
  /**
   * True when readiness only knows the startup env flag (`LITESTREAM_ACTIVE`),
   * not a side-channel proof that the Garage/R2 replica is advancing.
   * Monitors should not treat env-only backup as replica health (Wave C / C4).
   */
  envOnly: boolean;
  /** null = no side-channel configured; false = side-channel says unhealthy/stale. */
  replicaOk: boolean | null;
  replicaAgeSeconds: number | null;
  reason: string | null;
}

/**
 * Backup readiness. Prefer an optional side-channel status file written by the
 * host/Litestream/Garage monitor (`LITESTREAM_REPLICA_STATUS_PATH`) so `/api/ready`
 * does not lie when only `LITESTREAM_ACTIVE=true` is set.
 *
 * Status file formats (either):
 * - JSON: `{ "ok": true, "ageSeconds": 42, "checkedAt": "ISO" }`
 * - Heartbeat: any file whose mtime is treated as last-success; age is now-mtime.
 *
 * `LITESTREAM_REPLICA_MAX_AGE_SECONDS` (default 3600) fails the side-channel when
 * age exceeds the budget.
 */
export function getBackupRuntimeStatus(now = new Date()): BackupRuntimeStatus {
  const required = process.env.LITESTREAM_REQUIRED === "true";
  const active = process.env.LITESTREAM_ACTIVE === "true";
  const statusPath = process.env.LITESTREAM_REPLICA_STATUS_PATH?.trim() || null;
  const maxAgeRaw = process.env.LITESTREAM_REPLICA_MAX_AGE_SECONDS?.trim();
  const maxAgeSeconds = maxAgeRaw
    ? Number.parseInt(maxAgeRaw, 10)
    : 3600;
  const maxAge =
    Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? maxAgeSeconds : 3600;

  if (!statusPath) {
    return {
      required,
      active,
      envOnly: true,
      replicaOk: null,
      replicaAgeSeconds: null,
      reason: active ? "env_active_unverified" : null,
    };
  }

  try {
    if (!existsSync(statusPath)) {
      return {
        required,
        active,
        envOnly: false,
        replicaOk: false,
        replicaAgeSeconds: null,
        reason: "replica_status_missing",
      };
    }

    const raw = readFileSync(statusPath, "utf8").trim();
    let ageSeconds: number | null = null;
    let sideOk = true;

    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as {
        ok?: unknown;
        ageSeconds?: unknown;
        checkedAt?: unknown;
      };
      if (typeof parsed.ok === "boolean") {
        sideOk = parsed.ok;
      }
      if (
        typeof parsed.ageSeconds === "number" &&
        Number.isFinite(parsed.ageSeconds) &&
        parsed.ageSeconds >= 0
      ) {
        ageSeconds = parsed.ageSeconds;
      } else if (typeof parsed.checkedAt === "string") {
        const checkedMs = Date.parse(parsed.checkedAt);
        if (Number.isFinite(checkedMs)) {
          ageSeconds = Math.max(0, (now.getTime() - checkedMs) / 1000);
        }
      }
    } else {
      const mtimeMs = statSync(statusPath).mtimeMs;
      ageSeconds = Math.max(0, (now.getTime() - mtimeMs) / 1000);
    }

    if (ageSeconds != null && ageSeconds > maxAge) {
      sideOk = false;
    }

    return {
      required,
      active,
      envOnly: false,
      replicaOk: sideOk,
      replicaAgeSeconds: ageSeconds,
      reason: sideOk
        ? null
        : ageSeconds != null && ageSeconds > maxAge
          ? "replica_status_stale"
          : "replica_status_unhealthy",
    };
  } catch {
    return {
      required,
      active,
      envOnly: false,
      replicaOk: false,
      replicaAgeSeconds: null,
      reason: "replica_status_unreadable",
    };
  }
}

export function getStartupRuntimeStatus(): {
  required: boolean;
  active: boolean;
  entrypoint: string | null;
} {
  const entrypoint = process.env.APP_STARTUP_WRAPPER || null;
  return {
    required: process.env.RENDER === "true",
    active: entrypoint === "start-with-litestream-v2",
    entrypoint,
  };
}

export function resetRuntimeHealthForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Runtime health state can only be reset in tests");
  }
  state.scheduler = {
    startedAt: null,
    tickInProgress: false,
    lastTickStartedAt: null,
    lastTickCompletedAt: null,
    lastTickSucceeded: null,
    consecutiveFailures: 0,
    firstFailureAt: null,
    consecutiveProviderFetchDegradedTicks: 0,
    firstProviderFetchDegradedAt: null,
    lastRun: null,
  };
}
