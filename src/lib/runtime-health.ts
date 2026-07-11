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
  lastRun: SchedulerRunSummary | null;
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
  state.scheduler.lastRun = lastRun;
}

export function getSchedulerRuntimeStatus(): SchedulerRuntimeStatus {
  return {
    ...state.scheduler,
    lastRun: state.scheduler.lastRun ? { ...state.scheduler.lastRun } : null,
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
    lastRun: null,
  };
}
