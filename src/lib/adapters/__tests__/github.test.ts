import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../github";

describe("github billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sums enhanced-billing net amounts without persisting repository details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usageItems: [
            { product: "Actions", sku: "Linux", quantity: 10, netAmount: 1.25, repositoryName: "private/repo" },
            { product: "Copilot", sku: "Premium", netQuantity: 2, netAmount: 0.5 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(1.75);
    expect(result.externalBilling?.records[0]).toMatchObject({
      kind: "billing_period",
      amountUsd: 1.75,
      currency: "USD",
      rollupRole: "canonical",
    });
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceName: "Actions", planName: "Linux", rollupRole: "component" }),
        expect.objectContaining({ serviceName: "Copilot", planName: "Premium", rollupRole: "component" }),
      ])
    );
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/organizations/Acme/settings/billing/usage?"
    );
    expect(result.costScope).toBe("calendar_month_to_date");
  });

  it("fails closed when a successful response omits usageItems", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    await expect(fetchUsage("token", { org: "Acme" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
