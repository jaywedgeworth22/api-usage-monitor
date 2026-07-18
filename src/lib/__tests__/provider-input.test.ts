import { describe, expect, it } from "vitest";
import {
  parseProviderCreateInput,
  parseProviderUpdateInput,
} from "@/lib/provider-input";

describe("provider secret config operations", () => {
  it("accepts an explicit service-account clear on provider updates", () => {
    expect(
      parseProviderUpdateInput({
        config: { unrelated: "preserved" },
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      })
    ).toMatchObject({
      config: { unrelated: "preserved" },
      secretConfigOperations: [
        { path: ["serviceAccountJson"], action: "clear" },
      ],
    });
  });

  it("rejects attempts to clear prototype pollution paths", () => {
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [
          { path: ["__proto__"], action: "clear" },
        ],
      })
    ).toThrow(/unsafe or invalid path segment/);
  });

  it("rejects ambiguous combinations and create-route operations", () => {
    expect(() =>
      parseProviderUpdateInput({
        config: null,
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      })
    ).toThrow(/cannot be combined with config: null/);

    expect(() =>
      parseProviderCreateInput({
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      })
    ).toThrow(/only supported when updating/);
  });
});
