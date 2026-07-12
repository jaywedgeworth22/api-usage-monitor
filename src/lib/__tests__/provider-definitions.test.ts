import { describe, expect, it } from "vitest";
import { hasConfiguredProviderField } from "@/lib/provider-definitions";

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
