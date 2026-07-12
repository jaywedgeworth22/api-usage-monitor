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
  const byService = new Map<string, {
    service: string;
    currency: string;
    billedCost: number;
    quantity: number;
    unit: string | null;
  }>();
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
    const aggregate = byService.get(key) ?? {
      service,
      currency,
      billedCost: 0,
      quantity: 0,
      unit,
    };
    aggregate.billedCost += amount ?? 0;
    aggregate.quantity += parseNumber(charge.ConsumedQuantity) ?? 0;
    byService.set(key, aggregate);
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
      externalId: `${owner}:${month}:${currency}`,
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
  if (byService.size > 0) {
    for (const aggregate of [...byService.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency) ||
      left.service.localeCompare(right.service)
    )) {
      records.push({
        externalId: `${owner}:${month}:${aggregate.currency}:${encodeURIComponent(
          `${aggregate.service}:${aggregate.unit ?? ""}`
        )}`,
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
      byService: Object.fromEntries(
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
      },
    },
    externalBilling: {
      source: "vercel-focus-billing",
      authoritative: true,
      records,
    },
  };
}
