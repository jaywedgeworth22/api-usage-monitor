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

export async function resilientFetch(
  url: string,
  init?: RequestInit,
  timeoutMs: number = 10000
): Promise<Response> {
  let attempt = 0;
  const maxAttempts = 3;
  let delay = 200; // ms

  while (true) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);

      // If we got a 429 or 5xx, we should retry if we have attempts left
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        let backoffDelay = delay;
        const retryAfter = res.headers.get("retry-after");
        if (retryAfter) {
          const parsedSeconds = parseInt(retryAfter, 10);
          if (!isNaN(parsedSeconds)) {
            backoffDelay = parsedSeconds * 1000;
          } else {
            // Check if it's a HTTP date
            const parsedDate = Date.parse(retryAfter);
            if (!isNaN(parsedDate)) {
              backoffDelay = Math.max(0, parsedDate - Date.now());
            }
          }
        }
        // Cap backoff delay to 3 seconds to avoid blocking the queue too long
        backoffDelay = Math.min(backoffDelay, 3000);

        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        delay *= 2;
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      if (attempt < maxAttempts) {
        // Retry on network errors/timeouts
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      if (isTimeout) {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }
}

export async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
  const res = await resilientFetch(url, init);
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
