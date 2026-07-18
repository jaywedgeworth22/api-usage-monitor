import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../mistral";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function currentUsage() {
  const now = new Date();
  return {
    start_date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end_date: now.toISOString(),
    currency: "USD",
    chat: {},
  };
}

function workspacePage(items: unknown[], total = items.length) {
  return { items, total };
}

describe("Mistral billing adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never converts spend-limit consumption into cash while preserving cap and rate metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ...currentUsage(), total_usage: 99, total_cost: 99 }))
      .mockResolvedValueOnce(json({ limits: { completion: { total_usage: 12, usage: 11, usage_limit: 100, monthly_limit_reached: false }, currency: "USD", last_payment_failure: false } }))
      .mockResolvedValueOnce(json({ requests_per_second: 5, tokens_limits_by_model: {} }))
      .mockResolvedValueOnce(json(workspacePage([])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("inference-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.costCoverageCaveat?.code).toBe(
      "mistral_usage_cash_total_schema_unavailable"
    );
    const usageSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-usage-billing"
    );
    const spendSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-spend-limits"
    );
    const rateSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-rate-limits"
    );
    expect(usageSync?.records[0]).toMatchObject({
      amountUsd: null,
      rollupRole: "canonical",
      status: "cost_unavailable",
    });
    expect(spendSync?.records[0]).toMatchObject({
      spendLimitUsd: 100,
      rollupRole: "metadata",
    });
    expect(rateSync?.records[0]).toMatchObject({
      requestLimit: 5,
      rollupRole: "metadata",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("https://console.mistral.ai/api/admin/usage?");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("admin-key");
  });

  it("paginates workspace inventory and emits bounded, non-additive workspace components", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([{ uuid: "one", name: "One" }], 101)))
        .mockResolvedValueOnce(json(workspacePage([{ uuid: "two", name: "Two" }], 101)))
    );

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // The production page size is 100; a short page with total 101 proves the
    // adapter follows the documented total instead of treating the first page
    // as a complete list. The remaining 99 records are supplied on page 2.
    const secondPage = Array.from({ length: 100 }, (_, index) => ({
      uuid: index === 0 ? "two" : `workspace-${index + 2}`,
      name: `Workspace ${index + 2}`,
    }));
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json(currentUsage()))
      .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
      .mockResolvedValueOnce(json({ requests_per_second: 5 }))
      .mockResolvedValueOnce(json(workspacePage([{ uuid: "one", name: "One" }], 101)))
      .mockResolvedValueOnce(json(workspacePage(secondPage, 101)));
    for (let index = 0; index < 50; index += 1) {
      fetchMock.mockResolvedValueOnce(json(currentUsage()));
    }

    const result = await fetchUsage("admin-key");
    const workspaceSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );

    expect(workspaceSync?.authoritative).toBe(false);
    expect(workspaceSync?.records).toHaveLength(50);
    expect(workspaceSync?.records[0]).toMatchObject({
      externalId: "one",
      amountUsd: null,
      rollupRole: "component",
      status: "cost_unavailable",
    });
    expect(result.rawData).toMatchObject({
      workspaceCoverage: { complete: true, capped: true, enumerated: 101 },
    });
    expect(fetchMock.mock.calls[4][0]).toContain("page=2&page_size=100");
    expect(fetchMock.mock.calls[5][0]).toContain("workspace_id=one");
  });

  it("keeps valid organization metadata when an optional workspace report fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([{ uuid: "one", name: "One" }, { uuid: "two", name: "Two" }])))
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({}, 400))
    );

    const result = await fetchUsage("admin-key");
    const usageSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-usage-billing"
    );
    const workspaceSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );

    expect(usageSync?.records[0].amountUsd).toBeNull();
    expect(workspaceSync?.authoritative).toBe(false);
    expect(workspaceSync?.records).toHaveLength(1);
    expect(result.totalCost).toBeNull();
  });

  it("rejects wrong currency and wrong UTC-month windows without returning a false zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ ...currentUsage(), currency: "EUR" }))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "EUR" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );
    const wrongCurrency = await fetchUsage("admin-key");
    expect(wrongCurrency.totalCost).toBeNull();
    expect(wrongCurrency.externalBillingSyncs?.find((sync) => sync.source === "mistral-usage-billing")?.records[0])
      .toMatchObject({ amountUsd: null, currency: "EUR" });
    expect(wrongCurrency.externalBillingSyncs?.find((sync) => sync.source === "mistral-spend-limits")?.records[0].spendLimitUsd)
      .toBeNull();

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ ...currentUsage(), start_date: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString() }))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );
    const wrongWindow = await fetchUsage("admin-key");
    expect(wrongWindow.totalCost).toBeNull();
    expect(wrongWindow.externalBillingSyncs?.map((sync) => sync.source)).not.toContain(
      "mistral-usage-billing"
    );
    expect(wrongWindow.totalCost).not.toBe(0);
  });
});
