import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../github";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("github billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("syncs canonical enhanced-billing spend, budget caps, and Copilot breakdowns without double counting", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) {
        return response({
          usageItems: [
            { product: "Actions", sku: "Linux", netQuantity: 10, unitType: "minutes", netAmount: 1.25 },
            { product: "Packages", sku: "Storage", netQuantity: 2, unitType: "GB", netAmount: 0.5 },
          ],
        });
      }
      if (input.includes("/budgets?")) {
        return response({
          budgets: [{
            id: "actions-cap",
            budget_type: "SkuPricing",
            budget_product_skus: ["actions_linux"],
            budget_scope: "organization",
            budget_amount: 50,
            prevent_further_usage: true,
          }],
          has_next_page: false,
        });
      }
      if (input.includes("/ai_credit/usage?")) {
        return response({
          usageItems: [{ product: "Copilot", sku: "AI Credits", model: "GPT-5", netQuantity: 40, unitType: "credits", netAmount: 0.4 }],
        });
      }
      if (input.includes("/premium_request/usage?")) {
        return response({
          usageItems: [{ product: "Copilot", sku: "Premium Request", model: "GPT-5", netQuantity: 10, unitType: "requests", netAmount: 0.4 }],
        });
      }
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(1.75);
    expect(result.externalBilling).toBeUndefined();
    expect(result.externalBillingSyncs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "github-enhanced-billing", authoritative: true }),
        expect.objectContaining({ source: "github-enhanced-billing-budgets", authoritative: true }),
        expect.objectContaining({ source: "github-enhanced-billing-ai-credits", authoritative: true }),
        expect.objectContaining({ source: "github-enhanced-billing-premium-requests", authoritative: true }),
      ])
    );
    const usage = result.externalBillingSyncs?.find((sync) => sync.source === "github-enhanced-billing");
    expect(usage?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "billing_period", amountUsd: 1.75, rollupRole: "canonical" }),
      expect.objectContaining({ serviceName: "Actions", planName: "Linux", amountUsd: 1.25, rollupRole: "component" }),
    ]));
    const budget = result.externalBillingSyncs?.find((sync) => sync.source === "github-enhanced-billing-budgets");
    expect(budget?.records).toEqual([expect.objectContaining({
      externalId: "actions-cap",
      spendLimitUsd: 50,
      rollupRole: "metadata",
      status: "enforced",
    })]);
    const ai = result.externalBillingSyncs?.find((sync) => sync.source === "github-enhanced-billing-ai-credits");
    expect(ai?.records[0]).toMatchObject({ amountUsd: 0.4, rollupRole: "component" });
    expect((result.rawData as { capabilities: { planSubscription: string } }).capabilities.planSubscription).toBe("not_exposed");
    expect(fetchMock.mock.calls[0][0]).toContain("/organizations/Acme/settings/billing/usage/summary?");
  });

  it("uses the detailed report only as a safe fallback and preserves unavailable optional surfaces explicitly", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ message: "preview unavailable" }, 404);
      if (input.includes("/budgets?")) return response({ message: "forbidden" }, 403);
      if (input.includes("/ai_credit/usage?")) return response({ message: "not found" }, 404);
      if (input.includes("/premium_request/usage?")) return response({ message: "unavailable" }, 503);
      if (input.includes("/usage?")) {
        return response({
          usageItems: [{ product: "Actions", sku: "Linux", quantity: 10, netAmount: 1.25, repositoryName: "private/repo" }],
        });
      }
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(1.25);
    expect(result.externalBillingSyncs).toHaveLength(1);
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");
    const capabilities = (result.rawData as {
      billing: { source: string };
      capabilities: { budgets: { status: string }; aiCredits: { status: string }; premiumRequests: { status: string } };
    }).capabilities;
    expect((result.rawData as { billing: { source: string } }).billing.source).toBe("detailed_report_fallback");
    expect(capabilities.budgets.status).toBe("permission_unavailable");
    expect(capabilities.aiCredits.status).toBe("not_available");
    expect(capabilities.premiumRequests.status).toBe("upstream_unavailable");
  });

  it("uses the personal-account endpoint when configured", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { accountType: "user", account: "jay" });

    expect(result.totalCost).toBe(0);
    expect(fetchMock.mock.calls[0][0]).toContain("/users/jay/settings/billing/usage/summary?");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/budgets?"))).toBe(false);
    expect((result.rawData as { capabilities: { budgets: { status: string } } }).capabilities.budgets.status).toBe("not_exposed");
  });

  it("uses the configured GHE.com API origin for an enterprise boundary", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({ budgets: [], has_next_page: false });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchUsage("token", {
      accountType: "enterprise",
      account: "octo-enterprise",
      apiOrigin: "https://api.octo.ghe.com",
    });

    expect(fetchMock.mock.calls[0][0]).toContain("https://api.octo.ghe.com/enterprises/octo-enterprise/settings/billing/usage/summary?");
  });

  it("keeps canonical usage when an optional Copilot response is malformed", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({ budgets: [], has_next_page: false });
      if (input.includes("/ai_credit/usage?")) return response({ unexpected: true });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(0);
    expect(result.externalBillingSyncs?.some((sync) => sync.source === "github-enhanced-billing-ai-credits")).toBe(false);
    expect((result.rawData as { capabilities: { aiCredits: { status: string; errorCode: string } } }).capabilities.aiCredits).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("keeps canonical usage when an optional budget record is malformed", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: [{ budget_type: "SkuPricing", budget_amount: 50 }],
        has_next_page: false,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(0);
    expect(result.externalBillingSyncs?.some((sync) => sync.source === "github-enhanced-billing-budgets")).toBe(false);
    expect((result.rawData as { capabilities: { budgets: { status: string; errorCode: string } } }).capabilities.budgets).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("fails closed when the canonical usage response omits usageItems", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({}))
    );

    await expect(fetchUsage("token", { org: "Acme" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
