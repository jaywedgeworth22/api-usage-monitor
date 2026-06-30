const MAX_EVENTS = 100;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_STRING_LENGTH = 500;

const metricTypes = new Set(["usage", "cost", "quota", "tier", "health"]);
const units = new Set([
  "request",
  "call",
  "token",
  "credit",
  "usd",
  "page",
  "job",
  "document",
  "row",
  "byte",
]);
const billingModes = new Set(["actual", "estimated", "manual"]);
const confidences = new Set(["actual", "estimated", "manual"]);
const limitWindows = new Set(["minute", "day", "month", "run"]);

export interface ParsedUsageTelemetryEvent {
  sourceApp: string;
  environment?: string;
  provider: string;
  service?: string;
  label?: string;
  keyRef?: string;
  billingMode: string;
  metricType: string;
  quantity?: number;
  unit?: string;
  costUsd?: number;
  requests?: number;
  credits?: number;
  limit?: number;
  limitWindow?: string;
  tier?: string;
  confidence: string;
  windowStart?: Date;
  windowEnd?: Date;
  occurredAt: Date;
  metadata?: Record<string, string | number | boolean | null>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  options: { required?: boolean; max?: number } = {}
): string | undefined {
  const raw = record[key];
  if (raw == null || raw === "") {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof raw !== "string") throw new Error(`${key} must be a string`);
  const value = raw.trim();
  if (!value) {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (options.max && value.length > options.max) {
    throw new Error(`${key} must be ${options.max} characters or fewer`);
  }
  return value;
}

function readEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  fallback: string
): string {
  const value = readString(record, key, { max: 80 });
  if (value == null) return fallback;
  if (!allowed.has(value)) throw new Error(`${key} is not supported`);
  return value;
}

function readOptionalEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: Set<string>
): string | undefined {
  const value = readString(record, key, { max: 80 });
  if (value == null) return undefined;
  if (!allowed.has(value)) throw new Error(`${key} is not supported`);
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key];
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`${key} must be a non-negative finite number`);
  }
  return raw;
}

function readInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(record, key);
  if (value == null) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function readDate(record: Record<string, unknown>, key: string): Date | undefined {
  const value = readString(record, key, { max: 80 });
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${key} must be an ISO date`);
  return date;
}

function readMetadata(
  record: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined {
  const raw = record.metadata;
  if (raw == null) return undefined;
  const metadata = asRecord(raw);
  const entries = Object.entries(metadata).slice(0, MAX_METADATA_KEYS);
  const clean: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of entries) {
    const cleanKey = key.trim().slice(0, 80);
    if (!cleanKey) continue;
    if (value == null || typeof value === "boolean") {
      clean[cleanKey] = value ?? null;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[cleanKey] = value;
    } else if (typeof value === "string") {
      clean[cleanKey] = value.slice(0, MAX_METADATA_STRING_LENGTH);
    }
  }

  return Object.keys(clean).length ? clean : undefined;
}

function parseEvent(value: unknown): ParsedUsageTelemetryEvent {
  const record = asRecord(value);
  const occurredAt = readDate(record, "occurredAt") ?? new Date();
  return {
    sourceApp: readString(record, "sourceApp", { required: true, max: 80 })!,
    environment: readString(record, "environment", { max: 80 }),
    provider: readString(record, "provider", { required: true, max: 80 })!,
    service: readString(record, "service", { max: 120 }),
    label: readString(record, "label", { max: 160 }),
    keyRef: readString(record, "keyRef", { max: 160 }),
    billingMode: readEnum(record, "billingMode", billingModes, "estimated"),
    metricType: readEnum(record, "metricType", metricTypes, "usage"),
    quantity: readNumber(record, "quantity"),
    unit: readOptionalEnum(record, "unit", units),
    costUsd: readNumber(record, "costUsd"),
    requests: readInteger(record, "requests"),
    credits: readNumber(record, "credits"),
    limit: readNumber(record, "limit"),
    limitWindow: readOptionalEnum(record, "limitWindow", limitWindows),
    tier: readString(record, "tier", { max: 80 }),
    confidence: readEnum(record, "confidence", confidences, "estimated"),
    windowStart: readDate(record, "windowStart"),
    windowEnd: readDate(record, "windowEnd"),
    occurredAt,
    metadata: readMetadata(record),
  };
}

export function parseUsageTelemetryBatch(value: unknown): ParsedUsageTelemetryEvent[] {
  const record = asRecord(value);
  const rawEvents = Array.isArray(record.events) ? record.events : [record];
  if (rawEvents.length === 0) throw new Error("events must not be empty");
  if (rawEvents.length > MAX_EVENTS) {
    throw new Error(`events must include ${MAX_EVENTS} or fewer items`);
  }
  return rawEvents.map(parseEvent);
}
