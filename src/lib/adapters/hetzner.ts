import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface ServerPrice {
  location?: string;
  price_monthly?: { net?: string; gross?: string };
}

interface HetznerServerTypePrice {
  name?: string;
  prices?: ServerPrice[];
}

interface HetznerPricing {
  currency?: string;
  vat_rate?: string;
  server_types?: HetznerServerTypePrice[];
}

interface HetznerServer {
  id?: number;
  name?: string;
  status?: string;
  outgoing_traffic?: number | null;
  server_type?: { name?: string; prices?: ServerPrice[] };
  datacenter?: { location?: { name?: string } };
}

const SERVERS_PER_PAGE = 50;
const MAX_SERVER_PAGES = 1_000;

async function fetchAllServers(
  headers: Record<string, string>
): Promise<HetznerServer[]> {
  const servers: HetznerServer[] = [];
  for (let requestedPage = 1; requestedPage <= MAX_SERVER_PAGES; requestedPage += 1) {
    const response = await fetchJson(
      `https://api.hetzner.cloud/v1/servers?per_page=${SERVERS_PER_PAGE}&page=${requestedPage}`,
      { headers }
    );
    if (!response.ok) return errorResult(response.status);
    if (!response.data || typeof response.data !== "object") {
      throw new AdapterError("Hetzner returned an invalid servers response", {
        code: "INVALID_RESPONSE",
      });
    }
    const data = response.data as {
      servers?: HetznerServer[];
      meta?: {
        pagination?: {
          page?: number;
          next_page?: number | null;
        };
      };
    };
    const page = data.meta?.pagination;
    if (!Array.isArray(data.servers) || page?.page !== requestedPage) {
      throw new AdapterError("Hetzner servers pagination metadata is invalid", {
        code: "INVALID_RESPONSE",
      });
    }
    for (const server of data.servers) {
      if (!server || typeof server !== "object" || server.id == null) {
        throw new AdapterError("Hetzner returned a server without an id", {
          code: "INVALID_RESPONSE",
        });
      }
      servers.push(server);
    }
    if (page.next_page == null) return servers;
    if (!Number.isSafeInteger(page.next_page) || page.next_page !== requestedPage + 1) {
      throw new AdapterError("Hetzner servers pagination did not advance", {
        code: "INVALID_RESPONSE",
      });
    }
  }
  throw new AdapterError("Hetzner servers pagination exceeded the safety limit", {
    code: "INVALID_RESPONSE",
  });
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const [serverRows, pricingResponse] = await Promise.all([
    fetchAllServers(headers),
    fetchJson("https://api.hetzner.cloud/v1/pricing", { headers }),
  ]);

  const pricingData = pricingResponse.ok && pricingResponse.data && typeof pricingResponse.data === "object"
    ? ((pricingResponse.data as { pricing?: HetznerPricing }).pricing ?? null)
    : null;
  const pricingCurrency = pricingData?.currency?.trim().toUpperCase() || null;
  const pricingByServerType = new Map(
    (pricingData?.server_types ?? [])
      .filter((entry): entry is HetznerServerTypePrice & { name: string } => Boolean(entry.name))
      .map((entry) => [entry.name, entry.prices ?? []])
  );

  let monthlyRunRate = 0;
  let pricingComplete = pricingCurrency != null;
  let totalBandwidthBytes = 0;
  const records: AdapterExternalBillingRecord[] = [];
  const servers = serverRows.map((server) => {
    const location = server.datacenter?.location?.name;
    const prices =
      pricingByServerType.get(server.server_type?.name ?? "") ??
      server.server_type?.prices ??
      [];
    const price = location
      ? prices.find((entry) => entry.location === location)
      : undefined;
    const monthlyPrice = pricingCurrency
      ? parseNumber(price?.price_monthly?.net)
      : null;
    if (monthlyPrice != null) {
      monthlyRunRate += monthlyPrice;
    } else {
      pricingComplete = false;
    }
    if (typeof server.outgoing_traffic === "number") {
      totalBandwidthBytes += server.outgoing_traffic;
    }
    if (server.id != null) {
      records.push({
        externalId: String(server.id),
        kind: "service_plan",
        serviceName: server.name ?? `Server ${server.id}`,
        planName: server.server_type?.name ?? null,
        status: server.status ?? "unknown",
        amountUsd: monthlyPrice,
        currency: pricingCurrency,
        billingInterval: "monthly",
        rollupRole: "canonical",
      });
    }
    return {
      id: server.id ?? null,
      name: server.name ?? null,
      status: server.status ?? null,
      type: server.server_type?.name ?? null,
      location: location ?? null,
      outgoingTrafficBytes: server.outgoing_traffic ?? null,
      monthlyPlanPrice: monthlyPrice,
      currency: pricingCurrency,
    };
  });

  return {
    balance: null,
    // Hetzner's API exposes current resource prices, not an invoice or accrued
    // month-to-date bill. Do not misclassify the monthly run-rate as spend.
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      servers,
      serverCount: servers.length,
      totalBandwidthBytes,
      monthlyRunRate: pricingComplete
        ? { amount: monthlyRunRate, currency: pricingCurrency }
        : null,
      pricingVatRate: pricingData?.vat_rate ?? null,
      capabilities: {
        servicePlan: true,
        serviceStatus: true,
        monthlyRunRate: pricingComplete,
        actualInvoiceCost: false,
        accountCurrencyKnown: pricingCurrency != null,
        completeServerInventory: true,
      },
    },
    externalBilling: pricingComplete
      ? {
          source: "hetzner-cloud-server-plans",
          authoritative: true,
          records,
        }
      : undefined,
  };
}
