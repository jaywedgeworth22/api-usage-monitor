import { describe, expect, it } from "vitest";
import {
  deriveGeminiBillingStatus,
  deriveGeminiKeyStatus,
  geminiApiKeyFingerprint,
  geminiBillingConfigFingerprint,
} from "@/lib/gemini-key-status";

const currentKey = "test-current-cloud-console-key";

function snapshot(
  apiKey: string,
  validation: { ok: boolean; status: number; availableModelCount: number | null }
) {
  return {
    fetchedAt: new Date("2026-07-14T23:00:00.000Z"),
    rawData: {
      keyValidation: {
        ...validation,
        credentialFingerprint: geminiApiKeyFingerprint(apiKey),
        privateResponseBody: "must-not-be-returned",
      },
    },
  };
}

describe("deriveGeminiKeyStatus", () => {
  it("returns a sanitized valid result bound to the current key", () => {
    const status = deriveGeminiKeyStatus({
      providerName: "google-ai",
      providerType: "builtin",
      apiKey: currentKey,
      latestSnapshot: snapshot(currentKey, {
        ok: true,
        status: 200,
        availableModelCount: 50,
      }),
    });

    expect(status).toEqual({
      state: "valid",
      httpStatus: 200,
      availableModelCount: 50,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain("fingerprint");
    expect(JSON.stringify(status)).not.toContain("must-not-be-returned");
    expect(JSON.stringify(status)).not.toContain(currentKey);
  });

  it("marks a replacement key unchecked instead of reusing stale health", () => {
    expect(
      deriveGeminiKeyStatus({
        providerName: "gemini",
        providerType: "builtin",
        apiKey: currentKey,
        latestSnapshot: snapshot("test-previous-key", {
          ok: true,
          status: 200,
          availableModelCount: 50,
        }),
      })
    ).toEqual({
      state: "unchecked",
      httpStatus: null,
      availableModelCount: null,
      checkedAt: null,
    });
  });

  it("distinguishes an unreadable stored key from a missing key", () => {
    expect(
      deriveGeminiKeyStatus({
        providerName: "google-ai",
        providerType: "builtin",
        apiKey: null,
        apiKeyConfigured: true,
        latestSnapshot: null,
      })
    ).toEqual({
      state: "unreadable",
      httpStatus: null,
      availableModelCount: null,
      checkedAt: null,
    });
  });

  it("keeps a rejected key separate from successful billing", () => {
    expect(
      deriveGeminiKeyStatus({
        providerName: "google-ai",
        providerType: "builtin",
        apiKey: currentKey,
        latestSnapshot: snapshot(currentKey, {
          ok: false,
          status: 403,
          availableModelCount: null,
        }),
      })
    ).toEqual({
      state: "invalid",
      httpStatus: 403,
      availableModelCount: null,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
  });

  it.each([429, 503])(
    "treats HTTP %i as temporarily unavailable rather than rejecting the key",
    (statusCode) => {
      expect(
        deriveGeminiKeyStatus({
          providerName: "google-ai",
          providerType: "builtin",
          apiKey: currentKey,
          latestSnapshot: snapshot(currentKey, {
            ok: false,
            status: statusCode,
            availableModelCount: null,
          }),
        })
      ).toEqual({
        state: "unavailable",
        httpStatus: statusCode,
        availableModelCount: null,
        checkedAt: "2026-07-14T23:00:00.000Z",
      });
    }
  );

  it("does not classify custom Gemini-named endpoints as Google credentials", () => {
    expect(
      deriveGeminiKeyStatus({
        providerName: "gemini",
        providerType: "custom",
        apiKey: currentKey,
        latestSnapshot: null,
      })
    ).toBeNull();
  });
});

describe("deriveGeminiBillingStatus", () => {
  const billingConfig = {
    billingDataset: "billing-project.billing_export",
    googleProjectId: "gemini-production",
    serviceAccountJson: "test-service-account-json",
  };

  function billingSnapshot(
    config: Record<string, unknown>,
    billing: Record<string, unknown>
  ) {
    return {
      fetchedAt: new Date("2026-07-14T23:00:00.000Z"),
      rawData: {
        billing: {
          ...billing,
          configFingerprint: geminiBillingConfigFingerprint(config),
          privateBillingPayload: "must-not-be-returned",
        },
      },
    };
  }

  it("returns a sanitized error bound to the current billing config", () => {
    const status = deriveGeminiBillingStatus({
      providerName: "Google Gemini",
      providerType: "builtin",
      billingConfig,
      latestSnapshot: billingSnapshot(billingConfig, {
        status: "error",
        errorCode: "HTTP_ERROR",
        httpStatus: 503,
        retryable: true,
      }),
    });

    expect(status).toEqual({
      state: "error",
      errorCode: "HTTP_ERROR",
      httpStatus: 503,
      retryable: true,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain("fingerprint");
    expect(JSON.stringify(status)).not.toContain("must-not-be-returned");
    expect(JSON.stringify(status)).not.toContain("service-account");
  });

  it("marks changed billing configuration separately from unchecked", () => {
    expect(
      deriveGeminiBillingStatus({
        providerName: "google-ai",
        providerType: "builtin",
        billingConfig: { ...billingConfig, googleProjectId: "gemini-lab" },
        latestSnapshot: billingSnapshot(billingConfig, { status: "ready" }),
      })
    ).toEqual({
      state: "configuration_changed",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    });
  });

  it("distinguishes unconfigured and unreadable billing", () => {
    expect(
      deriveGeminiBillingStatus({
        providerName: "google-ai",
        providerType: "builtin",
        billingConfig: {},
        latestSnapshot: null,
      })
    ).toMatchObject({ state: "not_configured" });
    expect(
      deriveGeminiBillingStatus({
        providerName: "google-ai",
        providerType: "builtin",
        billingConfig: null,
        latestSnapshot: null,
      })
    ).toMatchObject({
      state: "error",
      errorCode: "CONFIGURATION_UNREADABLE",
    });
  });
});
