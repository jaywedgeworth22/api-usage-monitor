import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt, encryptJson } from "@/lib/crypto";
import {
  hasStoredAnthropicAdminApiKey,
  providerPollSnapshotExpected,
} from "@/lib/anthropic-credentials";

describe("Anthropic credential capability", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "42".repeat(32);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("does not treat a standard Messages key as billing capability", () => {
    const provider = {
      name: "anthropic",
      apiKey: encrypt("sk-ant-api03-standard-key"),
    };

    expect(hasStoredAnthropicAdminApiKey(provider)).toBe(false);
    expect(providerPollSnapshotExpected(provider)).toBe(false);
  });

  it("recognizes current secondary and legacy primary Admin-key storage", () => {
    expect(
      hasStoredAnthropicAdminApiKey({
        name: "anthropic",
        secretConfig: encryptJson({
          adminApiKey: "sk-ant-admin01-secondary-key",
        }),
      })
    ).toBe(true);
    expect(
      hasStoredAnthropicAdminApiKey({
        name: "anthropic",
        apiKey: encrypt("sk-ant-admin01-primary-key"),
      })
    ).toBe(true);
  });

  it("rejects a standard Messages key stored in the advanced Admin field", () => {
    expect(
      hasStoredAnthropicAdminApiKey({
        name: "anthropic",
        secretConfig: encryptJson({
          adminApiKey: "sk-ant-api03-standard-key",
        }),
      })
    ).toBe(false);
  });

  it("keeps snapshot polling expected for pollable providers", () => {
    expect(providerPollSnapshotExpected({ name: "openai", type: "builtin" })).toBe(true);
    expect(providerPollSnapshotExpected({ name: "tradier", type: "builtin" })).toBe(true);
  });

  it("does not expect snapshots for manual, push, or intentionally blind built-ins", () => {
    expect(providerPollSnapshotExpected({ name: "custom", type: "generic" })).toBe(false);
    expect(providerPollSnapshotExpected({ name: "anthropic", type: "push" })).toBe(false);
    expect(providerPollSnapshotExpected({ name: "voyage", type: "builtin" })).toBe(false);
    expect(providerPollSnapshotExpected({ name: "fmp", type: "builtin" })).toBe(false);
    expect(providerPollSnapshotExpected({ name: "fred", type: "builtin" })).toBe(false);
    expect(providerPollSnapshotExpected({ name: "robinhood", type: "builtin" })).toBe(false);
  });

  it("still expects snapshots for custom integrations with no-poll provider names", () => {
    expect(providerPollSnapshotExpected({ name: "fmp", type: "custom" })).toBe(true);
    expect(providerPollSnapshotExpected({ name: "tiingo", type: "custom" })).toBe(true);
    expect(providerPollSnapshotExpected({ name: "voyage", type: "custom" })).toBe(true);
  });
});
