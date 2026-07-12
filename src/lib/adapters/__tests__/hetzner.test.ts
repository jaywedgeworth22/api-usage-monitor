import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchUsage } from "../hetzner";

describe("hetzner adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs server plans without misclassifying run-rate as accrued spend", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        servers: [
          {
            id: 1,
            name: "server1",
            status: "running",
            outgoing_traffic: 1000,
            datacenter: { location: { name: "fsn1" } },
            server_type: {
              name: "cx11",
              prices: [
                {
                  location: "fsn1",
                  price_monthly: { net: "3.50", gross: "4.16" },
                  price_hourly: { net: "0.005", gross: "0.006" },
                },
              ],
            },
          },
          {
            id: 2,
            name: "server2",
            status: "running",
            outgoing_traffic: 500,
            datacenter: { location: { name: "nbg1" } },
            server_type: {
              name: "cx21",
              prices: [
                {
                  location: "nbg1",
                  price_monthly: { net: "5.00", gross: "5.95" },
                  price_hourly: { net: "0.008", gross: "0.009" },
                },
              ],
            },
          },
        ],
        meta: { pagination: { page: 1, next_page: null } },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pricing: {
          currency: "EUR",
          vat_rate: "19.00",
          server_types: [
            { name: "cx11", prices: [{ location: "fsn1", price_monthly: { net: "3.50", gross: "4.16" } }] },
            { name: "cx21", prices: [{ location: "nbg1", price_monthly: { net: "5.00", gross: "5.95" } }] },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await fetchUsage("fake-key");

    expect(fetchSpy).toHaveBeenCalledWith("https://api.hetzner.cloud/v1/servers?per_page=50&page=1", {
      headers: { Authorization: "Bearer fake-key" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBeNull();
    
    const rawData = result.rawData as Record<string, unknown>;
    expect(rawData.totalBandwidthBytes).toBe(1500);
    expect(rawData.monthlyRunRate).toEqual({ amount: 8.5, currency: "EUR" });
    expect(rawData.servers).toHaveLength(2);
    expect(result.externalBilling?.records).toHaveLength(2);
    expect(result.externalBilling?.records[0]).toMatchObject({
      serviceName: "server1",
      amountUsd: 3.5,
      currency: "EUR",
    });
  });

  it("paginates every server before emitting an authoritative inventory", async () => {
    const server = (id: number, name: string) => ({
      id,
      name,
      status: "running",
      datacenter: { location: { name: "fsn1" } },
      server_type: { name: "cx11" },
    });
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        servers: [server(1, "one")],
        meta: { pagination: { page: 1, next_page: 2 } },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pricing: {
          currency: "EUR",
          server_types: [{
            name: "cx11",
            prices: [{ location: "fsn1", price_monthly: { net: "3.50" } }],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        servers: [server(2, "two")],
        meta: { pagination: { page: 2, next_page: null } },
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await fetchUsage("key");

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(
      "https://api.hetzner.cloud/v1/servers?per_page=50&page=2"
    );
    expect(result.externalBilling?.records.map((record) => record.serviceName)).toEqual([
      "one",
      "two",
    ]);
  });

  it("preserves the previous authoritative inventory when pricing is incomplete", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        servers: [{
          id: 1,
          name: "server1",
          status: "running",
          datacenter: { location: { name: "hel1" } },
          server_type: { name: "cx11" },
        }],
        meta: { pagination: { page: 1, next_page: null } },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pricing: {
          currency: "EUR",
          server_types: [{
            name: "cx11",
            prices: [{ location: "fsn1", price_monthly: { net: "3.50" } }],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await fetchUsage("key");

    expect(result.externalBilling).toBeUndefined();
    expect((result.rawData as { monthlyRunRate: unknown }).monthlyRunRate).toBeNull();
  });

  it("handles fetch errors", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(fetchUsage("bad-key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
    });
  });
});
