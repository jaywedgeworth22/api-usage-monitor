import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../vercel";

describe("vercel billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses FOCUS JSONL and sums billed USD cost", async () => {
    const body = [
      { BilledCost: "2.50", BillingCurrency: "USD", ServiceName: "Functions", ConsumedQuantity: "3", Tags: { ProjectName: "secret" } },
      { BilledCost: 1.25, BillingCurrency: "USD", ServiceName: "Bandwidth", ConsumedQuantity: 4 },
    ].map((value) => JSON.stringify(value)).join("\n");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { teamId: "team_123" });

    expect(result.totalCost).toBe(3.75);
    expect(result.externalBilling?.records[0]).toMatchObject({ amountUsd: 3.75 });
    expect(JSON.stringify(result.rawData)).not.toContain("secret");
    expect(fetchMock.mock.calls[0][0]).toContain("teamId=team_123");
    expect(result.costIncludesUnknownFixed).toBe(true);
  });

  it("fails closed on a malformed successful FOCUS row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ServiceName: "Functions" }), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
