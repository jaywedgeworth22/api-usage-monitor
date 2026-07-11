import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../render";

describe("render adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("syncs service plan/status without inventing invoice cost", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "srv_1", name: "api", type: "web_service", plan: "starter", suspended: "not_suspended", repo: "private/repo" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { serviceId: "srv_1" });

    expect(result.totalCost).toBeNull();
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        externalId: "srv_1",
        kind: "service_plan",
        planName: "starter",
        status: "active",
      }),
    ]);
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");
  });

  it("reads the current Render serviceDetails plan/runtime shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "srv_current",
          name: "api-usage-monitor",
          type: "web_service",
          plan: "legacy-fallback",
          runtime: "legacy-runtime",
          suspended: "not_suspended",
          serviceDetails: {
            plan: "starter",
            runtime: "node",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { serviceId: "srv_current" });

    expect(result.externalBilling?.records[0]?.planName).toBe("starter");
    expect(result.rawData).toEqual(
      expect.objectContaining({
        service: expect.objectContaining({
          plan: "starter",
          runtime: "node",
        }),
      })
    );
  });
});
