import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROVIDERS,
  hasConfiguredProviderField,
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
  });
});
