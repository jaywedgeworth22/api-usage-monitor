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
    expect(result.externalBilling?.records[0]).toMatchObject({
      amountUsd: 3.75,
      rollupRole: "canonical",
    });
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceName: "Functions", rollupRole: "component" }),
        expect.objectContaining({ serviceName: "Bandwidth", rollupRole: "component" }),
      ])
    );
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

  it("preserves non-USD service spend without labeling it canonical USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            BilledCost: "4.25",
            BillingCurrency: "EUR",
            ServiceName: "Functions",
            ConsumedQuantity: "10",
            ConsumedUnit: "invocations",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchUsage("token");
    expect(result.totalCost).toBeNull();
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Vercel",
          amountUsd: 4.25,
          currency: "EUR",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
        serviceName: "Functions",
        amountUsd: 4.25,
        currency: "EUR",
        usageQuantity: 10,
        rollupRole: "component",
        }),
      ])
    );
  });

  it("treats an empty successful FOCUS response as authoritative zero spend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(0);
    expect(result.costScope).toBe("calendar_month_to_date");
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({ amountUsd: 0, currency: "USD", rollupRole: "canonical" }),
    ]);
  });
});
