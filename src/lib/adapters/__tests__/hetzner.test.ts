import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchUsage } from "../hetzner";

describe("hetzner adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches servers and calculates cost and bandwidth", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
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
      }),
    } as unknown as Response);

    const result = await fetchUsage("fake-key");

    expect(fetchSpy).toHaveBeenCalledWith("https://api.hetzner.cloud/v1/servers", {
      headers: { Authorization: "Bearer fake-key" },
      signal: expect.any(AbortSignal),
    });

    expect(result.totalCost).toBe(8.5); // 3.50 + 5.00
    expect(result.totalRequests).toBe(2); // 2 active servers
    
    const rawData = result.rawData as Record<string, unknown>;
    expect(rawData.totalBandwidth_bytes).toBe(1500); // 1000 + 500
    expect(rawData.servers).toHaveLength(2);
  });

  it("handles fetch errors", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      headers: new Headers(),
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Unauthorized",
    } as unknown as Response);

    const result = await fetchUsage("bad-key");
    expect(result.totalCost).toBeNull();
    const rawData = result.rawData as Record<string, unknown>;
    expect(rawData.error).toBe("HTTP 401");
  });
});
