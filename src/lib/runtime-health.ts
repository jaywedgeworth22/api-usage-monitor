import packageJson from "../../package.json";

export interface SchedulerRunSummary {
  total: number;
  successes: number;
  failures: number;
  skipped: number;
}

export interface SchedulerRuntimeStatus {
  startedAt: string | null;
  tickInProgress: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickSucceeded: boolean | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  lastRun: SchedulerRunSummary | null;
}

export interface SchedulerReadiness {
  ok: boolean;
  reason: "not_started" | "repeated_tick_failures" | "tick_stalled" | "tick_stale" | null;
  staleAfterMs: number;
  failureThreshold: number;
}

const DEFAULT_SCHEDULER_STALE_AFTER_MS = 45 * 60 * 1_000;
const DEFAULT_SCHEDULER_FAILURE_THRESHOLD = 3;

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
      lastRun: null,
    },
  });

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
  state.scheduler.lastRun = lastRun;
}

export function getSchedulerRuntimeStatus(): SchedulerRuntimeStatus {
  return {
    ...state.scheduler,
    lastRun: state.scheduler.lastRun ? { ...state.scheduler.lastRun } : null,
  };
}

export function getSchedulerReadiness(now = new Date()): SchedulerReadiness {
  const scheduler = state.scheduler;
  const staleAfterMs = schedulerStaleAfterMs();
  const failureThreshold = schedulerFailureThreshold();
  if (!scheduler.startedAt) {
    return { ok: false, reason: "not_started", staleAfterMs, failureThreshold };
  }
  if (
    scheduler.tickInProgress &&
    scheduler.lastTickStartedAt &&
    now.getTime() - new Date(scheduler.lastTickStartedAt).getTime() > staleAfterMs
  ) {
    return { ok: false, reason: "tick_stalled", staleAfterMs, failureThreshold };
  }
  if (
    !scheduler.tickInProgress &&
    scheduler.lastTickCompletedAt &&
    now.getTime() - new Date(scheduler.lastTickCompletedAt).getTime() > staleAfterMs
  ) {
    return { ok: false, reason: "tick_stale", staleAfterMs, failureThreshold };
  }
  if (scheduler.consecutiveFailures >= failureThreshold) {
    return {
      ok: false,
      reason: "repeated_tick_failures",
      staleAfterMs,
      failureThreshold,
    };
  }
  return { ok: true, reason: null, staleAfterMs, failureThreshold };
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

export function getBackupRuntimeStatus(): {
  required: boolean;
  active: boolean;
} {
  return {
    required: process.env.LITESTREAM_REQUIRED === "true",
    active: process.env.LITESTREAM_ACTIVE === "true",
  };
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
    lastRun: null,
  };
}
