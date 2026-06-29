export interface UsageResult {
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
  rawData: unknown;
}

export function emptyResult(rawData: unknown = null): UsageResult {
  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData,
  };
}

export function errorResult(
  status: number,
  extra: Record<string, unknown> = {}
): UsageResult {
  return emptyResult({ error: `HTTP ${status}`, status, ...extra });
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function centsToDollars(cents: unknown): number | null {
  const value = parseNumber(cents);
  return value == null ? null : value / 100;
}

export function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function isoDateTimeDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") || "";
  let data: unknown = null;

  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    const text = await res.text();
    data = text || null;
  }

  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

export function headerNumber(
  headers: Headers,
  names: string[]
): number | null {
  for (const name of names) {
    const value = parseNumber(headers.get(name));
    if (value != null) return value;
  }
  return null;
}

export function sumDailyCosts(
  buckets: Array<{ results?: Array<{ amount?: string | number }> }>
): number | null {
  let totalCents = 0;
  let found = false;

  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      const amount = parseNumber(result.amount);
      if (amount != null) {
        totalCents += amount;
        found = true;
      }
    }
  }

  return found ? totalCents / 100 : null;
}
