export interface RawDataRedactionPolicy {
  redacted: boolean;
  strategy: "allowlist" | "strip_all" | "preserve";
  retainedFields?: string[];
  droppedFields?: string[];
}

/**
 * Returns a new object with the `__apiUsageMonitor.privacy` metadata injected.
 */
function applyPrivacyMetadata(
  rawData: unknown,
  policy: RawDataRedactionPolicy
): unknown {
  if (rawData == null || typeof rawData !== "object") {
    return rawData;
  }

  const original = rawData as Record<string, unknown>;
  const apiUsageMonitor =
    original.__apiUsageMonitor && typeof original.__apiUsageMonitor === "object"
      ? (original.__apiUsageMonitor as Record<string, unknown>)
      : {};

  return {
    ...original,
    __apiUsageMonitor: {
      ...apiUsageMonitor,
      privacy: policy,
    },
  };
}

/**
 * Redacts provider rawData before persistence to minimize PII/secret exposure.
 *
 * For known built-ins, we can preserve the raw payload or apply specific rules.
 * For `custom` adapters, we strip all non-standard fields by default,
 * exposing only the metadata block.
 */
export function redactProviderRawData(
  providerType: string,
  providerName: string,
  rawData: unknown
): unknown {
  if (rawData == null) return rawData;

  const type = (providerType || "").trim().toLowerCase();
  const name = (providerName || "").trim().toLowerCase();

  // If it's a custom endpoint, strip the raw body entirely and leave only
  // the usage monitor metadata block to prevent arbitrary credential or PII
  // retention from unverified APIs.
  if (type === "custom" || name === "custom") {
    const original = (typeof rawData === "object" ? rawData : {}) as Record<string, unknown>;
    const redactedPayload: Record<string, unknown> = {};

    // Always preserve our internal metadata block
    if (original.__apiUsageMonitor) {
      redactedPayload.__apiUsageMonitor = original.__apiUsageMonitor;
    }

    return applyPrivacyMetadata(redactedPayload, {
      redacted: true,
      strategy: "strip_all",
    });
  }

  // Built-in providers keep their payload for observability, but we document
  // the retention provenance.
  return applyPrivacyMetadata(rawData, {
    redacted: false,
    strategy: "preserve",
  });
}
