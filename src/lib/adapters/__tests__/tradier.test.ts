import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../tradier";

describe("tradier adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces used, remaining, total, and reset rate-limit metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ balances: { total_equity: 1_000 } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-allowed": "120",
            "x-ratelimit-used": "20",
            "x-ratelimit-available": "100",
            "x-ratelimit-expiry": "1783857600",
          },
        })
      )
    );

    const result = await fetchUsage("key", { accountId: "account" });

    expect(result.externalBilling?.records[0]).toMatchObject({
      requestLimit: 120,
      usageQuantity: 20,
      remainingQuantity: 100,
      usageUnit: "requests",
      rollupRole: "metadata",
      dateKind: "quota_reset",
    });
  });
});
