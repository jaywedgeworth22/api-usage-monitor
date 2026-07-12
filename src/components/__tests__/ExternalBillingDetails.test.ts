import { describe, expect, it } from "vitest";
import { isExternalBillingStale } from "@/components/ExternalBillingDetails";

describe("isExternalBillingStale", () => {
  it("honors the caller-provided freshness threshold", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const record = { syncedAt: "2026-07-12T10:00:00.000Z" };

    expect(isExternalBillingStale(record, 60 * 60 * 1_000, now)).toBe(true);
    expect(isExternalBillingStale(record, 3 * 60 * 60 * 1_000, now)).toBe(false);
  });
});
