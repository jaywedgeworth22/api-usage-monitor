import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface HetznerPrice {
  net?: string;
  gross?: string;
}

interface HetznerLocation {
  name?: string;
}

interface LocationPrice {
  location?: string;
  price_monthly?: HetznerPrice;
}

interface NamedLocationPrices {
  name?: string;
  type?: string;
  prices?: LocationPrice[];
}

interface HetznerPricing {
  currency?: string;
  vat_rate?: string;
  image?: { price_per_gb_month?: HetznerPrice };
  floating_ip?: { price_monthly?: HetznerPrice };
  floating_ips?: NamedLocationPrices[];
  primary_ips?: NamedLocationPrices[];
  server_backup?: { percentage?: string };
  server_types?: NamedLocationPrices[];
  load_balancer_types?: NamedLocationPrices[];
  volume?: { price_per_gb_month?: HetznerPrice };
}

interface HetznerServer {
  id?: number;
  name?: string;
  status?: string;
  outgoing_traffic?: number | null;
  backup_window?: string | null;
  server_type?: { name?: string; prices?: LocationPrice[] };
  location?: HetznerLocation;
  // Deprecated by Hetzner after 2026-07-01, retained only as a fallback for
  // older responses during the transition.
  datacenter?: { location?: HetznerLocation };
}

interface HetznerVolume {
  id?: number;
  name?: string;
  status?: string;
  server?: number | null;
  size?: number;
  location?: HetznerLocation;
}

interface HetznerFloatingIp {
  id?: number;
  name?: string;
  description?: string | null;
  type?: string;
  server?: number | null;
  blocked?: boolean;
  home_location?: HetznerLocation;
}

interface HetznerPrimaryIp {
  id?: number;
  name?: string;
  type?: string;
  assignee_id?: number | null;
  assignee_type?: string;
  blocked?: boolean;
  location?: HetznerLocation;
  datacenter?: { location?: HetznerLocation } | null;
}

interface HetznerLoadBalancer {
  id?: number;
  name?: string;
  location?: HetznerLocation;
  load_balancer_type?: { name?: string };
  outgoing_traffic?: number | null;
  ingoing_traffic?: number | null;
}

interface HetznerImage {
  id?: number;
  name?: string | null;
  description?: string;
  type?: string;
  status?: string;
  image_size?: number | null;
  disk_size?: number;
  created_from?: { id?: number; name?: string } | null;
}

const ITEMS_PER_PAGE = 50;
const MAX_PAGES = 1_000;

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchAllResources<T extends { id?: number }>(
  path: string,
  collectionKey:
    | "servers"
    | "volumes"
    | "floating_ips"
    | "primary_ips"
    | "load_balancers"
    | "images",
  headers: Record<string, string>,
  extraQuery: Array<[string, string]> = []
): Promise<T[]> {
  const resources: T[] = [];
  const seenIds = new Set<number>();
  let expectedLastPage: number | null = null;
  let expectedTotalEntries: number | null = null;
  for (let requestedPage = 1; requestedPage <= MAX_PAGES; requestedPage += 1) {
    const query = new URLSearchParams(extraQuery);
    query.set("per_page", String(ITEMS_PER_PAGE));
    query.set("page", String(requestedPage));
    const response = await fetchJson(
      `https://api.hetzner.cloud/v1${path}?${query}`,
      { headers }
    );
    if (!response.ok) return errorResult(response.status);
    if (!isRecord(response.data)) {
      invalidResponse(`Hetzner returned an invalid ${collectionKey} response`);
    }
    const data = response.data;
    const rows = data[collectionKey];
    const pagination = isRecord(data.meta) && isRecord(data.meta.pagination)
      ? data.meta.pagination
      : null;
    const page = pagination?.page;
    const perPage = pagination?.per_page;
    const lastPage = pagination?.last_page;
    const totalEntries = pagination?.total_entries;
    if (
      !Array.isArray(rows) ||
      !Number.isSafeInteger(page) ||
      page !== requestedPage ||
      !Number.isSafeInteger(perPage) ||
      (perPage as number) <= 0 ||
      rows.length > (perPage as number) ||
      !Number.isSafeInteger(lastPage) ||
      (lastPage as number) < requestedPage ||
      (lastPage as number) < 1 ||
      !Number.isSafeInteger(totalEntries) ||
      (totalEntries as number) < 0
    ) {
      invalidResponse(`Hetzner ${collectionKey} pagination metadata is invalid`);
    }
    if (
      (expectedLastPage != null && expectedLastPage !== lastPage) ||
      (expectedTotalEntries != null && expectedTotalEntries !== totalEntries)
    ) {
      invalidResponse(`Hetzner ${collectionKey} pagination totals changed between pages`);
    }
    expectedLastPage = lastPage as number;
    expectedTotalEntries = totalEntries as number;
    for (const row of rows) {
      const id = row && typeof row === "object" ? (row as { id?: unknown }).id : null;
      if (!Number.isSafeInteger(id) || (id as number) <= 0) {
        invalidResponse(`Hetzner returned a ${collectionKey} resource without an id`);
      }
      if (seenIds.has(id as number)) {
        invalidResponse(`Hetzner returned duplicate ${collectionKey} id ${id}`);
      }
      seenIds.add(id as number);
      resources.push(row as T);
    }

    const nextPage = pagination?.next_page;
    if (nextPage == null) {
      if (
        requestedPage !== expectedLastPage ||
        resources.length !== expectedTotalEntries
      ) {
        invalidResponse(`Hetzner ${collectionKey} pagination ended before all resources were read`);
      }
      return resources;
    }
    if (
      !Number.isSafeInteger(nextPage) ||
      (nextPage as number) < 1 ||
      nextPage !== requestedPage + 1 ||
      requestedPage >= expectedLastPage ||
      nextPage > expectedLastPage
    ) {
      invalidResponse(`Hetzner ${collectionKey} pagination did not advance`);
    }
  }
  invalidResponse(`Hetzner ${collectionKey} pagination exceeded the safety limit`);
}

function locationName(
  direct: HetznerLocation | undefined,
  legacy?: { location?: HetznerLocation } | null
): string | null {
  return direct?.name?.trim() || legacy?.location?.name?.trim() || null;
}

function catalogNumber(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function locationPrice(
  catalog: NamedLocationPrices[] | undefined,
  selector: string | null,
  location: string | null,
  fallback: LocationPrice[] = []
): number | null {
  if (!selector || !location) return null;
  const entry = catalog?.find(
    (candidate) => candidate.name === selector || candidate.type === selector
  );
  const prices = entry?.prices ?? fallback;
  return catalogNumber(
    prices.find((candidate) => candidate.location === location)?.price_monthly?.net
  );
}

function priceMetadata(amount: number | null, currency: string | null) {
  return amount == null || currency == null ? null : { amount, currency };
}

function roundCatalogAmount(amount: number): number {
  // Catalog rates can include sub-cent per-GB/hour fractions. Keep useful
  // precision while avoiding binary floating-point artifacts in snapshots.
  return Math.round((amount + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  // Each list is independently paginated. Await every class before producing
  // an authoritative reconciliation so a transient failure cannot delete a
  // class of resources from the previous good inventory.
  const [servers, volumes, floatingIps, primaryIps, loadBalancers, images, pricingResponse] =
    await Promise.all([
      fetchAllResources<HetznerServer>("/servers", "servers", headers),
      fetchAllResources<HetznerVolume>("/volumes", "volumes", headers),
      fetchAllResources<HetznerFloatingIp>("/floating_ips", "floating_ips", headers),
      fetchAllResources<HetznerPrimaryIp>("/primary_ips", "primary_ips", headers),
      fetchAllResources<HetznerLoadBalancer>(
        "/load_balancers",
        "load_balancers",
        headers
      ),
      fetchAllResources<HetznerImage>("/images", "images", headers, [
        ["type", "snapshot"],
        ["type", "backup"],
      ]),
      fetchJson("https://api.hetzner.cloud/v1/pricing", { headers }),
    ]);

  if (!pricingResponse.ok) return errorResult(pricingResponse.status);
  if (!pricingResponse.data || typeof pricingResponse.data !== "object") {
    invalidResponse("Hetzner returned an invalid pricing response");
  }
  const pricing = (pricingResponse.data as { pricing?: HetznerPricing }).pricing;
  if (!pricing || typeof pricing !== "object") {
    invalidResponse("Hetzner returned no pricing catalog");
  }
  const currency = pricing.currency?.trim().toUpperCase() || null;
  const backupPercentage = catalogNumber(pricing.server_backup?.percentage);
  const volumePricePerGb = catalogNumber(pricing.volume?.price_per_gb_month?.net);
  const imagePricePerGb = catalogNumber(pricing.image?.price_per_gb_month?.net);

  let pricingComplete = currency != null;
  const runRateByResource = {
    servers: 0,
    serverBackups: 0,
    volumes: 0,
    floatingIps: 0,
    primaryIps: 0,
    loadBalancers: 0,
    snapshots: 0,
  };
  let totalBandwidthBytes = 0;
  const records: AdapterExternalBillingRecord[] = [];

  const serverInventory = servers.map((server) => {
    if (!("backup_window" in server)) {
      invalidResponse(`Hetzner server ${server.id ?? "unknown"} omitted backup_window`);
    }
    if (
      server.backup_window !== null &&
      (typeof server.backup_window !== "string" || !server.backup_window.trim())
    ) {
      invalidResponse(`Hetzner server ${server.id ?? "unknown"} has invalid backup_window`);
    }
    const location = locationName(server.location, server.datacenter);
    const type = server.server_type?.name?.trim() || null;
    const monthlyPrice = locationPrice(
      pricing.server_types,
      type,
      location,
      server.server_type?.prices
    );
    if (monthlyPrice == null) pricingComplete = false;
    else runRateByResource.servers += monthlyPrice;
    const backupEnabled = Boolean(server.backup_window?.trim());
    const backupMonthlyPrice = backupEnabled && monthlyPrice != null && backupPercentage != null
      ? roundCatalogAmount(monthlyPrice * (backupPercentage / 100))
      : backupEnabled
        ? null
        : 0;
    if (backupEnabled && backupMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.serverBackups += backupMonthlyPrice ?? 0;
    if (typeof server.outgoing_traffic === "number") {
      totalBandwidthBytes += server.outgoing_traffic;
    }
    if (server.id != null && monthlyPrice != null && monthlyPrice > 0) {
      records.push({
        externalId: String(server.id),
        kind: "service_plan",
        serviceName: server.name ?? `Server ${server.id}`,
        planName: type,
        status: server.status ?? "unknown",
        currency,
        rollupRole: "canonical",
      });
    }
    if (server.id != null && backupEnabled && backupMonthlyPrice != null && backupMonthlyPrice > 0) {
      records.push({
        externalId: `server-backup:${server.id}`,
        kind: "service_plan",
        serviceName: `${server.name ?? `Server ${server.id}`} backups`,
        planName: backupPercentage == null ? "Backups" : `Backups (${backupPercentage}%)`,
        status: "active",
        currency,
        rollupRole: "component",
      });
    }
    return {
      id: server.id ?? null,
      name: server.name ?? null,
      status: server.status ?? null,
      type,
      location,
      outgoingTrafficBytes: server.outgoing_traffic ?? null,
      backupEnabled,
      monthlyCatalogPrice: priceMetadata(monthlyPrice, currency),
      backupMonthlyCatalogPrice: backupEnabled
        ? priceMetadata(backupMonthlyPrice, currency)
        : null,
    };
  });

  const volumeInventory = volumes.map((volume) => {
    const monthlyPrice =
      volumePricePerGb != null && typeof volume.size === "number" && volume.size >= 0
        ? roundCatalogAmount(volumePricePerGb * volume.size)
        : null;
    if (monthlyPrice == null) pricingComplete = false;
    else runRateByResource.volumes += monthlyPrice;
    if (volume.id != null && monthlyPrice != null && monthlyPrice > 0) {
      records.push({
        externalId: `volume:${volume.id}`,
        kind: "service_plan",
        serviceName: volume.name ?? `Volume ${volume.id}`,
        planName: `${volume.size} GB volume`,
        status: volume.status ?? "available",
        currency,
        usageQuantity: volume.size ?? null,
        usageUnit: "GB",
        rollupRole: volume.server == null ? "canonical" : "component",
      });
    }
    return {
      id: volume.id ?? null,
      name: volume.name ?? null,
      status: volume.status ?? null,
      serverId: volume.server ?? null,
      sizeGB: volume.size ?? null,
      location: locationName(volume.location),
      monthlyCatalogPrice: priceMetadata(monthlyPrice, currency),
    };
  });

  const floatingIpInventory = floatingIps.map((ip) => {
    const location = locationName(ip.home_location);
    const type = ip.type?.trim() || null;
    const typedPrice = locationPrice(pricing.floating_ips, type, location);
    const monthlyPrice = (pricing.floating_ips?.length ?? 0) > 0
      ? typedPrice
      : catalogNumber(pricing.floating_ip?.price_monthly?.net);
    if (monthlyPrice == null) pricingComplete = false;
    else runRateByResource.floatingIps += monthlyPrice;
    if (ip.id != null && monthlyPrice != null && monthlyPrice > 0) {
      records.push({
        externalId: `floating-ip:${ip.id}`,
        kind: "service_plan",
        serviceName: ip.name || ip.description || `Floating IP ${ip.id}`,
        planName: type ? `Floating ${type.toUpperCase()}` : "Floating IP",
        status: ip.blocked ? "blocked" : "active",
        currency,
        rollupRole: ip.server == null ? "canonical" : "component",
      });
    }
    return {
      id: ip.id ?? null,
      name: ip.name || ip.description || null,
      type,
      serverId: ip.server ?? null,
      blocked: ip.blocked ?? null,
      location,
      monthlyCatalogPrice: priceMetadata(monthlyPrice, currency),
    };
  });

  const primaryIpInventory = primaryIps.map((ip) => {
    const location = locationName(ip.location, ip.datacenter);
    const type = ip.type?.trim() || null;
    const monthlyPrice = locationPrice(pricing.primary_ips, type, location);
    if (monthlyPrice == null) pricingComplete = false;
    else runRateByResource.primaryIps += monthlyPrice;
    if (ip.id != null && monthlyPrice != null && monthlyPrice > 0) {
      records.push({
        externalId: `primary-ip:${ip.id}`,
        kind: "service_plan",
        serviceName: ip.name ?? `Primary IP ${ip.id}`,
        planName: type ? `Primary ${type.toUpperCase()}` : "Primary IP",
        status: ip.blocked ? "blocked" : "active",
        currency,
        rollupRole: ip.assignee_id == null ? "canonical" : "component",
      });
    }
    return {
      id: ip.id ?? null,
      name: ip.name ?? null,
      type,
      assigneeId: ip.assignee_id ?? null,
      assigneeType: ip.assignee_type ?? null,
      blocked: ip.blocked ?? null,
      location,
      monthlyCatalogPrice: priceMetadata(monthlyPrice, currency),
    };
  });

  const loadBalancerInventory = loadBalancers.map((loadBalancer) => {
    const location = locationName(loadBalancer.location);
    const type = loadBalancer.load_balancer_type?.name?.trim() || null;
    const monthlyPrice = locationPrice(pricing.load_balancer_types, type, location);
    if (monthlyPrice == null) pricingComplete = false;
    else runRateByResource.loadBalancers += monthlyPrice;
    if (typeof loadBalancer.outgoing_traffic === "number") {
      totalBandwidthBytes += loadBalancer.outgoing_traffic;
    }
    if (loadBalancer.id != null && monthlyPrice != null && monthlyPrice > 0) {
      records.push({
        externalId: `load-balancer:${loadBalancer.id}`,
        kind: "service_plan",
        serviceName: loadBalancer.name ?? `Load Balancer ${loadBalancer.id}`,
        planName: type,
        status: "active",
        currency,
        rollupRole: "canonical",
      });
    }
    return {
      id: loadBalancer.id ?? null,
      name: loadBalancer.name ?? null,
      type,
      location,
      outgoingTrafficBytes: loadBalancer.outgoing_traffic ?? null,
      ingoingTrafficBytes: loadBalancer.ingoing_traffic ?? null,
      monthlyCatalogPrice: priceMetadata(monthlyPrice, currency),
    };
  });

  const imageInventory = images.map((image) => {
    // Automatic backup artifacts are already represented by the one flat
    // backup add-on on their source server. Only snapshots use per-GB image
    // pricing, otherwise the same backup would be counted up to seven times.
    if (image.type !== "snapshot" && image.type !== "backup") {
      invalidResponse(`Hetzner image ${image.id ?? "unknown"} has an unsupported type`);
    }
    const isSnapshot = image.type === "snapshot";
    const monthlyPrice = isSnapshot && imagePricePerGb != null && image.image_size != null
      ? roundCatalogAmount(imagePricePerGb * image.image_size)
      : isSnapshot
        ? null
        : 0;
    if (isSnapshot && monthlyPrice == null) pricingComplete = false;
    else runRateByResource.snapshots += monthlyPrice ?? 0;
    if (image.id != null && isSnapshot && monthlyPrice != null && monthlyPrice > 0) {
      records.push({
        externalId: `snapshot:${image.id}`,
        kind: "service_plan",
        serviceName: image.name || image.description || `Snapshot ${image.id}`,
        planName: image.image_size == null ? "Snapshot" : `${image.image_size} GB snapshot`,
        status: image.status ?? "unknown",
        currency,
        usageQuantity: image.image_size,
        usageUnit: "GB",
        rollupRole: "canonical",
      });
    }
    return {
      id: image.id ?? null,
      name: image.name || image.description || null,
      type: image.type ?? null,
      status: image.status ?? null,
      imageSizeGB: image.image_size ?? null,
      diskSizeGB: image.disk_size ?? null,
      sourceServerId: image.created_from?.id ?? null,
      monthlyCatalogPrice: isSnapshot ? priceMetadata(monthlyPrice, currency) : null,
      priceIncludedInServerBackup: image.type === "backup",
    };
  });

  const runRateAmount = roundCatalogAmount(
    Object.values(runRateByResource).reduce((sum, amount) => sum + amount, 0)
  );

  return {
    balance: null,
    // The catalog is a current full-month run-rate, not an invoice or accrued
    // month-to-date bill. Never write it into the USD spend path.
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      servers: serverInventory,
      volumes: volumeInventory,
      floatingIps: floatingIpInventory,
      primaryIps: primaryIpInventory,
      loadBalancers: loadBalancerInventory,
      images: imageInventory,
      resourceCounts: {
        servers: serverInventory.length,
        volumes: volumeInventory.length,
        floatingIps: floatingIpInventory.length,
        primaryIps: primaryIpInventory.length,
        loadBalancers: loadBalancerInventory.length,
        snapshots: imageInventory.filter((image) => image.type === "snapshot").length,
        backups: imageInventory.filter((image) => image.type === "backup").length,
      },
      totalBandwidthBytes,
      monthlyRunRate: pricingComplete
        ? {
            amount: runRateAmount,
            currency,
            basis: "current_resource_catalog_net_monthly_maximum",
            byResource: runRateByResource,
          }
        : null,
      pricingVatRate: pricing.vat_rate ?? null,
      capabilities: {
        completeResourceInventory: true,
        catalogMonthlyRunRate: pricingComplete,
        actualInvoiceCost: false,
        accountCurrencyKnown: currency != null,
        currencyConversionApplied: false,
        backupArtifactDoubleCountAvoided: true,
      },
    },
    externalBilling: pricingComplete
      ? {
          // Keep the existing namespace so the expanded authoritative list
          // replaces, rather than strands, legacy server-only records.
          source: "hetzner-cloud-server-plans",
          authoritative: true,
          records,
        }
      : undefined,
  };
}
