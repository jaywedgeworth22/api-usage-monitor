import { describe, expect, it } from "vitest";
import {
  canonicalProjectKey,
  canonicalProviderKey,
  resolveProviderIdentity,
} from "../provider-identity";

describe("provider identity", () => {
  it.each([
    ["gemini", "google-ai"],
    ["Google AI", "google-ai"],
    ["google", "google-ai"],
    ["google_ai_studio", "google-ai"],
    ["LlamaParse", "llamaindex"],
    ["Polygon.io", "massive"],
    ["Alpha-Vantage", "alphavantage"],
    ["Twelve Data", "twelvedata"],
    ["Voyage AI", "voyage"],
    ["fintechstudios", "fintech-studios"],
    ["quiver", "quiver-quant"],
    ["QuiverQuant", "quiver-quant"],
    ["Quiver Quantitative", "quiver-quant"],
  ])("maps %s to %s", (input, expected) => {
    expect(canonicalProviderKey(input)).toBe(expected);
  });

  it("keeps unknown providers distinct without rewriting persisted input", () => {
    expect(canonicalProviderKey("Unusual Whales")).toBe("unusual-whales");
    expect(canonicalProviderKey("Quiver Quant")).toBe("quiver-quant");
  });

  it("prefers an exact configured name before falling back through aliases", () => {
    const candidates = [
      { id: "builtin", name: "google-ai" },
      { id: "custom", name: "gemini" },
      { id: "legacy", name: "google" },
    ];

    expect(resolveProviderIdentity("gemini", candidates)?.id).toBe("custom");
    expect(resolveProviderIdentity("Google AI Studio", candidates)?.id).toBe("builtin");
    expect(resolveProviderIdentity("gemini", [candidates[2]])?.id).toBe("legacy");
  });

  it.each([
    ["socratic-trade", "SocraticTrade.com"],
    ["congress-trade", "Congress.Trade"],
    ["my-app", "My App"],
  ])("matches legacy source app %s to project %s", (sourceApp, projectName) => {
    expect(canonicalProjectKey(sourceApp)).toBe(canonicalProjectKey(projectName));
  });
});
