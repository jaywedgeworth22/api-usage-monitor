import { createHash } from "node:crypto";
import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

interface FocusCharge {
  BilledCost?: string | number;
  BillingCurrency?: string;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ConsumedQuantity?: string | number | null;
  ConsumedUnit?: string | null;
  ServiceName?: string;
  ServiceCategory?: string;
  Tags?: unknown;
}

const MAX_SERVICE_COMPONENTS = 250;
const MAX_PROJECT_COMPONENTS = 250;
const MAX_PROJECT_ID_LENGTH = 256;
const MAX_PROJECT_NAME_LENGTH = 100;

interface ServiceAggregate {
  service: string;
  currency: string;
  billedCost: number;
  quantity: number;
  unit: string | null;
}

interface ProjectAggregate extends ServiceAggregate {
  projectId: string;
  projectName: string | null;
}

type ParsedProjectTag =
  | { state: "tagged"; projectId: string; projectName: string | null }
  | { state: "untagged" }
  | { state: "incomplete" };

function parseProjectTag(value: unknown, present: boolean): ParsedProjectTag {
  // FOCUS documents Tags as an object. A valid object with no ProjectId is a
  // genuine untagged charge; absent/non-object Tags or a malformed present ID
  // means the optional project-detail set is incomplete and must not prune it.
  if (!present || !value || typeof value !== "object" || Array.isArray(value)) {
    return { state: "incomplete" };
  }

  const tags = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(tags, "ProjectId")) {
    return { state: "untagged" };
  }
  const rawProjectId = tags.ProjectId;
  if (typeof rawProjectId !== "string") return { state: "incomplete" };
  const projectId = rawProjectId.trim();
  if (!projectId || projectId.length > MAX_PROJECT_ID_LENGTH) {
    return { state: "incomplete" };
  }

  const rawProjectName = tags.ProjectName;
  const projectName =
    typeof rawProjectName === "string" &&
    rawProjectName.trim().length > 0 &&
    rawProjectName.trim().length <= MAX_PROJECT_NAME_LENGTH
      ? rawProjectName.trim()
      : null;

  return { state: "tagged", projectId, projectName };
}

function projectExternalId(
  month: string,
  currency: string,
  projectId: string,
  service: string,
  unit: string | null
): string {
  const identity = `${projectId}\u0000${service}\u0000${unit ?? ""}`;
  // ProviderExternalBilling rejects external IDs longer than 255 characters.
  // Project/service/unit are provider-supplied and individually unbounded, so
  // persist only a fixed-width digest while keeping the source provider-local.
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `project:${month}:${currency}:${digest}`;
}

function serviceExternalId(
  month: string,
  currency: string,
  service: string,
  unit: string | null
): string {
  const digest = createHash("sha256")
    .update(`${service}\u0000${unit ?? ""}`, "utf8")
    .digest("hex");
  return `service:${month}:${currency}:${digest}`;
}

function parseCharges(data: unknown): FocusCharge[] {
  let charges: FocusCharge[];
  if (data == null) charges = [];
  else if (Array.isArray(data)) charges = data as FocusCharge[];
  else if (typeof data === "object" && data !== null) charges = [data as FocusCharge];
  else if (typeof data !== "string") {
    throw new AdapterError("Vercel returned an invalid FOCUS response", {
      code: "INVALID_RESPONSE",
    });
  } else {
    charges = [];
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          charges.push(parsed as FocusCharge);
        } else {
          throw new Error("FOCUS row was not an object");
        }
      } catch (error) {
        throw new AdapterError("Vercel returned invalid FOCUS JSONL", {
          code: "INVALID_RESPONSE",
          cause: error,
        });
      }
    }
  }

  for (const charge of charges) {
    if (
      parseNumber(charge.BilledCost) == null ||
      typeof charge.BillingCurrency !== "string" ||
      !charge.BillingCurrency.trim()
    ) {
      throw new AdapterError("Vercel FOCUS row omitted BilledCost or BillingCurrency", {
        code: "INVALID_RESPONSE",
      });
    }
  }
  return charges;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const teamId = (config?.teamId as string | undefined)?.trim();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const params = new URLSearchParams({
    from: monthStart.toISOString(),
    to: now.toISOString(),
  });
  if (teamId) params.set("teamId", teamId);

  const response = await fetchJson(
    `https://api.vercel.com/v1/billing/charges?${params}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { maxResponseBytes: 8 * 1024 * 1024 }
  );
  if (!response.ok) {
    return errorResult(response.status, {
      note: "Vercel FOCUS billing requires billing access on a Pro or Enterprise team",
    });
  }

  const charges = parseCharges(response.data);
  let totalCost = 0;
  let foundUsd = charges.length === 0;
  const byCurrency = new Map<string, number>();
  const byService = new Map<string, ServiceAggregate>();
  const byProject = new Map<string, ProjectAggregate>();
  let serviceComponentsSuppressed = false;
  let projectComponentsSuppressed = false;
  let projectDetailComplete = true;
  let taggedChargeCount = 0;
  for (const charge of charges) {
    const currency = charge.BillingCurrency!.trim().toUpperCase();
    const amount = parseNumber(charge.BilledCost);
    if (amount != null) {
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
    }
    if (currency === "USD" && amount != null) {
      totalCost += amount;
      foundUsd = true;
    }
    const service = charge.ServiceName ?? "unknown";
    const unit = charge.ConsumedUnit ?? null;
    const key = `${currency}\u0000${service}\u0000${unit ?? ""}`;
    if (!serviceComponentsSuppressed) {
      const aggregate = byService.get(key);
      if (!aggregate && byService.size >= MAX_SERVICE_COMPONENTS) {
        serviceComponentsSuppressed = true;
        byService.clear();
      } else {
        const next = aggregate ?? {
          service,
          currency,
          billedCost: 0,
          quantity: 0,
          unit,
        };
        next.billedCost += amount ?? 0;
        next.quantity += parseNumber(charge.ConsumedQuantity) ?? 0;
        byService.set(key, next);
      }
    }

    const project = parseProjectTag(
      charge.Tags,
      Object.prototype.hasOwnProperty.call(charge, "Tags")
    );
    if (project.state === "incomplete") {
      projectDetailComplete = false;
    } else if (project.state === "tagged") {
      taggedChargeCount += 1;
      if (!projectComponentsSuppressed) {
        const projectKey = `${currency}\u0000${project.projectId}\u0000${service}\u0000${unit ?? ""}`;
        const aggregate = byProject.get(projectKey);
        if (!aggregate && byProject.size >= MAX_PROJECT_COMPONENTS) {
          projectComponentsSuppressed = true;
          byProject.clear();
        } else {
          const next = aggregate ?? {
            service,
            currency,
            billedCost: 0,
            quantity: 0,
            unit,
            projectId: project.projectId,
            projectName: project.projectName,
          };
          next.billedCost += amount ?? 0;
          next.quantity += parseNumber(charge.ConsumedQuantity) ?? 0;
          // The stable Vercel ProjectId remains the aggregation identity. A valid name is
          // display metadata only, so a late name cannot split or rekey historical charges.
          next.projectName ??= project.projectName;
          byProject.set(projectKey, next);
        }
      }
    }
  }
  const month = monthStart.toISOString().slice(0, 7);
  const owner = teamId ?? "personal";
  const canonicalTotalCost = foundUsd ? Math.max(0, totalCost) : null;
  const records = [];
  const canonicalCurrencyTotals =
    charges.length === 0
      ? [["USD", 0] as const]
      : [...byCurrency.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [currency, amount] of canonicalCurrencyTotals) {
    records.push({
      // The reconciled source is already provider-row scoped. Avoid admitting
      // an unbounded configured owner/team ID into the 255-character external
      // identity column.
      externalId: `canonical:${month}:${currency}`,
      kind: "billing_period" as const,
      serviceName: "Vercel",
      planName: `${currency} FOCUS charges total`,
      status: "open",
      amountUsd: amount,
      currency,
      currentPeriodStart: monthStart.toISOString(),
      currentPeriodEnd: monthEnd.toISOString(),
      rollupRole: "canonical" as const,
      dateKind: "period_end" as const,
    });
  }
  if (!serviceComponentsSuppressed && byService.size > 0) {
    for (const aggregate of [...byService.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency) ||
      left.service.localeCompare(right.service)
    )) {
      records.push({
        externalId: serviceExternalId(
          month,
          aggregate.currency,
          aggregate.service,
          aggregate.unit
        ),
        kind: "billing_period" as const,
        serviceName: aggregate.service,
        planName: "Vercel metered service",
        status: "open",
        amountUsd: aggregate.billedCost,
        currency: aggregate.currency,
        currentPeriodStart: monthStart.toISOString(),
        currentPeriodEnd: monthEnd.toISOString(),
        usageQuantity: aggregate.quantity,
        usageUnit: aggregate.unit,
        rollupRole: "component" as const,
        dateKind: "period_end" as const,
      });
    }
  }
  const projectRecords = [];
  if (projectDetailComplete && !projectComponentsSuppressed && byProject.size > 0) {
    for (const aggregate of [...byProject.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency) ||
      left.projectId.localeCompare(right.projectId) ||
      left.service.localeCompare(right.service) ||
      (left.unit ?? "").localeCompare(right.unit ?? "")
    )) {
      projectRecords.push({
        externalId: projectExternalId(
          month,
          aggregate.currency,
          aggregate.projectId,
          aggregate.service,
          aggregate.unit
        ),
        kind: "billing_period" as const,
        serviceName: aggregate.projectName ?? `Vercel project ${aggregate.projectId}`,
        planName: `Vercel project · ${aggregate.service}`,
        status: "open",
        amountUsd: aggregate.billedCost,
        currency: aggregate.currency,
        currentPeriodStart: monthStart.toISOString(),
        currentPeriodEnd: monthEnd.toISOString(),
        usageQuantity: aggregate.quantity,
        usageUnit: aggregate.unit,
        rollupRole: "component" as const,
        dateKind: "period_end" as const,
      });
    }
  }

  return {
    balance: null,
    totalCost: canonicalTotalCost,
    costWindowStart: foundUsd ? monthStart : null,
    costWindowEnd: foundUsd ? now : null,
    costScope: foundUsd ? "calendar_month_to_date" : "unknown",
    costIncludesUnknownFixed: foundUsd,
    totalRequests: null,
    credits: null,
    rawData: {
      owner,
      month,
      chargeCount: charges.length,
      byService: serviceComponentsSuppressed
        ? null
        : Object.fromEntries(
            [...byService.values()].map((aggregate) => [
              `${aggregate.currency}:${aggregate.service}`,
              aggregate,
            ])
          ),
      byCurrency: Object.fromEntries([...byCurrency.entries()].sort()),
      capabilities: {
        actualBilledCost: true,
        format: "FOCUS 1.3 JSONL",
        requiredAccess: "Vercel billing read (Pro or Enterprise)",
        canonicalUsdCost: canonicalTotalCost != null || charges.length === 0,
        mixedCurrency: byCurrency.size > 1,
        serviceComponents: serviceComponentsSuppressed
          ? "suppressed_cardinality_limit"
          : "available",
        projectAttribution:
          projectComponentsSuppressed
            ? "suppressed_cardinality_limit"
            : !projectDetailComplete
              ? "incomplete"
            : taggedChargeCount > 0
              ? "available"
              : "not_returned",
      },
      projectAttribution: {
        taggedChargeCount,
        componentCount:
          projectDetailComplete && !projectComponentsSuppressed ? byProject.size : 0,
        complete: projectDetailComplete,
        suppressedByCardinalityLimit: projectComponentsSuppressed,
      },
    },
    externalBilling: {
      source: "vercel-focus-billing",
      authoritative: true,
      records,
    },
    // Project tags are optional display breakdowns. Keeping them in a distinct
    // source lets canonical cash reconcile on every successful FOCUS response
    // while incomplete tag metadata cannot prune a prior complete detail set.
    externalBillingSyncs:
      projectDetailComplete && !projectComponentsSuppressed
        ? [{
            source: "vercel-focus-project-attribution",
            authoritative: true,
            records: projectRecords,
          }]
        : undefined,
  };
}
