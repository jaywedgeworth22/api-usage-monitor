interface IngestAdmissionState {
  owner: symbol | null;
}

const globalForIngestAdmission = globalThis as typeof globalThis & {
  __apiUsageMonitorIngestAdmission?: IngestAdmissionState;
};

const state =
  globalForIngestAdmission.__apiUsageMonitorIngestAdmission ??
  (globalForIngestAdmission.__apiUsageMonitorIngestAdmission = { owner: null });

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
  if (state.owner !== null) return null;

  const owner = Symbol("ingest-admission-owner");
  state.owner = owner;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (state.owner === owner) state.owner = null;
  };
}
