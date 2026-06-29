export interface UsageResult {
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
  rawData: unknown;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const today = new Date().toISOString().slice(0, 10);

  const [usageRes, billingRes] = await Promise.allSettled([
    fetch(`https://api.openai.com/v1/usage?date=${today}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    fetch("https://api.openai.com/dashboard/billing/subscription", {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  ]);

  let balance: number | null = null;
  let totalCost: number | null = null;
  let totalRequests: number | null = null;
  const rawData: Record<string, unknown> = {};

  if (billingRes.status === "fulfilled" && billingRes.value.ok) {
    const billing = await billingRes.value.json();
    rawData.billing = billing;
    // Extract balance/grant info
    if (billing.hard_limit_usd != null) {
      balance = billing.hard_limit_usd;
    } else if (billing.soft_limit_usd != null) {
      balance = billing.soft_limit_usd;
    }
  } else if (billingRes.status === "fulfilled") {
    rawData.billingError = `HTTP ${billingRes.value.status}`;
  } else {
    rawData.billingError = billingRes.reason?.message || "Failed";
  }

  if (usageRes.status === "fulfilled" && usageRes.value.ok) {
    const usage = await usageRes.value.json();
    rawData.usage = usage;

    // Sum up costs and requests from daily usage
    let totalCostCents = 0;
    let requestCount = 0;
    const data = Array.isArray(usage.data) ? usage.data : [usage];
    for (const day of data) {
      if (typeof day.cost === "number") {
        totalCostCents += day.cost;
      }
      if (typeof day.n_requests === "number") {
        requestCount += day.n_requests;
      }
    }
    totalCost = totalCostCents / 100;
    totalRequests = requestCount;
  } else if (usageRes.status === "fulfilled") {
    rawData.usageError = `HTTP ${usageRes.value.status}`;
  } else {
    rawData.usageError = usageRes.reason?.message || "Failed";
  }

  return { balance, totalCost, totalRequests, credits: null, rawData };
}
