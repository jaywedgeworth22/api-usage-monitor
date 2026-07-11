import {
  configurationError,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

interface RenderService {
  id?: string;
  name?: string;
  type?: string;
  plan?: string;
  runtime?: string;
  env?: string;
  serviceDetails?: {
    plan?: string;
    runtime?: string;
    env?: string;
  };
  suspended?: string | boolean;
  updatedAt?: string;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const serviceId = (config?.serviceId as string | undefined)?.trim();
  if (!serviceId) configurationError("serviceId is required for Render plan tracking");

  const response = await fetchJson(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );
  if (!response.ok) return errorResult(response.status);

  const body = (response.data ?? {}) as RenderService & { service?: RenderService };
  const service = body.service ?? body;
  const plan = service.serviceDetails?.plan ?? service.plan ?? null;
  const runtime =
    service.serviceDetails?.runtime ??
    service.serviceDetails?.env ??
    service.runtime ??
    service.env ??
    null;
  const suspended = service.suspended;
  const status = suspended === false || suspended === "not_suspended" || suspended == null
    ? "active"
    : "suspended";

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      service: {
        id: service.id ?? serviceId,
        name: service.name ?? null,
        type: service.type ?? null,
        plan,
        runtime,
        status,
        updatedAt: service.updatedAt ?? null,
      },
      capabilities: {
        servicePlan: plan != null,
        serviceStatus: true,
        actualInvoiceCost: false,
      },
    },
    externalBilling: {
      source: "render-service-plans",
      authoritative: true,
      records: [
        {
          externalId: service.id ?? serviceId,
          kind: "service_plan",
          planName: plan,
          status,
        },
      ],
    },
  };
}
