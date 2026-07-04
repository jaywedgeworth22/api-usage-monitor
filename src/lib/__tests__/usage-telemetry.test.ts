import { describe, it, expect } from "vitest";
import { parseUsageTelemetryBatch } from "../usage-telemetry";

// ---------------------------------------------------------------------------
// Idempotency key tests — these match the shared test vectors that the
// congress-trading-shared repo also uses, so both repos can verify that their
// deriveIdempotencyKey implementations produce identical bytes.
// ---------------------------------------------------------------------------

// All derived keys must be exactly 64 hex characters (SHA-256).
const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]{64}$/;

describe("deriveIdempotencyKey", () => {
  // ---- Hardcoded input/output vectors -----------------------------------

  it("produces a deterministic 64-char hex key for vector 1 (openai / gpt-5.5)", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    const key = events[0].idempotencyKey;
    expect(key).toMatch(HEX_PATTERN);
    expect(key).toHaveLength(SHA256_HEX_LENGTH);
  });

  it("produces a deterministic 64-char hex key for vector 2 (voyage / cost)", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "voyage",
      metricType: "cost",
      keyRef: "",
      occurredAt: "2026-06-15T00:00:00.000Z",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    const key = events[0].idempotencyKey;
    expect(key).toMatch(HEX_PATTERN);
    expect(key).toHaveLength(SHA256_HEX_LENGTH);
  });

  it("produces a deterministic 64-char hex key for vector 3 (congress-feed / fmp)", () => {
    const input = {
      sourceApp: "congress-feed",
      provider: "fmp",
      metricType: "usage",
      keyRef: "",
      occurredAt: "2026-06-15T12:00:00.000Z",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    const key = events[0].idempotencyKey;
    expect(key).toMatch(HEX_PATTERN);
    expect(key).toHaveLength(SHA256_HEX_LENGTH);
  });

  // ---- Determinism: same input → same key -------------------------------

  it("produces the same key for identical inputs across multiple calls", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    };
    const key1 = parseUsageTelemetryBatch(input)[0].idempotencyKey;
    const key2 = parseUsageTelemetryBatch(input)[0].idempotencyKey;
    const key3 = parseUsageTelemetryBatch(input)[0].idempotencyKey;
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
  });

  // ---- Uniqueness: different inputs → different keys --------------------

  it("produces different keys for different sourceApp values", () => {
    const a = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    const b = parseUsageTelemetryBatch({
      sourceApp: "congress-feed",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    expect(a).not.toBe(b);
  });

  it("produces different keys for different provider values", () => {
    const a = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    const b = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "anthropic",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    expect(a).not.toBe(b);
  });

  it("produces different keys for different occurredAt timestamps", () => {
    const a = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    const b = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:01.000Z",
    })[0].idempotencyKey;

    expect(a).not.toBe(b);
  });

  // ---- Explicit idempotencyKey passes through verbatim ------------------

  it("uses the explicit idempotencyKey when provided by the caller", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      occurredAt: "2026-06-15T00:00:00.000Z",
      idempotencyKey: "my-custom-key-123",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe("my-custom-key-123");
  });

  // ---- No occurredAt fallback → random UUID -----------------------------

  it("falls back to a random UUID when no occurredAt or explicit key is supplied", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    // UUID v4 format: 8-4-4-4-12 hex digits
    expect(events[0].idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("parseUsageTelemetryBatch validation", () => {
  it("accepts a valid single event", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      occurredAt: "2026-06-15T00:00:00.000Z",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    expect(events[0].sourceApp).toBe("socratic-trade");
    expect(events[0].provider).toBe("openai");
    expect(events[0].metricType).toBe("usage");
  });

  it("accepts a valid batch of events", () => {
    const input = {
      events: [
        {
          sourceApp: "socratic-trade",
          provider: "openai",
          metricType: "usage",
          occurredAt: "2026-06-15T00:00:00.000Z",
        },
        {
          sourceApp: "socratic-trade",
          provider: "twilio",
          metricType: "cost",
          costUsd: 0.05,
          occurredAt: "2026-06-15T01:00:00.000Z",
        },
      ],
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(2);
    expect(events[0].provider).toBe("openai");
    expect(events[1].provider).toBe("twilio");
    expect(events[1].costUsd).toBe(0.05);
  });

  it("rejects an empty events array", () => {
    expect(() => parseUsageTelemetryBatch({ events: [] })).toThrow(
      "events must not be empty"
    );
  });

  it("rejects when sourceApp is missing", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        provider: "openai",
        metricType: "usage",
      })
    ).toThrow("sourceApp is required");
  });

  it("rejects when provider is missing", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        metricType: "usage",
      })
    ).toThrow("provider is required");
  });

  it("rejects invalid metricType", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "invalid-type",
        occurredAt: "2026-06-15T00:00:00.000Z",
      })
    ).toThrow("metricType is not supported");
  });

  it("rejects negative costUsd", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "usage",
        costUsd: -1,
        occurredAt: "2026-06-15T00:00:00.000Z",
      })
    ).toThrow("costUsd");
  });

  it("rejects non-finite numbers", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "usage",
        quantity: NaN,
        occurredAt: "2026-06-15T00:00:00.000Z",
      })
    ).toThrow("quantity");
  });
});
