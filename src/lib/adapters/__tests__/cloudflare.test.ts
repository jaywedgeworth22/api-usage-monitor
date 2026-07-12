import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../cloudflare";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cloudflare adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads billing subscriptions and uses global-key auth correctly", async () => {
    const now = new Date();
    const currentPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
      .mockResolvedValueOnce(json({ result: { totals: { requests: 5 } } }))
      .mockResolvedValueOnce(
        json({
          result: [
            {
              id: "sub_1",
              currency: "USD",
              current_period_start: currentPeriodStart,
              current_period_end: new Date(now.getTime() + 86_400_000).toISOString(),
              frequency: "monthly",
              price: 5,
              rate_plan: { id: "pro", public_name: "Workers Paid" },
              state: "Paid",
            },
          ],
          result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
        })
      )
      .mockResolvedValueOnce(
        json({
          success: true,
          result: [
            {
              BillingCurrency: "USD",
              BillingPeriodStart: currentPeriodStart,
              ChargePeriodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
              ContractedCost: 2,
              ConsumedQuantity: 100,
              ServiceName: "Workers Standard",
              ZoneName: "must-not-persist.example",
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("global-key", {
      accountId: "account-id",
      accountEmail: "owner@example.com",
    });

    expect(result.totalCost).toBe(7);
    expect(result.fixedCostIncludedUsd).toBe(5);
    // Account analytics is the broader total; Workers analytics is a fallback,
    // not an additive second count of overlapping requests.
    expect(result.totalRequests).toBe(10);
    const subscriptionSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    );
    expect(subscriptionSync?.records[0]).toMatchObject({
      externalId: "sub_1",
      kind: "subscription",
      planName: "Workers Paid",
      status: "paid",
      amountUsd: 5,
    });
    expect(JSON.stringify(result.rawData)).not.toContain("must-not-persist.example");
    const requestHeaders = fetchMock.mock.calls[2][1].headers;
    expect(requestHeaders["X-Auth-Key"]).toBe("global-key");
    expect(requestHeaders["X-Auth-Email"]).toBe("owner@example.com");
    expect(requestHeaders.Authorization).toBeUndefined();
  });

  it("falls back to Workers requests when account analytics is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({ result: { totals: { requests: 7 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });

    expect(result.totalRequests).toBe(7);
  });

  it("preserves PayGo currency and keeps different service units separate", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [],
            result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
          })
        )
        .mockResolvedValueOnce(
          json({
            result: [
              {
                BillingCurrency: "EUR",
                BillingPeriodStart: periodStart,
                ChargePeriodEnd: now.toISOString(),
                ContractedCost: 2,
                ConsumedQuantity: 10,
                ConsumedUnit: "requests",
                ServiceName: "Workers",
              },
              {
                BillingCurrency: "EUR",
                BillingPeriodStart: periodStart,
                ChargePeriodEnd: now.toISOString(),
                ContractedCost: 3,
                ConsumedQuantity: 20,
                ConsumedUnit: "GB",
                ServiceName: "Workers",
              },
            ],
          })
        )
    );

    const result = await fetchUsage("token", { accountId: "account-id" });
    const sync = result.externalBillingSyncs?.find(
      (candidate) => candidate.source === "cloudflare-paygo-usage"
    );

    expect(result.totalCost).toBeNull();
    expect(sync?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Cloudflare PayGo",
          amountUsd: 5,
          currency: "EUR",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          serviceName: "Workers",
          usageQuantity: 10,
          usageUnit: "requests",
          currency: "EUR",
          rollupRole: "component",
        }),
        expect.objectContaining({
          serviceName: "Workers",
          usageQuantity: 20,
          usageUnit: "GB",
          currency: "EUR",
          rollupRole: "component",
        }),
      ])
    );
  });

  it("does not assume a missing subscription currency is USD", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [{
              id: "sub-no-currency",
              price: 5,
              state: "Paid",
              current_period_start: periodStart,
              rate_plan: { public_name: "Workers Paid" },
            }],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          })
        )
        .mockResolvedValueOnce(json({ result: [] }))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });
    const subscription = result.externalBillingSyncs
      ?.find((candidate) => candidate.source === "cloudflare-subscriptions")
      ?.records[0];

    expect(result.totalCost).toBeNull();
    expect(subscription).toMatchObject({
      planName: "Workers Paid",
      amountUsd: null,
      currency: null,
    });
  });

  it("fetches every subscription page before authoritative reconciliation", async () => {
    const now = new Date();
    const currentPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(
        json({
          result: [{ id: "sub_1", currency: "USD", price: 2, state: "Paid", current_period_start: currentPeriodStart }],
          result_info: { count: 1, page: 1, per_page: 1, total_count: 2 },
        })
      )
      .mockResolvedValueOnce(
        json({
          result: [{ id: "sub_2", currency: "USD", price: 3, state: "Paid", current_period_start: currentPeriodStart }],
          result_info: { count: 1, page: 2, per_page: 1, total_count: 2 },
        })
      )
      .mockResolvedValueOnce(json({}, 403));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { accountId: "account-id" });
    const sync = result.externalBillingSyncs?.find(
      (candidate) => candidate.source === "cloudflare-subscriptions"
    );

    expect(result.totalCost).toBe(5);
    expect(sync?.records.map((record) => record.externalId)).toEqual([
      "sub_1",
      "sub_2",
    ]);
    expect(String(fetchMock.mock.calls[3][0])).toContain("page=2");
  });

  it("rejects incomplete pagination metadata before booking or reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({ result: { totals: { requests: 5 } } }))
        .mockResolvedValueOnce(
          json({
            result: [{ id: "sub_1" }],
            result_info: { count: 1, page: 1, per_page: 1, total_count: 2 },
          })
        )
        .mockResolvedValueOnce(json({ result: [{ id: "sub_2" }] }))
    );

    await expect(
      fetchUsage("token", { accountId: "account-id" })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a successful response that omits the subscription result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({ result: { totals: { requests: 5 } } }))
        .mockResolvedValueOnce(
          json({
            result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
          })
        )
    );

    await expect(
      fetchUsage("token", { accountId: "account-id" })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
