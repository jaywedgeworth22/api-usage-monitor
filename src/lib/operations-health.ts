const SOCRATIC_HEALTH_URL = "https://socratictrade.com/api/health";
const RECEIPT_INBOX_SUMMARY_URL = "https://receipt-inbox.jays.services/v1/receipts/summary";
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_RECEIPT_RESPONSE_BYTES = 128 * 1024;
const MAX_RECEIPT_ITEMS = 10;
const REQUEST_TIMEOUT_MS = 8_000;
const OPERATIONS_CACHE_TTL_MS = 30_000;

type UnknownRecord = Record<string, unknown>;

export type OperationalState =
  | "healthy"
  | "degraded"
  | "receiving"
  | "stale"
  | "unavailable"
  | "unreachable"
  | "unconfigured";

export interface ReceiptInboxItemSummary {
  id: string;
  receivedAt: string;
  senderDomain: string;
  senderAuthentication: "passed" | "failed" | "unknown";
  rawSizeBytes: number;
  attachmentCount: number;
  supportedAttachmentCount: number;
  bodyEvidence: boolean;
  quarantineReason: string;
}

export interface ReceiptInboxSummary {
  configured: boolean;
  state: OperationalState;
  needsReviewCount: number;
  countIsLowerBound: boolean;
  latestReceivedAt: string | null;
  fetchedAt: string;
  items: ReceiptInboxItemSummary[];
  error?: string;
}

export interface SocraticInfrastructureSummary {
  state: OperationalState;
  fetchedAt: string;
  releaseSha: string | null;
  database: "ok" | "degraded" | "unknown";
  schedulerAgeSeconds: number | null;
  activeTradingAccounts: number | null;
  degradedTradingAccounts: number | null;
  failedDependencies: string[];
  dbSizeBytes: number | null;
  walSizeBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  litestreamState: string | null;
  litestreamAgeSeconds: number | null;
  adminUrl: string;
  error?: string;
}

export interface OperationsHealthSummary {
  receiptInbox: ReceiptInboxSummary;
  socraticInfrastructure: SocraticInfrastructureSummary;
  fetchedAt: string;
}

let lastReceiptSuccess: ReceiptInboxSummary | undefined;
let lastSocraticSuccess: SocraticInfrastructureSummary | undefined;
let operationsCache: { expiresAt: number; value: OperationsHealthSummary } | undefined;
let operationsInFlight: Promise<OperationsHealthSummary> | undefined;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
    ? (value as number)
    : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function receiptConfiguration(): { url: string; token: string } | undefined {
  const token = process.env.RECEIPT_INBOX_READ_TOKEN?.trim();
  return token && token.length >= 32 ? { url: RECEIPT_INBOX_SUMMARY_URL, token } : undefined;
}

function parseReceiptItem(value: unknown): ReceiptInboxItemSummary | null {
  const item = asRecord(value);
  const id = typeof item?.id === "string" && /^[0-9a-f]{64}$/.test(item.id) ? item.id : null;
  const receivedAt = canonicalTimestamp(item?.receivedAt);
  const domain =
    typeof item?.senderDomain === "string" && /^[a-z0-9.-]{1,253}$/i.test(item.senderDomain)
      ? item.senderDomain.toLowerCase()
      : "unknown";
  const senderAuthentication = ["passed", "failed", "unknown"].includes(
    String(item?.senderAuthentication)
  )
    ? (item?.senderAuthentication as "passed" | "failed" | "unknown")
    : "unknown";
  const rawSizeBytes = boundedInteger(item?.rawSizeBytes, 25 * 1024 * 1024);
  const attachmentCount = boundedInteger(item?.attachmentCount, 100);
  const supportedAttachmentCount = boundedInteger(item?.supportedAttachmentCount, 100);
  if (
    !id ||
    !receivedAt ||
    rawSizeBytes === null ||
    attachmentCount === null ||
    supportedAttachmentCount === null
  ) {
    return null;
  }
  return {
    id,
    receivedAt,
    senderDomain: domain,
    senderAuthentication,
    rawSizeBytes,
    attachmentCount,
    supportedAttachmentCount,
    bodyEvidence: item?.bodyEvidence === true,
    quarantineReason:
      typeof item?.quarantineReason === "string" && item.quarantineReason.length <= 80
        ? item.quarantineReason
        : "awaiting_review",
  };
}

export async function fetchReceiptInboxSummary(): Promise<ReceiptInboxSummary> {
  const hasPartialConfiguration = Boolean(
    process.env.RECEIPT_INBOX_READ_TOKEN?.trim()
  );
  const config = receiptConfiguration();
  const fetchedAt = new Date().toISOString();
  if (!config) {
    return {
      configured: hasPartialConfiguration,
      state: hasPartialConfiguration ? "unavailable" : "unconfigured",
      needsReviewCount: 0,
      countIsLowerBound: false,
      latestReceivedAt: null,
      fetchedAt,
      items: [],
      ...(hasPartialConfiguration ? { error: "invalid_configuration" } : {}),
    };
  }
  try {
    const response = await fetch(config.url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = asRecord(await readBoundedJson(response, MAX_RECEIPT_RESPONSE_BYTES));
    if (body?.configured !== true || body.status !== "receiving" || !Array.isArray(body.items)) {
      throw new Error("invalid_response");
    }
    const items = body.items
      .map(parseReceiptItem)
      .filter((item): item is ReceiptInboxItemSummary => item !== null)
      .slice(0, MAX_RECEIPT_ITEMS);
    const needsReviewCount = boundedInteger(body.needsReviewCount, 1_000_000);
    if (needsReviewCount === null) throw new Error("invalid_response");
    const result: ReceiptInboxSummary = {
      configured: true,
      state: "receiving",
      needsReviewCount,
      countIsLowerBound: body.countIsLowerBound === true,
      latestReceivedAt: canonicalTimestamp(body.latestReceivedAt),
      fetchedAt,
      items,
    };
    lastReceiptSuccess = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unavailable";
    if (lastReceiptSuccess) {
      return { ...lastReceiptSuccess, state: "stale", error: message };
    }
    return {
      configured: true,
      state: "unavailable",
      needsReviewCount: 0,
      countIsLowerBound: false,
      latestReceivedAt: null,
      fetchedAt,
      items: [],
      error: message,
    };
  }
}

function dependencyFailures(value: unknown): string[] {
  const dependencies = asRecord(value);
  if (!dependencies) return [];
  return Object.entries(dependencies)
    .filter(([, raw]) => asRecord(raw)?.ok === false)
    .map(([name]) => name)
    .filter((name) => /^[a-z0-9._:-]{1,80}$/i.test(name))
    .slice(0, 20);
}

export async function fetchSocraticInfrastructureSummary(): Promise<SocraticInfrastructureSummary> {
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetch(SOCRATIC_HEALTH_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = asRecord(await readBoundedJson(response, MAX_HEALTH_RESPONSE_BYTES));
    const checks = asRecord(body?.checks);
    if (typeof body?.ok !== "boolean" || !checks) throw new Error("invalid_response");
    const release = asRecord(checks.release);
    const trading = asRecord(checks.tradingLiveness);
    const storage = asRecord(checks.storage);
    const failedDependencies = dependencyFailures(checks.dependencies);
    const database = checks.db === "ok" ? "ok" : checks.db ? "degraded" : "unknown";
    const litestreamState =
      typeof storage?.litestreamStatus === "string"
        ? storage.litestreamStatus
        : typeof storage?.litestreamState === "string"
          ? storage.litestreamState
          : null;
    const degraded =
      body.ok !== true ||
      database !== "ok" ||
      failedDependencies.length > 0 ||
      (litestreamState !== null && litestreamState !== "replicating" && litestreamState !== "known");
    const result: SocraticInfrastructureSummary = {
      state: degraded ? "degraded" : "healthy",
      fetchedAt,
      releaseSha:
        typeof release?.sha === "string" && /^[0-9a-f]{7,64}$/i.test(release.sha)
          ? release.sha.toLowerCase()
          : null,
      database,
      schedulerAgeSeconds: finiteNonNegative(checks.schedulerAgeSeconds),
      activeTradingAccounts: boundedInteger(trading?.activeAccounts, 10_000),
      degradedTradingAccounts: boundedInteger(trading?.degraded, 10_000),
      failedDependencies,
      dbSizeBytes: finiteNonNegative(storage?.dbSizeBytes),
      walSizeBytes: finiteNonNegative(storage?.walSizeBytes),
      freeBytes: finiteNonNegative(storage?.freeBytes),
      totalBytes: finiteNonNegative(storage?.totalBytes),
      litestreamState,
      litestreamAgeSeconds: finiteNonNegative(storage?.litestreamAgeSeconds),
      adminUrl: "https://admin.socratictrade.com/admin/server",
    };
    lastSocraticSuccess = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreachable";
    if (lastSocraticSuccess) {
      return { ...lastSocraticSuccess, state: "stale", error: message };
    }
    return {
      state: "unreachable",
      fetchedAt,
      releaseSha: null,
      database: "unknown",
      schedulerAgeSeconds: null,
      activeTradingAccounts: null,
      degradedTradingAccounts: null,
      failedDependencies: [],
      dbSizeBytes: null,
      walSizeBytes: null,
      freeBytes: null,
      totalBytes: null,
      litestreamState: null,
      litestreamAgeSeconds: null,
      adminUrl: "https://admin.socratictrade.com/admin/server",
      error: message,
    };
  }
}

export async function fetchOperationsHealth(): Promise<OperationsHealthSummary> {
  const now = Date.now();
  if (operationsCache && operationsCache.expiresAt > now) return operationsCache.value;
  if (operationsInFlight) return operationsInFlight;
  operationsInFlight = (async () => {
    const [receiptInbox, socraticInfrastructure] = await Promise.all([
      fetchReceiptInboxSummary(),
      fetchSocraticInfrastructureSummary(),
    ]);
    const value = { receiptInbox, socraticInfrastructure, fetchedAt: new Date().toISOString() };
    operationsCache = { expiresAt: Date.now() + OPERATIONS_CACHE_TTL_MS, value };
    return value;
  })();
  try {
    return await operationsInFlight;
  } finally {
    operationsInFlight = undefined;
  }
}

export function resetOperationsHealthCacheForTests(): void {
  lastReceiptSuccess = undefined;
  lastSocraticSuccess = undefined;
  operationsCache = undefined;
  operationsInFlight = undefined;
}
