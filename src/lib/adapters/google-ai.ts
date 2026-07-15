import {
  AdapterError,
  fetchJson,
  headerNumber,
  type AdapterInvocationContext,
  type UsageResult,
} from "./helpers";
import {
  fetchGoogleCloudBilling,
  hasGoogleCloudBillingConfig,
} from "./google-cloud-billing";
import {
  geminiApiKeyFingerprint,
  geminiBillingConfigFingerprint,
} from "@/lib/gemini-key-status";

type KeyValidationOutcome =
  | "valid"
  | "invalid"
  | "unavailable"
  | "unreadable"
  | "not_configured";

function adapterError(error: unknown, fallback: string): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError(fallback, {
    code: "TRANSPORT_ERROR",
    retryable: true,
    cause: error,
  });
}

function keyValidationOutcome(response: {
  ok: boolean;
  status: number;
} | null): KeyValidationOutcome {
  if (response?.ok) return "valid";
  if (response && [400, 401, 403].includes(response.status)) return "invalid";
  return "unavailable";
}

function combinedPartialError(errors: AdapterError[]): AdapterError | undefined {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AdapterError(
    `Gemini partial sync failed: ${errors.map((error) => error.message).join("; ")}`,
    {
      code: errors[0].code,
      status: errors[0].status,
      retryable: errors.some((error) => error.retryable),
    }
  );
}

export async function fetchUsage(
  apiKey: string,
  config: Record<string, unknown> = {},
  context?: AdapterInvocationContext
): Promise<UsageResult> {
  // Listing model metadata is a non-inference control-plane read. A Gemini
  // key does not expose billing, regardless of whether it was created in
  // Google Cloud Console or Google AI Studio. When configured, actual spend
  // comes from a read-only Cloud Billing BigQuery export.
  const apiKeyConfigured = context?.apiKeyConfigured ?? apiKey.trim() !== "";
  const apiKeyReadable = context?.apiKeyReadable ?? true;
  const canValidateKey = apiKeyConfigured && apiKeyReadable && apiKey.trim() !== "";
  const secretConfigReadable = context?.secretConfigReadable ?? true;
  const billingConfigured =
    hasGoogleCloudBillingConfig(config) ||
    (context?.secretConfigConfigured === true && !secretConfigReadable);
  const canFetchBilling = billingConfigured && secretConfigReadable;
  const billingConfigFingerprint = canFetchBilling
    ? geminiBillingConfigFingerprint(config)
    : null;
  const unreadableKeyError =
    apiKeyConfigured && !canValidateKey
      ? new AdapterError("Stored Gemini API key cannot be decrypted", {
          code: "CONFIGURATION_ERROR",
          retryable: false,
        })
      : null;
  const unreadableBillingError =
    billingConfigured && !secretConfigReadable
      ? new AdapterError("Stored Google Cloud billing credential cannot be decrypted", {
          code: "CONFIGURATION_ERROR",
          retryable: false,
        })
      : null;
  const modelRequest = canValidateKey
    ? fetchJson(
        "https://generativelanguage.googleapis.com/v1beta/models",
        {
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
        }
      ).then(
        (value) => ({ value, error: null }),
        (error) => ({
          value: null,
          error: adapterError(error, "Gemini API key validation failed"),
        })
      )
    : Promise.resolve({ value: null, error: unreadableKeyError });
  const [modelOutcome, billingOutcome] = await Promise.all([
    modelRequest,
    canFetchBilling
      ? fetchGoogleCloudBilling(config).then(
          (value) => ({ value, error: null }),
          (error) => ({
            value: null,
            error: adapterError(error, "Google Cloud Billing sync failed"),
          })
        )
      : Promise.resolve({ value: null, error: unreadableBillingError }),
  ]);

  const response = modelOutcome.value;
  const billing = billingOutcome.value;
  const validationOutcome: KeyValidationOutcome = !apiKeyConfigured
    ? "not_configured"
    : !canValidateKey
      ? "unreadable"
      : keyValidationOutcome(response);
  const keyValidationError =
    validationOutcome === "invalid"
      ? new AdapterError(
          `Gemini API key was rejected with HTTP ${response?.status ?? "unknown"}`,
          {
            code: "HTTP_ERROR",
            status: response?.status ?? null,
            retryable: false,
          }
        )
      : validationOutcome === "unavailable"
      ? modelOutcome.error ??
        new AdapterError(
          `Gemini API key check returned HTTP ${response?.status ?? "unknown"}`,
          {
            code: "HTTP_ERROR",
            status: response?.status ?? null,
            retryable:
              response?.status === 429 || (response?.status ?? 0) >= 500,
          }
        )
      : validationOutcome === "unreadable"
        ? unreadableKeyError
        : null;
  const partialErrors = [keyValidationError, billingOutcome.error].filter(
    (error): error is AdapterError => error != null
  );
  const data = (response?.data ?? {}) as { models?: unknown[] };
  const headers = response?.headers ?? new Headers();
  // Treat quota headers as authoritative only on a successful credential
  // check. Error responses may carry gateway/account-level headers that do
  // not describe this key's usable Gemini quota.
  const remaining =
    validationOutcome === "valid"
      ? headerNumber(headers, ["x-ratelimit-remaining"])
      : null;
  const limit =
    validationOutcome === "valid"
      ? headerNumber(headers, ["x-ratelimit-limit"])
      : null;
  const reset =
    validationOutcome === "valid"
      ? headers.get("x-ratelimit-reset")
      : null;

  return {
    balance: null,
    totalCost: billing?.totalCostUsd ?? null,
    costWindowStart: billing?.windowStart ?? null,
    costWindowEnd: billing?.windowEnd ?? null,
    costScope: billing ? "calendar_month_to_date" : undefined,
    totalRequests: null,
    credits: remaining,
    rawData: {
      keyValidation: {
        ok: response?.ok ?? false,
        outcome: validationOutcome,
        status: response?.status ?? modelOutcome.error?.status ?? null,
        errorCode: modelOutcome.error?.code ?? null,
        retryable: keyValidationError?.retryable ?? false,
        credentialFingerprint: canValidateKey
          ? geminiApiKeyFingerprint(apiKey)
          : null,
        availableModelCount:
          response?.ok && Array.isArray(data.models) ? data.models.length : null,
      },
      rateLimit: { remaining, limit, reset },
      billing: billing
        ? {
            configured: true,
            status: billing.status,
            configFingerprint: billingConfigFingerprint,
            source: "standard-bigquery-export",
            dataset: billing.dataset,
            tableId: billing.tableId,
            queryProjectId: billing.queryProjectId,
            observedProjectCount: billing.projectCount,
            skuCount: billing.rows.length,
            reportThrough: billing.reportThrough,
            maximumBytesBilled: 1_073_741_824,
          }
        : billingConfigured && billingOutcome.error
          ? {
              configured: true,
              status: "error",
              configFingerprint: billingConfigFingerprint,
              errorCode: billingOutcome.error.code,
              httpStatus: billingOutcome.error.status,
              retryable: billingOutcome.error.retryable,
            }
          : {
            configured: false,
            note: "A Gemini API key does not expose account billing. Configure the standard Cloud Billing BigQuery export for direct spend.",
          },
      capabilities: {
        nonBillableKeyValidation: validationOutcome === "valid",
        billingCost: billing?.status === "ready",
        subscriptionStatus: false,
      },
    },
    postPersistError: combinedPartialError(partialErrors),
    externalBilling: billing?.externalBilling,
    externalBillingSyncs: validationOutcome === "valid"
      ? [{
          source: "google-gemini-rate-limits",
          authoritative: true,
          records:
            limit == null
              ? []
              : [
                  {
                    externalId: "gemini-api-key",
                    kind: "account",
                    planName: "Gemini API quota",
                    status: "active",
                    requestLimit: limit,
                    requestLimitWindow: "provider-defined",
                  },
                ],
        }]
      : undefined,
  };
}
