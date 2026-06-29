import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.stripe.com/v1/balance", {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    available?: Array<{ amount?: number; currency?: string }>;
    pending?: Array<{ amount?: number; currency?: string }>;
  };

  let availableUsd = 0;
  let pendingUsd = 0;
  let foundAvailable = false;
  let foundPending = false;

  for (const entry of data.available || []) {
    if (entry.currency === "usd" && typeof entry.amount === "number") {
      availableUsd += entry.amount;
      foundAvailable = true;
    }
  }

  for (const entry of data.pending || []) {
    if (entry.currency === "usd" && typeof entry.amount === "number") {
      pendingUsd += entry.amount;
      foundPending = true;
    }
  }

  const balance = foundAvailable ? availableUsd / 100 : null;

  return {
    balance,
    totalCost: foundPending ? pendingUsd / 100 : null,
    totalRequests: null,
    credits: null,
    rawData: data,
  };
}
