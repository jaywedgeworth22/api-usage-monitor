import type { AdapterError, AdapterErrorCode } from "@/lib/adapters/helpers";

const USAGE_MONITOR_SNAPSHOT_META_KEY = "__apiUsageMonitor";

export interface SnapshotPartialFailure {
  code: AdapterErrorCode;
  status: number | null;
  retryable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function withSnapshotSyncFailure(
  rawData: unknown,
  postPersistError: AdapterError | undefined
): unknown {
  const adapterRawData = asRecord(rawData);
  const sanitizedAdapterRawData = adapterRawData
    ? Object.fromEntries(
        Object.entries(adapterRawData).filter(
          ([key]) => key !== USAGE_MONITOR_SNAPSHOT_META_KEY
        )
      )
    : null;
  if (!postPersistError) {
    return sanitizedAdapterRawData ?? rawData;
  }

  return {
    ...(sanitizedAdapterRawData ??
      (rawData == null ? {} : { adapterRawData: rawData })),
    [USAGE_MONITOR_SNAPSHOT_META_KEY]: {
      version: 1,
      partialFailure: {
        code: postPersistError.code,
        status: postPersistError.status,
        retryable: postPersistError.retryable,
      },
    },
  };
}

export function snapshotPartialFailure(
  rawData: unknown
): SnapshotPartialFailure | null {
  const metadata = asRecord(
    asRecord(rawData)?.[USAGE_MONITOR_SNAPSHOT_META_KEY]
  );
  const failure = asRecord(metadata?.partialFailure);
  if (
    metadata?.version !== 1 ||
    typeof failure?.code !== "string" ||
    !(failure.status === null || Number.isSafeInteger(failure.status)) ||
    typeof failure.retryable !== "boolean"
  ) {
    return null;
  }

  return {
    code: failure.code as AdapterErrorCode,
    status: failure.status as number | null,
    retryable: failure.retryable,
  };
}

export function isRetryablePartialSnapshot(rawData: unknown): boolean {
  return snapshotPartialFailure(rawData)?.retryable === true;
}
