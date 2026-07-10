import { fetchJson, type UsageResult } from "./helpers";

interface ServerPrice {
  location: string;
  price_hourly: { net: string; gross: string };
  price_monthly: { net: string; gross: string };
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  outgoing_traffic: number | null;
  server_type: {
    name: string;
    prices: ServerPrice[];
  };
  datacenter: {
    location: {
      name: string;
    };
  };
}

interface HetznerServersResponse {
  servers: HetznerServer[];
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };

  const rawData: Record<string, unknown> = {};
  let totalCost: number | null = null;
  let totalRequests = 0;
  let totalBandwidth_bytes = 0;

  try {
    const res = await fetchJson("https://api.hetzner.cloud/v1/servers", {
      headers,
    });

    if (!res.ok) {
      return {
        balance: null,
        totalCost: null,
        totalRequests: null,
        credits: null,
        rawData: { error: `HTTP ${res.status}` },
      };
    }

    const data = res.data as HetznerServersResponse;
    rawData.servers = data.servers.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      type: s.server_type.name,
      location: s.datacenter.location.name,
      outgoing_traffic: s.outgoing_traffic,
    }));

    let estimatedMonthlyCost = 0;
    
    for (const server of data.servers) {
      totalRequests += 1;
      
      if (server.outgoing_traffic != null) {
        totalBandwidth_bytes += server.outgoing_traffic;
      }

      // Find the price for the server's specific location
      const locationName = server.datacenter.location.name;
      const priceForLocation = server.server_type.prices.find(
        (p) => p.location === locationName
      );

      // Fallback to the first price if location-specific price isn't found
      const priceStr = priceForLocation?.price_monthly?.net 
        ?? server.server_type.prices[0]?.price_monthly?.net 
        ?? "0";
      
      estimatedMonthlyCost += parseFloat(priceStr);
    }

    totalCost = estimatedMonthlyCost;
    rawData.totalBandwidth_bytes = totalBandwidth_bytes;
    rawData.note = "totalCost is the estimated monthly run-rate based on active servers.";
    
  } catch (err) {
    rawData.error = err instanceof Error ? err.message : "Failed to fetch from Hetzner API";
  }

  return {
    balance: null,
    totalCost,
    totalRequests, // We'll use totalRequests to track the number of active servers
    credits: null,
    rawData,
  };
}
