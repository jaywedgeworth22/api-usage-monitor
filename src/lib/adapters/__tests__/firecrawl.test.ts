import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../firecrawl";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("firecrawl adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads current credits and cycle without persisting unknown response fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        success: true,
        data: {
          remainingCredits: 993,
          planCredits: 1_000,
          billingPeriodStart: "2026-06-27T12:34:56Z",
          billingPeriodEnd: "2026-07-27T12:34:56Z",
          privateTeamMetadata: "must-not-persist",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("fc-test-token");

    expect(result).toMatchObject({
      balance: null,
      totalCost: null,
      costScope: "unknown",
      totalRequests: null,
      credits: 993,
      rawData: {
        credits: { plan: 1_000, remaining: 993 },
        billingPeriod: {
          start: "2026-06-27T12:34:56.000Z",
          end: "2026-07-27T12:34:56.000Z",
        },
        capabilities: { usdCost: false, renewalDate: false },
      },
      externalBilling: {
        source: "firecrawl-team-credit-usage",
        authoritative: true,
        records: [
          {
            externalId: "team-credit-plan",
            kind: "plan",
            currentPeriodStart: "2026-06-27T12:34:56.000Z",
            currentPeriodEnd: "2026-07-27T12:34:56.000Z",
            requestLimit: 1_000,
            remainingQuantity: 993,
            usageUnit: "credits",
            rollupRole: "metadata",
            dateKind: "period_end",
          },
        ],
      },
    });
    expect(result.externalBilling?.records[0]).not.toHaveProperty(
      "usageQuantity"
    );
    expect(JSON.stringify(result.rawData)).not.toContain("must-not-persist");
    expect(JSON.stringify(result.rawData)).not.toContain("usedDerived");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.firecrawl.dev/v2/team/credit-usage"
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer fc-test-token"
    );
  });

  it("does not invent used credits when extras exceed the plan allowance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          success: true,
          data: {
            remainingCredits: 1_250,
            planCredits: 1_000,
            billingPeriodStart: "2026-07-01T00:00:00Z",
            billingPeriodEnd: "2026-08-01T00:00:00Z",
          },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.credits).toBe(1_250);
    expect(result.rawData).toMatchObject({
      credits: { plan: 1_000, remaining: 1_250 },
      capabilities: { providerReportedUsage: false },
    });
    expect(result.externalBilling?.records[0]).toMatchObject({
      requestLimit: 1_000,
      remainingQuantity: 1_250,
    });
    expect(result.externalBilling?.records[0]).not.toHaveProperty(
      "usageQuantity"
    );
  });

  it.each([
    {
      billingPeriodStart: null,
      billingPeriodEnd: "2026-08-01T00:00:00Z",
      expectedStart: null,
      expectedEnd: "2026-08-01T00:00:00.000Z",
      expectedDateKind: "period_end",
    },
    {
      billingPeriodStart: "2026-07-01T00:00:00Z",
      billingPeriodEnd: null,
      expectedStart: "2026-07-01T00:00:00.000Z",
      expectedEnd: null,
      expectedDateKind: null,
    },
    {
      billingPeriodStart: null,
      billingPeriodEnd: null,
      expectedStart: null,
      expectedEnd: null,
      expectedDateKind: null,
    },
  ])(
    "keeps credits when official billing-period dates are nullable",
    async ({
      billingPeriodStart,
      billingPeriodEnd,
      expectedStart,
      expectedEnd,
      expectedDateKind,
    }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          json({
            success: true,
            data: {
              remainingCredits: 800,
              planCredits: 1_000,
              billingPeriodStart,
              billingPeriodEnd,
            },
          })
        )
      );

      const result = await fetchUsage("token");

      expect(result.credits).toBe(800);
      expect(result.externalBilling?.records[0]).toMatchObject({
        currentPeriodStart: expectedStart,
        currentPeriodEnd: expectedEnd,
        dateKind: expectedDateKind,
        remainingQuantity: 800,
      });
      expect(result.externalBilling?.records[0]).not.toHaveProperty(
        "usageQuantity"
      );
    }
  );

  it("fails locally when no key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("  ")).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies rejected credentials as a non-retryable HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ success: false, error: "Unauthorized" }, 401))
    );

    const request = fetchUsage("rejected-token");
    await expect(request).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
      retryable: false,
    });
    await expect(request).rejects.not.toThrow(/rejected-token/);
  });

  it("classifies a provider outage as retryable without blocking on a long retry request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: "Service unavailable" }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "retry-after": "300",
            },
          }
        )
      )
    );

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
      retryable: true,
    });
  });

  it.each([
    {
      success: true,
      data: {
        remainingCredits: -1,
        planCredits: 1_000,
        billingPeriodStart: "2026-07-01T00:00:00Z",
        billingPeriodEnd: "2026-08-01T00:00:00Z",
      },
    },
    {
      success: true,
      data: {
        remainingCredits: 500,
        planCredits: 1_000,
        billingPeriodStart: "not-a-date",
        billingPeriodEnd: "2026-08-01T00:00:00Z",
      },
    },
    {
      success: true,
      data: {
        remainingCredits: 500,
        planCredits: 1_000,
        billingPeriodStart: "2026-08-01T00:00:00Z",
        billingPeriodEnd: "2026-07-01T00:00:00Z",
      },
    },
  ])("rejects malformed quota or cycle responses", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("rejects a successful HTTP response with provider-level failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ success: false, error: "Not available" }))
    );

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
