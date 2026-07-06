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

// --- fetchJson hardening -----------------------------------------------
//
// Every poll adapter (33 providers) eventually funnels through fetchJson.
// Historically it had no timeout, so a single hung upstream request could
// stall the whole 15-minute fetchAllDueProviders loop indefinitely (see
// usage-recorder.ts). This section adds a per-request timeout and bounded
// retry-on-transient-status behavior while preserving the exact
// { ok, status, data, headers } return contract every adapter relies on.

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_WAIT_MS = 15_000; // never block longer than this - the next 15-min scheduler tick is the real retry
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function resolveDefaultTimeoutMs(): number {
  const raw = process.env.ADAPTER_HTTP_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

// Strips query strings from a URL before it can end up in an Error message.
// Several adapters pass API keys as query params (e.g. google-ai.ts's
// ?key=...) - those must never leak into persisted fetch-all error arrays
// or logs.
export function redactUrlForError(url: string): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;
  return `${url.slice(0, queryIndex)}?[REDACTED]`;
}

// Parses a Retry-After header value, which per RFC 9110 is either an
// integer number of seconds or an HTTP-date. Returns milliseconds to wait,
// or null if the header is absent/unparseable.
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return dateMs - Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchJsonOptions {
  /** Per-request timeout in ms. Defaults to ADAPTER_HTTP_TIMEOUT_MS or 30s. */
  timeoutMs?: number;
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
  options?: FetchJsonOptions
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
  const timeoutMs = options?.timeoutMs ?? resolveDefaultTimeoutMs();
  // Only retry GET-like (idempotent) requests - every adapter call today is
  // a GET, but gate on method explicitly rather than assuming.
  const method = (init?.method ?? "GET").toUpperCase();
  const isRetryable = method === "GET";

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, init, timeoutMs);
    } catch (err) {
      const redactedUrl = redactUrlForError(url);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const message = isAbort
        ? `Request to ${redactedUrl} timed out after ${timeoutMs}ms`
        : `Request to ${redactedUrl} failed: ${
            err instanceof Error ? err.message : "network error"
          }`;
      throw new Error(message);
    }

    if (
      isRetryable &&
      RETRYABLE_STATUSES.has(res.status) &&
      attempt < MAX_RETRIES
    ) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      if (retryAfterMs != null) {
        if (retryAfterMs > MAX_RETRY_AFTER_WAIT_MS) {
          // Server asked us to wait longer than we're willing to block for -
          // give up now and let the next scheduler tick retry instead.
          return await toResult(res);
        }
        if (retryAfterMs > 0) {
          await sleep(retryAfterMs);
        }
      } else {
        // Exponential backoff when the server didn't tell us how long to wait.
        await sleep(2 ** attempt * 1000);
      }
      attempt++;
      continue;
    }

    return await toResult(res);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  // Compose caller-provided signal (if any) with the timeout signal so an
  // adapter can still cancel a request itself in the future.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (init?.signal) signals.push(init.signal);
  const signal =
    signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  return fetch(url, { ...init, signal });
}

async function toResult(
  res: Response
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
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
