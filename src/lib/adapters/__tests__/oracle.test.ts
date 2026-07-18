import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../oracle";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const config = {
  tenancyOcid: "ocid1.tenancy.oc1..example",
  userOcid: "ocid1.user.oc1..example",
  fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
  privateKey,
  region: "us-chicago-1",
  limitServices: "compute",
};

function json(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Oracle Cloud Infrastructure adapter", () => {
  it("signs exact Usage requests and keeps cost, details, limit pagination, and budgets isolated", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ url: input, init });
      const url = new URL(input);
      if (url.hostname.startsWith("usageapi.")) {
        const body = JSON.parse(String(init?.body));
        if (body.groupBy.length === 0) {
          return json({ items: [{ currency: "USD", computedAmount: 3 }] });
        }
        return json({ items: [{ service: "Compute", currency: "USD", computedAmount: 3, computedQuantity: 8 }] });
      }
      if (url.hostname.startsWith("limits.")) {
        expect(url.pathname).toBe("/20190729/limitValues");
        expect(url.searchParams.get("serviceName")).toBe("compute");
        return url.searchParams.get("page") === "limits-p2"
          ? json([{ name: "standard-e3-memory-gb", value: 32, scopeType: "REGION" }])
          : json([{ name: "standard-e3-core-count", value: 4, scopeType: "REGION" }], { "opc-next-page": "limits-p2" });
      }
      if (url.hostname.startsWith("usage.")) {
        expect(url.pathname).toBe("/20190111/budgets");
        return json([{
          id: "ocid1.budget.oc1..example", displayName: "Monthly cap", amount: 10,
          actualSpend: 3, forecastedSpend: 7, lifecycleState: "ACTIVE", resetPeriod: "MONTHLY",
        }]);
      }
      throw new Error(`unexpected URL ${input}`);
    }));

    const result = await fetchUsage("", { ...config, budgetCurrency: "USD" });

    expect(result.totalCost).toBe(3);
    const usageBodies = requests
      .filter(({ url }) => new URL(url).hostname.startsWith("usageapi."))
      .map(({ init }) => JSON.parse(String(init?.body)));
    expect(usageBodies.map((body) => body.groupBy)).toEqual([[], ["service"]]);
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "oci-usage-canonical", "oci-usage-service-detail", "oci-service-limits", "oci-budgets",
    ]);
    expect(result.externalBillingSyncs?.find((sync) => sync.source === "oci-budgets")?.records[0]).toMatchObject({
      spendLimitUsd: 10, usageQuantity: 3, remainingQuantity: 7, rollupRole: "metadata",
    });
    const usageRequest = requests.find(({ url }) => new URL(url).hostname.startsWith("usageapi."));
    expect(new URL(usageRequest!.url).searchParams.get("page")).toBeNull();
    expect(JSON.parse(String(usageRequest?.init?.body))).not.toHaveProperty("page");
    const headers = usageRequest?.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/Signature version="1"/);
    expect(headers.authorization).toMatch(/headers="\(request-target\) date host content-length content-type x-content-sha256"/);
    expect(headers["x-content-sha256"]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(requests.some(({ url }) => {
      const target = new URL(url);
      return target.hostname.startsWith("limits.") && target.searchParams.get("page") === "limits-p2";
    })).toBe(true);
  });

  it("fails closed when any canonical currency/cost row is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (new URL(input).hostname.startsWith("usageapi.")) {
        const body = JSON.parse(String(init?.body));
        if (body.groupBy.length === 0) {
          return json({ items: [{ currency: "USD", computedAmount: 1 }, { currency: "USD" }] });
        }
      }
      throw new Error(`unexpected URL ${input}`);
    }));
    await expect(fetchUsage("", config)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not reconcile malformed optional service detail while retaining canonical cash", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname.startsWith("usageapi.")) {
        const body = JSON.parse(String(init?.body));
        return body.groupBy.length === 0
          ? json({ items: [{ currency: "USD", computedAmount: 4 }] })
          : json({ items: [{ service: "Compute", currency: "USD" }] });
      }
      if (url.hostname.startsWith("usage.")) return json([]);
      throw new Error(`unexpected URL ${input}`);
    }));
    const result = await fetchUsage("", config);
    expect(result.totalCost).toBe(4);
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "oci-usage-canonical", "oci-budgets",
    ]);
    expect((result.rawData as { capabilities: { serviceCostDetail: string } }).capabilities.serviceCostDetail).toBe("invalid_or_truncated");
  });

  it("returns unknown cash on UTC day one instead of querying an invalid empty period or fabricating zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.hostname.startsWith("usageapi.")).toBe(false);
      if (url.hostname.startsWith("usage.")) return json([]);
      throw new Error(`unexpected URL ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchUsage("", config);
    expect(result.totalCost).toBeNull();
    expect((result.rawData as { capabilities: { actualMonthToDateCost: string } }).capabilities.actualMonthToDateCost).toBe("awaiting_first_complete_utc_day");
  });

  it("never relabels rate-card budget metadata as USD without explicit verification", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname.startsWith("usageapi.")) {
        const body = JSON.parse(String(init?.body));
        return body.groupBy.length === 0
          ? json({ items: [{ currency: "USD", computedAmount: 0 }] })
          : json({ items: [] });
      }
      if (url.hostname.startsWith("usage.")) return json([{
        id: "ocid1.budget.oc1..example", displayName: "Monthly cap", amount: 10,
        lifecycleState: "ACTIVE", resetPeriod: "MONTHLY",
      }]);
      throw new Error(`unexpected URL ${input}`);
    }));
    const result = await fetchUsage("", config);
    expect(result.externalBillingSyncs?.find((sync) => sync.source === "oci-budgets")?.records[0]).toMatchObject({
      spendLimitUsd: null, requestLimit: 10, usageUnit: "customer rate-card currency (unverified)",
    });
  });
});
