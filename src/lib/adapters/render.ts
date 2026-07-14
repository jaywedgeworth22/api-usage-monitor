import {
  AdapterError,
  errorResult,
  fetchJson,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface RenderDisk {
  id?: string;
  name?: string;
  sizeGB?: number;
  mountPath?: string;
}

interface RenderServiceDetails {
  plan?: string;
  runtime?: string;
  env?: string;
  region?: string;
  numInstances?: number;
  autoscaling?: {
    enabled?: boolean;
    min?: number;
    max?: number;
  };
  disk?: RenderDisk;
  buildPlan?: string;
}

interface RenderService {
  id?: string;
  name?: string;
  type?: string;
  // Retain the legacy top-level fallbacks for older API responses.
  plan?: string;
  runtime?: string;
  env?: string;
  serviceDetails?: RenderServiceDetails;
  suspended?: string | boolean;
  updatedAt?: string;
}

interface RenderReadReplica {
  id?: string;
  name?: string;
}

interface RenderPostgres {
  id?: string;
  name?: string;
  plan?: string;
  status?: string;
  suspended?: string;
  region?: string;
  role?: string;
  version?: string;
  diskSizeGB?: number;
  diskAutoscalingEnabled?: boolean;
  highAvailabilityEnabled?: boolean;
  readReplicas?: RenderReadReplica[];
  updatedAt?: string;
}

interface RenderKeyValue {
  id?: string;
  name?: string;
  plan?: string;
  status?: string;
  region?: string;
  version?: string;
  options?: {
    maxmemoryPolicy?: string;
    persistenceMode?: string;
  };
  updatedAt?: string;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderStatus(suspended: string | boolean | undefined, status?: string): string {
  if (suspended === true || suspended === "suspended") return "suspended";
  if (status?.trim()) return status.trim();
  return "active";
}

function isPaidPlan(plan: string | null): boolean {
  return plan != null && plan.trim().toLowerCase() !== "free";
}

function requiredPlan(
  resourceKind: string,
  resourceId: string | undefined,
  value: unknown
): string {
  if (typeof value !== "string" || !value.trim()) {
    invalidResponse(
      `Render ${resourceKind} ${resourceId ?? "unknown"} omitted its required plan`
    );
  }
  return value.trim();
}

function validateServiceDisk(service: RenderService): RenderDisk | undefined {
  const disk = service.serviceDetails?.disk;
  if (disk == null) return undefined;
  if (
    typeof disk !== "object" ||
    typeof disk.id !== "string" ||
    !disk.id.trim() ||
    typeof disk.sizeGB !== "number" ||
    !Number.isFinite(disk.sizeGB) ||
    disk.sizeGB <= 0
  ) {
    invalidResponse(
      `Render service ${service.id ?? "unknown"} returned an incomplete persistent disk`
    );
  }
  return { ...disk, id: disk.id.trim() };
}

async function fetchAllRenderResources<T extends { id?: string }>(
  path: string,
  resourceKey: "service" | "postgres" | "keyValue",
  headers: Record<string, string>
): Promise<T[]> {
  const resources: T[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor != null) query.set("cursor", cursor);
    const response = await fetchJson(`https://api.render.com/v1${path}?${query}`, {
      headers,
    });
    if (!response.ok) return errorResult(response.status);
    if (!Array.isArray(response.data)) {
      invalidResponse(`Render returned an invalid ${resourceKey} list`);
    }

    const rows = response.data as unknown[];
    if (rows.length === 0) return resources;

    let nextCursor: string | null = null;
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        invalidResponse(`Render returned an invalid ${resourceKey} page row`);
      }
      const record = row as Record<string, unknown>;
      const resource = record[resourceKey];
      const rowCursor = record.cursor;
      if (
        !resource ||
        typeof resource !== "object" ||
        typeof (resource as { id?: unknown }).id !== "string" ||
        !(resource as { id: string }).id.trim() ||
        typeof rowCursor !== "string" ||
        !rowCursor.trim()
      ) {
        invalidResponse(`Render returned an incomplete ${resourceKey} page row`);
      }
      const id = (resource as { id: string }).id;
      if (seenIds.has(id)) {
        invalidResponse(`Render returned duplicate ${resourceKey} id ${id}`);
      }
      seenIds.add(id);
      resources.push(resource as T);
      nextCursor = rowCursor;
    }

    if (!nextCursor || seenCursors.has(nextCursor)) {
      invalidResponse(`Render ${resourceKey} pagination did not advance`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  invalidResponse(`Render ${resourceKey} pagination exceeded the safety limit`);
}

export async function fetchUsage(
  apiKey: string,
  // serviceId used to be mandatory. Account-wide discovery makes it optional;
  // keep accepting the legacy config so existing provider records need no edit.
  _config?: Record<string, unknown>
): Promise<UsageResult> {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  // Do not reconcile a partial account inventory: all three independent
  // resource classes and every cursor page must finish first.
  const [serviceRows, postgresRows, keyValueRows] = await Promise.all([
    fetchAllRenderResources<RenderService>("/services", "service", headers),
    fetchAllRenderResources<RenderPostgres>("/postgres", "postgres", headers),
    fetchAllRenderResources<RenderKeyValue>("/key-value", "keyValue", headers),
  ]);

  const records: AdapterExternalBillingRecord[] = [];
  const services = serviceRows.map((service) => {
    const rawDetails: unknown = service.serviceDetails;
    if (rawDetails != null && !isRecord(rawDetails)) {
      invalidResponse(
        `Render service ${service.id ?? "unknown"} returned malformed serviceDetails`
      );
    }
    const details = rawDetails as RenderServiceDetails | undefined;
    const serviceType = service.type?.trim();
    if (!serviceType) {
      invalidResponse(`Render service ${service.id ?? "unknown"} omitted its type`);
    }
    const rawPlan = details?.plan ?? service.plan;
    // Static sites are the sole plan-less service shape in Render's public
    // schema. For every other service, missing plan data means we cannot safely
    // reconcile an authoritative paid-service inventory.
    const plan = serviceType === "static_site"
      ? typeof rawPlan === "string" && rawPlan.trim()
        ? rawPlan.trim()
        : null
      : requiredPlan("service", service.id, rawPlan);
    const disk = validateServiceDisk(service);
    const runtime = details?.runtime ?? details?.env ?? service.runtime ?? service.env ?? null;
    const instances = details?.numInstances ?? null;
    if (
      instances != null &&
      (!Number.isSafeInteger(instances) || instances < 0)
    ) {
      invalidResponse(`Render service ${service.id ?? "unknown"} has invalid numInstances`);
    }
    const status = renderStatus(service.suspended);
    const paidPlan = isPaidPlan(plan);
    if (paidPlan && service.id) {
      records.push({
        externalId: service.id,
        kind: "service_plan",
        serviceName: service.name ?? `Service ${service.id}`,
        planName: plan,
        status,
        usageQuantity: instances,
        usageUnit: instances == null ? null : "instances",
        rollupRole: "canonical",
      });
    }
    if (disk) {
      records.push({
        externalId: `${service.id ?? "service"}:disk:${disk.id}`,
        kind: "service_plan",
        serviceName: `${service.name ?? service.id ?? "Service"} disk`,
        planName: `${disk.sizeGB} GB persistent disk`,
        status,
        usageQuantity: disk.sizeGB,
        usageUnit: "GB",
        rollupRole: paidPlan ? "component" : "canonical",
      });
    }
    return {
      id: service.id ?? null,
      name: service.name ?? null,
      type: serviceType,
      plan,
      paidPlan,
      runtime,
      region: details?.region ?? null,
      status,
      instances,
      autoscaling: details?.autoscaling ?? null,
      disk: disk
        ? {
            id: disk.id,
            name: disk.name ?? null,
            sizeGB: disk.sizeGB,
            mountPath: disk.mountPath ?? null,
          }
        : null,
      buildPlan: details?.buildPlan ?? null,
      updatedAt: service.updatedAt ?? null,
    };
  });

  const postgres = postgresRows.map((database) => {
    const plan = requiredPlan("Postgres database", database.id, database.plan);
    const status = renderStatus(database.suspended, database.status);
    const paidPlan = isPaidPlan(plan);
    if (paidPlan && database.id) {
      records.push({
        externalId: database.id,
        kind: "service_plan",
        serviceName: database.name ?? `Postgres ${database.id}`,
        planName: plan,
        status,
        rollupRole: "canonical",
      });
    }
    return {
      id: database.id ?? null,
      name: database.name ?? null,
      plan,
      paidPlan,
      status,
      region: database.region ?? null,
      role: database.role ?? null,
      version: database.version ?? null,
      diskSizeGB: database.diskSizeGB ?? null,
      diskAutoscalingEnabled: database.diskAutoscalingEnabled ?? null,
      highAvailabilityEnabled: database.highAvailabilityEnabled ?? null,
      readReplicas: (database.readReplicas ?? []).map((replica) => ({
        id: replica.id ?? null,
        name: replica.name ?? null,
      })),
      updatedAt: database.updatedAt ?? null,
    };
  });

  const keyValue = keyValueRows.map((instance) => {
    const plan = requiredPlan("Key Value instance", instance.id, instance.plan);
    const paidPlan = isPaidPlan(plan);
    const status = instance.status?.trim() || "active";
    if (paidPlan && instance.id) {
      records.push({
        externalId: instance.id,
        kind: "service_plan",
        serviceName: instance.name ?? `Key Value ${instance.id}`,
        planName: plan,
        status,
        rollupRole: "canonical",
      });
    }
    return {
      id: instance.id ?? null,
      name: instance.name ?? null,
      plan,
      paidPlan,
      status,
      region: instance.region ?? null,
      version: instance.version ?? null,
      persistenceMode: instance.options?.persistenceMode ?? null,
      maxmemoryPolicy: instance.options?.maxmemoryPolicy ?? null,
      updatedAt: instance.updatedAt ?? null,
    };
  });

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      services,
      postgres,
      keyValue,
      resourceCounts: {
        services: services.length,
        postgres: postgres.length,
        keyValue: keyValue.length,
        paidRecords: records.length,
      },
      capabilities: {
        accountWideDiscovery: true,
        servicePlan: true,
        serviceStatus: true,
        disks: true,
        replicas: true,
        actualInvoiceCost: false,
        renewalDate: false,
      },
    },
    externalBilling: {
      source: "render-service-plans",
      authoritative: true,
      records,
    },
  };
}
