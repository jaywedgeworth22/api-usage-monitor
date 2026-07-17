import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROVIDERS,
  DEFAULT_USAGE_UNIT_LABEL,
  hasConfiguredProviderField,
  usageUnitLabelForProvider,
} from "@/lib/provider-definitions";

describe("hasConfiguredProviderField", () => {
  it("accepts an existing protected value while editing without exposing or resending it", () => {
    expect(hasConfiguredProviderField({}, "secretKey", ["secretKey"])).toBe(true);
    expect(hasConfiguredProviderField({}, "apiSecret", ["apiSecret"])).toBe(true);
  });

  it("still requires a value for a new or unconfigured provider", () => {
    expect(hasConfiguredProviderField({}, "secretKey")).toBe(false);
    expect(hasConfiguredProviderField({ secretKey: "  " }, "secretKey")).toBe(false);
    expect(hasConfiguredProviderField({ secretKey: "configured" }, "secretKey")).toBe(true);
  });
});

describe("Cloudflare provider definition", () => {
  it("requires the account ID but does not imply an email for API-token auth", () => {
    const cloudflare = BUILT_IN_PROVIDERS.find(
      (provider) => provider.name === "cloudflare"
    );

    expect(cloudflare?.needsAccountId).toBe(true);
    expect(cloudflare?.helpNote).toMatch(/Billing Read API token needs no email/i);
    expect(cloudflare?.helpNote).toMatch(/email is only for a Global API key/i);
    expect(cloudflare?.helpNote).toMatch(
      /single-resource metadata\/readability probes only/i
    );
    expect(cloudflare?.helpNote).toMatch(
      /do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility/i
    );
  });
});

describe("usageUnitLabelForProvider", () => {
  it("defaults to Requests for providers that report request counts", () => {
    // google-ai/Cloud Monitoring, and anything without an explicit label.
    expect(usageUnitLabelForProvider("google-ai")).toBe(DEFAULT_USAGE_UNIT_LABEL);
    expect(usageUnitLabelForProvider("openai")).toBe("Requests");
    expect(DEFAULT_USAGE_UNIT_LABEL).toBe("Requests");
  });

  it("labels providers that repurpose totalRequests with their true unit", () => {
    expect(usageUnitLabelForProvider("render")).toBe("Bandwidth (MB)");
    expect(usageUnitLabelForProvider("langfuse")).toBe("Billable units");
    expect(usageUnitLabelForProvider("sentry")).toBe("Events");
    expect(usageUnitLabelForProvider("pushover")).toBe("Messages");
    expect(usageUnitLabelForProvider("twelvedata")).toBe("API credits");
  });

  it("resolves by canonical provider key, not raw casing", () => {
    expect(usageUnitLabelForProvider("Render")).toBe("Bandwidth (MB)");
    expect(usageUnitLabelForProvider("  Langfuse  ")).toBe("Billable units");
  });

  it("falls back to Requests for unknown or custom providers", () => {
    expect(usageUnitLabelForProvider("some-custom-provider")).toBe("Requests");
    expect(usageUnitLabelForProvider("")).toBe("Requests");
  });

  it("keeps every declared usageUnitLabel non-empty", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      if (provider.usageUnitLabel !== undefined) {
        expect(provider.usageUnitLabel.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("Anthropic provider definition", () => {
  it("does not imply individual accounts can obtain direct billing access", () => {
    const anthropic = BUILT_IN_PROVIDERS.find(
      (provider) => provider.name === "anthropic"
    );
    const adminField = anthropic?.needsConfig?.fields.find(
      (field) => field.key === "adminApiKey"
    );

    expect(anthropic?.helpNote).toMatch(/individual accounts cannot use/i);
    expect(anthropic?.helpNote).toMatch(/no standard Messages API key is requested/i);
    expect(anthropic?.helpNote).toMatch(/pushed per-request telemetry/i);
    expect(anthropic?.helpNote).toMatch(/Subscription or receipt reconciliation/i);
    expect(anthropic?.usesApiKey).toBe(false);
    expect(adminField?.label).toMatch(/organization accounts only/i);
    expect(adminField?.advanced).toBe(true);
  });
});
