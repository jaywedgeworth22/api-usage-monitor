import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../render";

type ResourceKey = "service" | "postgres" | "keyValue";

function renderPage(
  key: ResourceKey,
  resources: Array<Record<string, unknown>>
): Response {
  return new Response(
    JSON.stringify(
      resources.map((resource) => ({
        [key]: resource,
        cursor: `${key}-${String(resource.id)}`,
      }))
    ),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function mockRenderLists(
  pages: Record<string, Record<string, unknown>[]>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor") ?? "first";
    const key = `${url.pathname}:${cursor}`;
    const resourceKey: ResourceKey = url.pathname.endsWith("/services")
      ? "service"
      : url.pathname.endsWith("/postgres")
        ? "postgres"
        : "keyValue";
    return renderPage(resourceKey, pages[key] ?? []);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("render adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("discovers and paginates paid services, Postgres, and Key Value without a serviceId", async () => {
    const fetchMock = mockRenderLists({
      "/v1/services:first": [
        {
          id: "srv_paid",
          name: "api",
          type: "web_service",
          suspended: "not_suspended",
          repo: "private/repo",
          serviceDetails: {
            plan: "starter",
            runtime: "node",
            region: "oregon",
            numInstances: 2,
            disk: { id: "dsk_1", name: "data", sizeGB: 20, mountPath: "/data" },
          },
        },
      ],
      "/v1/services:service-srv_paid": [
        {
          id: "srv_free",
          name: "landing",
          type: "static_site",
          suspended: "not_suspended",
          serviceDetails: { plan: "free", buildPlan: "starter" },
        },
      ],
      "/v1/postgres:first": [
        {
          id: "dpg_primary",
          name: "usage-db",
          plan: "basic_1gb",
          status: "available",
          suspended: "not_suspended",
          role: "primary",
          diskSizeGB: 25,
          highAvailabilityEnabled: true,
          readReplicas: [{ id: "dpg_replica", name: "usage-db-replica" }],
        },
      ],
      "/v1/key-value:first": [
        { id: "red_free", name: "cache-free", plan: "free", status: "available" },
        { id: "red_paid", name: "cache", plan: "starter", status: "available" },
      ],
    });

    const result = await fetchUsage("token");

    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "render-service-plans",
      authoritative: true,
    });
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "srv_paid",
          planName: "starter",
          usageQuantity: 2,
          usageUnit: "instances",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          externalId: "srv_paid:disk:dsk_1",
          planName: "20 GB persistent disk",
          rollupRole: "component",
        }),
        expect.objectContaining({ externalId: "dpg_primary", planName: "basic_1gb" }),
        expect.objectContaining({ externalId: "red_paid", planName: "starter" }),
      ])
    );
    expect(result.externalBilling?.records.map((record) => record.externalId)).not.toContain(
      "srv_free"
    );
    expect(result.externalBilling?.records.map((record) => record.externalId)).not.toContain(
      "red_free"
    );
    expect(result.externalBilling?.records.every((record) => record.amountUsd == null)).toBe(true);
    expect(result.rawData).toEqual(
      expect.objectContaining({
        services: expect.arrayContaining([
          expect.objectContaining({ id: "srv_paid", runtime: "node", paidPlan: true }),
          expect.objectContaining({ id: "srv_free", paidPlan: false }),
        ]),
        postgres: [
          expect.objectContaining({
            id: "dpg_primary",
            readReplicas: [{ id: "dpg_replica", name: "usage-db-replica" }],
          }),
        ],
      })
    );
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain(
      "https://api.render.com/v1/services?limit=100&cursor=service-srv_paid"
    );
    expect(urls).toContain(
      "https://api.render.com/v1/services?limit=100&cursor=service-srv_free"
    );
    expect(urls).toContain(
      "https://api.render.com/v1/postgres?limit=100&cursor=postgres-dpg_primary"
    );
    expect(urls).toContain(
      "https://api.render.com/v1/key-value?limit=100&cursor=keyValue-red_paid"
    );
  });

  it("keeps accepting legacy serviceId config while using account-wide discovery", async () => {
    mockRenderLists({
      "/v1/services:first": [
        {
          id: "srv_current",
          name: "api-usage-monitor",
          type: "web_service",
          suspended: "not_suspended",
          plan: "legacy-fallback",
          serviceDetails: { plan: "starter", runtime: "node" },
        },
      ],
    });

    const result = await fetchUsage("token", { serviceId: "srv_current" });

    expect(result.externalBilling?.records[0]?.planName).toBe("starter");
    expect(result.rawData).toEqual(
      expect.objectContaining({
        services: [expect.objectContaining({ plan: "starter", runtime: "node" })],
      })
    );
  });

  it("rejects a malformed resource class instead of reconciling a partial inventory", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/postgres")) {
        return new Response(JSON.stringify({ postgres: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return renderPage(url.pathname.endsWith("/services") ? "service" : "keyValue", []);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it.each([
    [
      "non-static service plan",
      {
        "/v1/services:first": [
          { id: "srv_bad", type: "web_service", serviceDetails: { runtime: "node" } },
        ],
      },
    ],
    [
      "service details object",
      {
        "/v1/services:first": [
          { id: "srv_bad", type: "web_service", plan: "starter", serviceDetails: [] },
        ],
      },
    ],
    [
      "Postgres plan",
      { "/v1/postgres:first": [{ id: "dpg_bad", status: "available" }] },
    ],
    [
      "Key Value plan",
      { "/v1/key-value:first": [{ id: "red_bad", status: "available" }] },
    ],
    [
      "persistent disk identity",
      {
        "/v1/services:first": [
          {
            id: "srv_bad_disk",
            type: "web_service",
            serviceDetails: { plan: "starter", disk: { sizeGB: 10 } },
          },
        ],
      },
    ],
    [
      "persistent disk size",
      {
        "/v1/services:first": [
          {
            id: "srv_bad_disk",
            type: "web_service",
            serviceDetails: { plan: "starter", disk: { id: "dsk_bad" } },
          },
        ],
      },
    ],
  ])("rejects a resource missing its required %s", async (_field, pages) => {
    mockRenderLists(pages);

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("allows the documented plan-less static-site shape", async () => {
    mockRenderLists({
      "/v1/services:first": [
        { id: "srv_static", name: "landing", type: "static_site" },
      ],
    });

    const result = await fetchUsage("token");

    expect(result.externalBilling).toMatchObject({
      authoritative: true,
      records: [],
    });
    expect(result.rawData).toMatchObject({
      services: [{ id: "srv_static", type: "static_site", plan: null }],
    });
  });
});
