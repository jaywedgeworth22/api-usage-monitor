import { AsyncLocalStorage } from "node:async_hooks";

interface IngestAdmissionState {
  owner: symbol | null;
  internalWaiters: Array<{
    owner: symbol;
    resolve: (release: () => void) => void;
  }>;
}

const globalForIngestAdmission = globalThis as typeof globalThis & {
  __apiUsageMonitorIngestAdmission?: IngestAdmissionState;
  __apiUsageMonitorInternalAdmissionContext?: AsyncLocalStorage<symbol>;
};

const state =
  globalForIngestAdmission.__apiUsageMonitorIngestAdmission ??
  (globalForIngestAdmission.__apiUsageMonitorIngestAdmission = {
    owner: null,
    internalWaiters: [],
  });

state.internalWaiters ??= [];

const internalAdmissionContext =
  globalForIngestAdmission.__apiUsageMonitorInternalAdmissionContext ??
  (globalForIngestAdmission.__apiUsageMonitorInternalAdmissionContext =
    new AsyncLocalStorage<symbol>());

export const INGEST_ADMISSION_RETRY_AFTER_SECONDS = 5;
export const OTLP_METRICS_DISABLED_RETRY_AFTER_SECONDS = 300;

/**
 * Emergency receiver isolation is opt-out so deployments remain backward
 * compatible until an operator explicitly sets the variable to false.
 */
export function isOtlpMetricsIngestEnabled(
  configured = process.env.OTLP_METRICS_INGEST_ENABLED
): boolean {
  return configured?.trim().toLowerCase() !== "false";
}

/**
 * Serialize SQLite-writing ingest work within this process. The Render
 * service has one instance and one SQLite file, so rejecting overlapping
 * writers is safer than queuing requests whose exporters may time out and
 * retry while the original write is still running.
 */
export function tryAcquireIngestAdmission(): (() => void) | null {
  if (state.owner !== null || state.internalWaiters.length > 0) return null;

  const owner = Symbol("ingest-admission-owner");
  state.owner = owner;
  return releaseFor(owner);
}

function releaseFor(owner: symbol): () => void {
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (state.owner !== owner) return;
    const next = state.internalWaiters.shift();
    if (!next) {
      state.owner = null;
      return;
    }
    state.owner = next.owner;
    next.resolve(releaseFor(next.owner));
  };
}

async function acquireInternalUsageWriteAdmissionLease(): Promise<{
  owner: symbol;
  release: () => void;
}> {
  const owner = Symbol("internal-usage-write-admission-owner");
  if (state.owner === null && state.internalWaiters.length === 0) {
    state.owner = owner;
    return { owner, release: releaseFor(owner) };
  }

  const release = await new Promise<() => void>((resolve) => {
    state.internalWaiters.push({ owner, resolve });
  });
  return { owner, release };
}

export async function acquireInternalUsageWriteAdmission(): Promise<() => void> {
  return (await acquireInternalUsageWriteAdmissionLease()).release;
}

export async function withInternalUsageWriteAdmission<T>(
  work: () => Promise<T>
): Promise<T> {
  const inheritedOwner = internalAdmissionContext.getStore();
  if (inheritedOwner && state.owner === inheritedOwner) {
    return work();
  }

  const { owner, release } = await acquireInternalUsageWriteAdmissionLease();
  try {
    return await internalAdmissionContext.run(owner, work);
  } finally {
    release();
  }
}
