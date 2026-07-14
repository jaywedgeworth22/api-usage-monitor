import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildProviderAlertState, type AlertSeverity, type ProviderAlert } from "@/lib/provider-alerts";
import { computeBudgetStatus } from "@/lib/budget-status";
import { providerPollSnapshotExpected } from "@/lib/anthropic-credentials";

export type AlertDeliveryChannel =
  | { kind: "slack"; url: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; apiKey: string; from: string; to: string }
  | { kind: "pagerduty"; routingKey: string };

export interface AlertDeliveryConfig {
  channels: AlertDeliveryChannel[];
  minSeverity: AlertSeverity;
  reminderHours: number;
  /** Per HTTP attempt. Defaults to 10 seconds and is hard-capped at 60 seconds. */
  timeoutMs?: number;
  /** Includes the first attempt. Defaults to 3 and is hard-capped at 5. */
  maxAttempts?: number;
  /** Exponential retry base. Defaults to 250ms; individual waits cap at 5s. */
  retryBaseMs?: number;
}

export interface AlertDeliveryResult {
  evaluatedProviders: number;
  activeAlerts: number;
  sent: number;
  resolved: number;
  skipped: number;
  errors: Array<{ providerId: string; alertCode: string; channel: string; error: string }>;
  persistenceDegraded: AlertPersistenceDegradation[];
}

export type AlertPersistenceOperation =
  | "trigger_unknown_outcome"
  | "trigger_rejected_outcome"
  | "trigger_success_outcome"
  | "resolve_failure_outcome"
  | "resolve_success_outcome";

export interface AlertPersistenceDegradation {
  stage: "channel_state";
  operation: AlertPersistenceOperation;
  code: "P1008";
  model: "ProviderAlertChannelDelivery";
  providerId: string;
  alertCode: string;
  channel: AlertDeliveryChannel["kind"];
  message: string;
}

export type AlertNotificationSummaryOperation = "post_send_notification_summary";

export class AlertNotificationSummaryPersistenceTimeout extends Error {
  readonly code = "P1008" as const;
  readonly model = "ProviderAlertNotification" as const;
  readonly operation: AlertNotificationSummaryOperation =
    "post_send_notification_summary";

  constructor(
    readonly originalError: Error,
    readonly partialResult: AlertDeliveryResult
  ) {
    super(originalError.message);
    this.name = "AlertNotificationSummaryPersistenceTimeout";
  }
}

type PrismaLike = Pick<
  PrismaClient,
  "provider" | "providerAlertNotification" | "providerAlertChannelDelivery"
>;

const DEFAULT_REMINDER_HOURS = 24;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5_000;
const TRIGGER_OUTCOME_UNKNOWN_MARKER = "delivery_outcome_unknown";
const TRIGGER_OUTCOME_UNKNOWN_MESSAGE =
  "Delivery outcome is unknown; automatic retry is deferred until the reminder interval";
const TRIGGER_CLAIM_IN_PROGRESS_MESSAGE =
  "Delivery is already claimed by another worker; duplicate send suppressed";
const TRIGGER_TRANSPORT_UNKNOWN_MESSAGE =
  "Transport ended without a definitive HTTP rejection; delivery may have been accepted and automatic retry is deferred until the reminder interval";
const TRIGGER_SUCCESS_PERSISTENCE_TIMEOUT_MESSAGE =
  "Delivery was accepted, but channel success persistence timed out; automatic retry is deferred until the reminder interval";
const PAGERDUTY_TRIGGER_IN_PROGRESS_RESOLVE_MESSAGE =
  "PagerDuty resolve is deferred until the in-flight trigger claim completes or expires";
const PAGERDUTY_RESOLVE_IN_PROGRESS_MESSAGE =
  "PagerDuty resolve is already claimed by another worker; duplicate resolve suppressed";
const PAGERDUTY_LEGACY_AUDIT_PENDING_MESSAGE =
  "PagerDuty legacy incident audit is pending because no routing key is configured";
const NOTIFICATION_OPERATION_IN_PROGRESS_MESSAGE =
  "Alert incident is already claimed by another worker; activation/resolution race suppressed";
const STALE_ALERT_EVIDENCE_MESSAGE =
  "Alert evidence is older than the durable incident watermark; stale transition suppressed";
const RESOLVE_OUTCOME_UNKNOWN_MARKER = "resolve_outcome_unknown";
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function readAlertDeliveryConfig(env: NodeJS.ProcessEnv = process.env): AlertDeliveryConfig {
  const channels: AlertDeliveryChannel[] = [];
  const slackUrl = env.ALERT_SLACK_WEBHOOK_URL?.trim();
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  const emailApiKey = env.ALERT_RESEND_API_KEY?.trim();
  const emailFrom = env.ALERT_EMAIL_FROM?.trim();
  const emailTo = env.ALERT_EMAIL_TO?.trim();
  const pagerdutyRoutingKey = env.ALERT_PAGERDUTY_ROUTING_KEY?.trim();

  if (slackUrl) channels.push({ kind: "slack", url: slackUrl });
  if (webhookUrl) channels.push({ kind: "webhook", url: webhookUrl });
  if (emailApiKey && emailFrom && emailTo) {
    channels.push({ kind: "email", apiKey: emailApiKey, from: emailFrom, to: emailTo });
  }
  if (pagerdutyRoutingKey) {
    channels.push({ kind: "pagerduty", routingKey: pagerdutyRoutingKey });
  }

  const minSeverity = normalizeSeverity(env.ALERT_MIN_SEVERITY) ?? "warning";
  const reminderHours = normalizePositiveNumber(env.ALERT_REMINDER_HOURS) ?? DEFAULT_REMINDER_HOURS;
  const timeoutMs = boundedPositiveNumber(
    env.ALERT_DELIVERY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const maxAttempts = Math.floor(
    boundedPositiveNumber(
      env.ALERT_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      MAX_ATTEMPTS
    )
  );
  const retryBaseMs = boundedNonNegativeNumber(
    env.ALERT_DELIVERY_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    MAX_RETRY_BASE_MS
  );
  return { channels, minSeverity, reminderHours, timeoutMs, maxAttempts, retryBaseMs };
}

export function hasAlertDeliveryChannels(config = readAlertDeliveryConfig()): boolean {
  return config.channels.length > 0;
}

function normalizeSeverity(value: string | undefined): AlertSeverity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "info" || normalized === "warning" || normalized === "critical") return normalized;
  return null;
}

function normalizePositiveNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function boundedPositiveNumber(
  value: string | number | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedNonNegativeNumber(
  value: string | number | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function shouldDeliverSeverity(severity: AlertSeverity, minSeverity: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

function stateKey(providerId: string, alert: ProviderAlert): string {
  return `${providerId}:${alert.code}`;
}

const SNAPSHOT_EVIDENCE_ALERT_CODES = new Set<ProviderAlert["code"]>([
  "missing_snapshot",
  "balance_low",
  "credits_low",
  "request_limit",
  "request_limit_warning",
  "stale_snapshot",
  "missing_balance_visibility",
]);
const NO_SNAPSHOT_EVIDENCE_AT = new Date(0);

type AlertEvidenceState = "active" | "clear";

interface AlertEvidence {
  configGeneration: number;
  at: Date;
  state: AlertEvidenceState;
}

interface PersistedAlertEvidence {
  evidenceConfigGeneration: number;
  evidenceWatermarkAt: Date | null;
  evidenceWatermarkState: string;
}

const EVIDENCE_STATE_RANK: Record<string, number> = {
  legacy: 0,
  active: 1,
  clear: 2,
};

function compareEvidence(
  persisted: PersistedAlertEvidence,
  candidate: AlertEvidence
): number {
  if (persisted.evidenceConfigGeneration !== candidate.configGeneration) {
    return persisted.evidenceConfigGeneration - candidate.configGeneration;
  }
  const persistedAt = persisted.evidenceWatermarkAt?.getTime() ?? -1;
  const candidateAt = candidate.at.getTime();
  if (persistedAt !== candidateAt) return persistedAt - candidateAt;
  return (
    (EVIDENCE_STATE_RANK[persisted.evidenceWatermarkState] ?? 0) -
    EVIDENCE_STATE_RANK[candidate.state]
  );
}

function evidenceAtMostConditions(
  evidence: AlertEvidence
): Prisma.ProviderAlertNotificationWhereInput[] {
  return [
    { evidenceConfigGeneration: { lt: evidence.configGeneration } },
    {
      evidenceConfigGeneration: evidence.configGeneration,
      OR: [
        { evidenceWatermarkAt: null },
        { evidenceWatermarkAt: { lt: evidence.at } },
        ...(evidence.state === "clear"
          ? [{ evidenceWatermarkAt: evidence.at }]
          : [
              {
                evidenceWatermarkAt: evidence.at,
                evidenceWatermarkState: { not: "clear" },
              },
            ]),
      ],
    },
  ];
}

function alertEvidenceAt(
  provider: {
    isActive: boolean;
    snapshots: Array<{ fetchedAt: Date }>;
  },
  alertCode: ProviderAlert["code"],
  evaluatedAt: Date
): Date {
  if (
    provider.isActive &&
    SNAPSHOT_EVIDENCE_ALERT_CODES.has(alertCode)
  ) {
    // Absence predates every real snapshot. Using evaluatedAt here would let
    // a worker that read "no snapshot" at a later wall-clock time outrank a
    // newly inserted snapshot whose provider fetchedAt is earlier.
    return provider.snapshots[0]?.fetchedAt ?? NO_SNAPSHOT_EVIDENCE_AT;
  }
  return evaluatedAt;
}

function alertEvidence(
  provider: {
    isActive: boolean;
    alertConfigGeneration: number;
    snapshots: Array<{ fetchedAt: Date }>;
  },
  alertCode: ProviderAlert["code"],
  evaluatedAt: Date,
  state: AlertEvidenceState
): AlertEvidence {
  return {
    configGeneration: provider.alertConfigGeneration,
    at: alertEvidenceAt(provider, alertCode, evaluatedAt),
    state,
  };
}

function noEarlierThan(candidate: Date, floor: Date): Date {
  return candidate >= floor ? candidate : floor;
}

function dueForChannel(
  lastSucceededAt: Date | null,
  lastSucceededIncidentGeneration: number | null,
  incidentGeneration: number,
  incidentStartedAt: Date,
  now: Date,
  reminderHours: number
): boolean {
  const belongsToIncident =
    lastSucceededIncidentGeneration === incidentGeneration ||
    (lastSucceededIncidentGeneration === null &&
      incidentGeneration === 1 &&
      lastSucceededAt !== null &&
      lastSucceededAt >= incidentStartedAt);
  if (!lastSucceededAt || !belongsToIncident) return true;
  return now.getTime() - lastSucceededAt.getTime() >= reminderHours * 60 * 60 * 1000;
}

function alertText(provider: { displayName: string; name: string }, alert: ProviderAlert): string {
  return `[${alert.severity.toUpperCase()}] ${provider.displayName || provider.name}: ${alert.message}`;
}

function channelKey(channel: AlertDeliveryChannel): string {
  const destination =
    channel.kind === "email"
      ? `${channel.from}\0${channel.to}`
      : channel.kind === "pagerduty"
        ? channel.routingKey
        : channel.url;
  const digest = createHash("sha256")
    .update(`${channel.kind}\0${destination}`)
    .digest("hex");
  return `${channel.kind}:${digest}`;
}

function pagerDutyDedupKey(
  providerId: string,
  alertCode: string,
  incidentGeneration: number,
  auditState: string
): string {
  const base = `api-usage-monitor:${providerId}:${alertCode}`;
  return auditState === "legacy_unknown"
    ? base
    : `${base}:incident-${incidentGeneration}`;
}

class ChannelHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ChannelHttpError";
  }
}

class ChannelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Alert delivery timed out after ${timeoutMs}ms`);
    this.name = "ChannelTimeoutError";
  }
}

class ChannelDeliveryFailure extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly outcome: "rejected" | "unknown"
  ) {
    super(message);
    this.name = "ChannelDeliveryFailure";
  }
}

class TriggerDeliveryClaimLostError extends Error {
  constructor() {
    super("Alert delivery claim was lost before its outcome could be persisted");
    this.name = "TriggerDeliveryClaimLostError";
  }
}

interface TriggerDeliveryClaim {
  token: string;
  generation: number;
  incidentGeneration: number;
  claimedAt: Date;
  pagerDutyDedupKey: string | null;
  operationToken: string;
  operationGeneration: number;
  configGeneration: number;
}

interface ResolveDeliveryClaim {
  token: string;
  generation: number;
  incidentGeneration: number;
  claimedAt: Date;
  pagerDutyDedupKey: string;
  operationToken: string;
  operationGeneration: number;
  configGeneration: number;
}

interface NotificationOperationClaim {
  token: string;
  generation: number;
  incidentGeneration: number;
  claimedAt: Date;
  expiresAt: Date;
  configGeneration: number;
}

function isRetryableDeliveryError(
  channel: AlertDeliveryChannel,
  error: unknown
): boolean {
  if (channel.kind === "pagerduty") {
    // PagerDuty's stable dedup key makes ambiguous retries idempotent.
    if (!(error instanceof ChannelHttpError)) return true;
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  // Slack, Resend, and generic webhooks do not provide an idempotency key.
  // A 408/5xx or transport failure may have been accepted, so never retry it.
  return (
    error instanceof ChannelHttpError &&
    (error.status === 425 || error.status === 429)
  );
}

function deliveryFailureOutcome(error: unknown): "rejected" | "unknown" {
  if (!(error instanceof ChannelHttpError)) return "unknown";
  return error.status === 408 || error.status >= 500 ? "unknown" : "rejected";
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ChannelTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut && !(error instanceof ChannelTimeoutError)) {
      throw new ChannelTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function postJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<void> {
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const { ok, status } = response;
  try {
    await response.body?.cancel();
  } catch {
    // Delivery outcome is determined by HTTP status; body cleanup is best-effort.
  }
  if (!ok) throw new ChannelHttpError(`${label} HTTP ${status}`, status);
}

async function sendToChannelOnce(
  channel: AlertDeliveryChannel,
  provider: { id: string; name: string; displayName: string },
  alert: ProviderAlert,
  now: Date,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  action: "trigger" | "resolve",
  exactPagerDutyDedupKey: string | null
): Promise<void> {
  if (action === "resolve" && channel.kind !== "pagerduty") return;

  if (channel.kind === "slack") {
    await postJson(
      "Slack webhook",
      channel.url,
      { "content-type": "application/json" },
      { text: alertText(provider, alert) },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  if (channel.kind === "email") {
    await postJson(
      "Resend API",
      "https://api.resend.com/emails",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channel.apiKey}`,
      },
      {
        from: channel.from,
        to: channel.to,
        subject: `[${alert.severity.toUpperCase()}] Alert for ${provider.displayName || provider.name}`,
        html: `
          <h2>API Usage Monitor Alert</h2>
          <p><strong>Provider:</strong> ${provider.displayName || provider.name}</p>
          <p><strong>Severity:</strong> ${alert.severity}</p>
          <p><strong>Message:</strong> ${alert.message}</p>
          <p><strong>Detected At:</strong> ${now.toISOString()}</p>
        `,
      },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  if (channel.kind === "pagerduty") {
    const pdSeverity = alert.severity === "critical" ? "critical" : "warning";
    if (!exactPagerDutyDedupKey) {
      throw new Error("PagerDuty delivery requires an incident-scoped dedup key");
    }
    await postJson(
      "PagerDuty API",
      "https://events.pagerduty.com/v2/enqueue",
      { "Content-Type": "application/json" },
      action === "resolve"
        ? {
            routing_key: channel.routingKey,
            event_action: "resolve",
            dedup_key: exactPagerDutyDedupKey,
          }
        : {
            routing_key: channel.routingKey,
            event_action: "trigger",
            dedup_key: exactPagerDutyDedupKey,
            payload: {
              summary: alertText(provider, alert),
              source: "API Usage Monitor",
              severity: pdSeverity,
              component: provider.name,
              custom_details: {
                provider_id: provider.id,
                alert_code: alert.code,
                detected_at: now.toISOString(),
              },
            },
          },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  await postJson(
    "Alert webhook",
    channel.url,
    { "content-type": "application/json" },
    {
      type: "provider_alert",
      detectedAt: now.toISOString(),
      provider: {
        id: provider.id,
        name: provider.name,
        displayName: provider.displayName,
      },
      alert,
    },
    fetchImpl,
    timeoutMs
  );
}

async function sendToChannel(
  channel: AlertDeliveryChannel,
  provider: { id: string; name: string; displayName: string },
  alert: ProviderAlert,
  now: Date,
  fetchImpl: typeof fetch,
  settings: { timeoutMs: number; maxAttempts: number; retryBaseMs: number },
  sleepImpl: (ms: number) => Promise<void>,
  action: "trigger" | "resolve" = "trigger",
  exactPagerDutyDedupKey: string | null = null
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      await sendToChannelOnce(
        channel,
        provider,
        alert,
        now,
        fetchImpl,
        settings.timeoutMs,
        action,
        exactPagerDutyDedupKey
      );
      return attempt;
    } catch (error) {
      lastError = error;
      if (
        attempt >= settings.maxAttempts ||
        !isRetryableDeliveryError(channel, error)
      ) {
        const message = error instanceof Error ? error.message : "Alert delivery failed";
        throw new ChannelDeliveryFailure(
          message,
          attempt,
          deliveryFailureOutcome(error)
        );
      }
      const delayMs = Math.min(
        settings.retryBaseMs * 2 ** (attempt - 1),
        MAX_RETRY_DELAY_MS
      );
      if (delayMs > 0) await sleepImpl(delayMs);
    }
  }
  const message = lastError instanceof Error ? lastError.message : "Alert delivery failed";
  throw new ChannelDeliveryFailure(
    message,
    settings.maxAttempts,
    deliveryFailureOutcome(lastError)
  );
}

function failureDetails(error: unknown): {
  attempts: number;
  message: string;
  outcome: "rejected" | "unknown";
} {
  const attempts = error instanceof ChannelDeliveryFailure ? error.attempts : 1;
  const message = error instanceof Error ? error.message : "Alert delivery failed";
  const outcome = error instanceof ChannelDeliveryFailure ? error.outcome : "unknown";
  return { attempts, message: message.slice(0, 500), outcome };
}

function isPrismaModelTimeout(
  error: unknown,
  modelName: "ProviderAlertNotification" | "ProviderAlertChannelDelivery"
): error is Error & { code: "P1008"; meta: { modelName: typeof modelName } } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; meta?: unknown };
  if (candidate.code !== "P1008" || typeof candidate.meta !== "object" || !candidate.meta) {
    return false;
  }
  return (
    "modelName" in candidate.meta &&
    candidate.meta.modelName === modelName
  );
}

function isPrismaUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function triggerClaimLeaseMs(settings: {
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
}): number {
  let retryDelayMs = 0;
  for (let attempt = 1; attempt < settings.maxAttempts; attempt += 1) {
    retryDelayMs += Math.min(
      settings.retryBaseMs * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS
    );
  }
  return settings.timeoutMs * settings.maxAttempts + retryDelayMs + 30_000;
}

function noteChannelPersistenceDegradation(
  result: AlertDeliveryResult,
  context: {
    providerId: string;
    alertCode: string;
    channel: AlertDeliveryChannel["kind"];
  },
  operation: AlertPersistenceOperation,
  error: Error
): void {
  result.persistenceDegraded.push({
    stage: "channel_state",
    operation,
    code: "P1008",
    model: "ProviderAlertChannelDelivery",
    ...context,
    message: error.message,
  });
}

async function claimNotificationOperation(
  db: PrismaLike,
  notification: {
    id: string;
    incidentGeneration: number;
    operationClaimGeneration: number;
  },
  evidence: AlertEvidence,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<NotificationOperationClaim | null> {
  const claimedAt = clock();
  const token = randomUUID();
  const expiresAt = new Date(claimedAt.getTime() + claimLeaseDurationMs);
  const claimed = await db.providerAlertNotification.updateMany({
    where: {
      id: notification.id,
      incidentGeneration: notification.incidentGeneration,
      resolvedAt: null,
      operationClaimGeneration: notification.operationClaimGeneration,
      provider: {
        is: { alertConfigGeneration: evidence.configGeneration },
      },
      AND: [
        { OR: evidenceAtMostConditions(evidence) },
        {
          OR: [
            { operationClaimToken: null },
            { operationClaimExpiresAt: { lte: claimedAt } },
            {
              operationClaimIncidentGeneration: {
                not: notification.incidentGeneration,
              },
            },
          ],
        },
      ],
    },
    data: {
      operationClaimToken: token,
      operationClaimGeneration: { increment: 1 },
      operationClaimExpiresAt: expiresAt,
      operationClaimIncidentGeneration: notification.incidentGeneration,
      operationClaimConfigGeneration: evidence.configGeneration,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.providerAlertNotification.findUnique({
    where: { id: notification.id },
    select: {
      resolvedAt: true,
      incidentGeneration: true,
      operationClaimToken: true,
      operationClaimGeneration: true,
      operationClaimIncidentGeneration: true,
      operationClaimConfigGeneration: true,
      provider: { select: { alertConfigGeneration: true } },
    },
  });
  if (
    !row ||
    row.resolvedAt !== null ||
    row.incidentGeneration !== notification.incidentGeneration ||
    row.operationClaimToken !== token ||
    row.operationClaimIncidentGeneration !== notification.incidentGeneration ||
    row.operationClaimConfigGeneration !== evidence.configGeneration ||
    row.provider.alertConfigGeneration !== evidence.configGeneration
  ) {
    throw new TriggerDeliveryClaimLostError();
  }
  return {
    token,
    generation: row.operationClaimGeneration,
    incidentGeneration: notification.incidentGeneration,
    claimedAt,
    expiresAt,
    configGeneration: evidence.configGeneration,
  };
}

async function releaseNotificationOperation(
  db: PrismaLike,
  notificationId: string,
  claim: NotificationOperationClaim
): Promise<void> {
  const released = await db.providerAlertNotification.updateMany({
    where: {
      id: notificationId,
      incidentGeneration: claim.incidentGeneration,
      operationClaimToken: claim.token,
      operationClaimGeneration: claim.generation,
      operationClaimIncidentGeneration: claim.incidentGeneration,
      operationClaimConfigGeneration: claim.configGeneration,
    },
    data: {
      operationClaimToken: null,
      operationClaimExpiresAt: null,
      operationClaimConfigGeneration: null,
    },
  });
  if (released.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function claimTriggerDelivery(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  incidentGeneration: number,
  expectedClaimGeneration: number,
  exactPagerDutyDedupKey: string | null,
  operationClaim: NotificationOperationClaim,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<TriggerDeliveryClaim | null> {
  const key = channelKey(channel);
  await db.providerAlertChannelDelivery.upsert({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    create: {
      notificationId,
      channelKey: key,
      channelKind: channel.kind,
    },
    update: {
      channelKind: channel.kind,
    },
  });

  // Compute the lease from the instant immediately before the atomic claim,
  // not from function entry. A slow upsert/lock wait must not consume it.
  const claimedAt = clock();
  const claimExpiresAt = new Date(claimedAt.getTime() + claimLeaseDurationMs);
  const claimToken = randomUUID();
  const claimed = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      triggerClaimGeneration: expectedClaimGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration,
          operationClaimToken: operationClaim.token,
          operationClaimGeneration: operationClaim.generation,
          operationClaimIncidentGeneration: incidentGeneration,
          operationClaimConfigGeneration: operationClaim.configGeneration,
          operationClaimExpiresAt: { gt: claimedAt },
          provider: {
            is: {
              alertConfigGeneration: operationClaim.configGeneration,
            },
          },
        },
      },
      AND: [
        {
          OR: [
            { triggerClaimToken: null },
            { triggerClaimExpiresAt: { lte: claimedAt } },
            { triggerIncidentGeneration: { not: incidentGeneration } },
          ],
        },
        {
          OR: [
            { resolveClaimToken: null },
            { resolveClaimExpiresAt: { lte: claimedAt } },
            { resolveIncidentGeneration: { not: incidentGeneration } },
          ],
        },
      ],
    },
    data: {
      triggerClaimToken: claimToken,
      triggerClaimGeneration: { increment: 1 },
      triggerClaimExpiresAt: claimExpiresAt,
      triggerIncidentGeneration: incidentGeneration,
      pagerDutyDedupKey: exactPagerDutyDedupKey,
      resolveClaimToken: null,
      resolveClaimGeneration: { increment: 1 },
      resolveClaimExpiresAt: null,
      lastAttemptAt: claimedAt,
      lastError: TRIGGER_OUTCOME_UNKNOWN_MARKER,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.providerAlertChannelDelivery.findUnique({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    select: {
      triggerClaimToken: true,
      triggerClaimGeneration: true,
      triggerIncidentGeneration: true,
      pagerDutyDedupKey: true,
    },
  });
  if (
    !row ||
    row.triggerClaimToken !== claimToken ||
    row.triggerIncidentGeneration !== incidentGeneration
  ) {
    throw new TriggerDeliveryClaimLostError();
  }
  return {
    token: claimToken,
    generation: row.triggerClaimGeneration,
    incidentGeneration,
    claimedAt,
    pagerDutyDedupKey: row.pagerDutyDedupKey,
    operationToken: operationClaim.token,
    operationGeneration: operationClaim.generation,
    configGeneration: operationClaim.configGeneration,
  };
}

async function recordTriggerOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  claim: TriggerDeliveryClaim,
  now: Date,
  attempts: number,
  error: string | null
): Promise<void> {
  const key = channelKey(channel);
  const persistedAt = noEarlierThan(now, claim.claimedAt);
  const persisted = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      triggerClaimToken: claim.token,
      triggerClaimGeneration: claim.generation,
      triggerIncidentGeneration: claim.incidentGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration: claim.incidentGeneration,
          operationClaimToken: claim.operationToken,
          operationClaimGeneration: claim.operationGeneration,
          operationClaimIncidentGeneration: claim.incidentGeneration,
          operationClaimConfigGeneration: claim.configGeneration,
          operationClaimExpiresAt: { gt: persistedAt },
          provider: {
            is: { alertConfigGeneration: claim.configGeneration },
          },
        },
      },
    },
    data: {
      channelKind: channel.kind,
      lastAttemptAt: persistedAt,
      triggerClaimToken: null,
      triggerClaimExpiresAt: null,
      attemptCount: { increment: attempts },
      ...(error
        ? { lastError: error }
        : {
            lastSucceededAt: persistedAt,
            lastSucceededIncidentGeneration: claim.incidentGeneration,
            successCount: { increment: 1 },
            lastResolveError: null,
            lastError: null,
          }),
    },
  });
  if (persisted.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function recordTriggerUnknownOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  claim: TriggerDeliveryClaim,
  now: Date,
  attempts: number
): Promise<void> {
  const persistedAt = noEarlierThan(now, claim.claimedAt);
  const persisted = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: channelKey(channel),
      triggerClaimToken: claim.token,
      triggerClaimGeneration: claim.generation,
      triggerIncidentGeneration: claim.incidentGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration: claim.incidentGeneration,
          operationClaimToken: claim.operationToken,
          operationClaimGeneration: claim.operationGeneration,
          operationClaimIncidentGeneration: claim.incidentGeneration,
          operationClaimConfigGeneration: claim.configGeneration,
          operationClaimExpiresAt: { gt: persistedAt },
          provider: {
            is: { alertConfigGeneration: claim.configGeneration },
          },
        },
      },
    },
    data: {
      channelKind: channel.kind,
      lastAttemptAt: persistedAt,
      triggerClaimToken: null,
      triggerClaimExpiresAt: null,
      attemptCount: { increment: attempts },
      lastError: TRIGGER_OUTCOME_UNKNOWN_MARKER,
    },
  });
  if (persisted.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function claimResolveDelivery(
  db: PrismaLike,
  notificationId: string,
  channel: Extract<AlertDeliveryChannel, { kind: "pagerduty" }>,
  incidentGeneration: number,
  expectedClaimGeneration: number,
  exactPagerDutyDedupKey: string,
  operationClaim: NotificationOperationClaim,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<ResolveDeliveryClaim | null> {
  const key = channelKey(channel);
  await db.providerAlertChannelDelivery.upsert({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    create: {
      notificationId,
      channelKey: key,
      channelKind: channel.kind,
    },
    update: { channelKind: channel.kind },
  });

  const claimedAt = clock();
  const claimToken = randomUUID();
  const claimed = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      resolveClaimGeneration: expectedClaimGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration,
          operationClaimToken: operationClaim.token,
          operationClaimGeneration: operationClaim.generation,
          operationClaimIncidentGeneration: incidentGeneration,
          operationClaimConfigGeneration: operationClaim.configGeneration,
          operationClaimExpiresAt: { gt: claimedAt },
          provider: {
            is: {
              alertConfigGeneration: operationClaim.configGeneration,
            },
          },
        },
      },
      AND: [
        {
          OR: [
            { resolveClaimToken: null },
            { resolveClaimExpiresAt: { lte: claimedAt } },
            { resolveIncidentGeneration: { not: incidentGeneration } },
          ],
        },
        {
          OR: [
            { triggerClaimToken: null },
            { triggerClaimExpiresAt: { lte: claimedAt } },
            { triggerIncidentGeneration: { not: incidentGeneration } },
          ],
        },
      ],
    },
    data: {
      resolveClaimToken: claimToken,
      resolveClaimGeneration: { increment: 1 },
      resolveClaimExpiresAt: new Date(claimedAt.getTime() + claimLeaseDurationMs),
      resolveIncidentGeneration: incidentGeneration,
      lastResolveAttemptAt: claimedAt,
      lastResolveError: RESOLVE_OUTCOME_UNKNOWN_MARKER,
      pagerDutyDedupKey: exactPagerDutyDedupKey,
      triggerClaimToken: null,
      triggerClaimGeneration: { increment: 1 },
      triggerClaimExpiresAt: null,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.providerAlertChannelDelivery.findUnique({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    select: {
      resolveClaimToken: true,
      resolveClaimGeneration: true,
      resolveIncidentGeneration: true,
      pagerDutyDedupKey: true,
    },
  });
  if (
    !row ||
    row.resolveClaimToken !== claimToken ||
    row.resolveIncidentGeneration !== incidentGeneration ||
    row.pagerDutyDedupKey !== exactPagerDutyDedupKey
  ) {
    throw new TriggerDeliveryClaimLostError();
  }
  return {
    token: claimToken,
    generation: row.resolveClaimGeneration,
    incidentGeneration,
    claimedAt,
    pagerDutyDedupKey: exactPagerDutyDedupKey,
    operationToken: operationClaim.token,
    operationGeneration: operationClaim.generation,
    configGeneration: operationClaim.configGeneration,
  };
}

async function recordResolveOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: Extract<AlertDeliveryChannel, { kind: "pagerduty" }>,
  claim: ResolveDeliveryClaim,
  now: Date,
  attempts: number,
  error: string | null
): Promise<void> {
  const key = channelKey(channel);
  const persistedAt = noEarlierThan(now, claim.claimedAt);
  const persisted = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      resolveClaimToken: claim.token,
      resolveClaimGeneration: claim.generation,
      resolveIncidentGeneration: claim.incidentGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration: claim.incidentGeneration,
          operationClaimToken: claim.operationToken,
          operationClaimGeneration: claim.operationGeneration,
          operationClaimIncidentGeneration: claim.incidentGeneration,
          operationClaimConfigGeneration: claim.configGeneration,
          operationClaimExpiresAt: { gt: persistedAt },
          provider: {
            is: { alertConfigGeneration: claim.configGeneration },
          },
        },
      },
    },
    data: {
      channelKind: channel.kind,
      lastResolveAttemptAt: persistedAt,
      resolveClaimToken: null,
      resolveClaimExpiresAt: null,
      resolveAttemptCount: { increment: attempts },
      ...(error
        ? { lastResolveError: error }
        : {
            lastResolvedAt: persistedAt,
            lastResolvedIncidentGeneration: claim.incidentGeneration,
            lastResolveError: null,
            lastError: null,
          }),
    },
  });
  if (persisted.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function activateProviderAlertNotification(
  db: PrismaLike,
  provider: {
    id: string;
    name: string;
    displayName: string;
    alertConfigGeneration: number;
  },
  alert: ProviderAlert,
  now: Date,
  evidence: AlertEvidence
) {
  const key = stateKey(provider.id, alert);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await db.providerAlertNotification.findUnique({
      where: { stateKey: key },
      select: {
        id: true,
        resolvedAt: true,
        incidentGeneration: true,
        lastDetectedAt: true,
        evidenceConfigGeneration: true,
        evidenceWatermarkAt: true,
        evidenceWatermarkState: true,
      },
    });

    if (
      existing &&
      (compareEvidence(existing, evidence) > 0 ||
        (compareEvidence(existing, evidence) === 0 &&
          existing.resolvedAt === null &&
          existing.lastDetectedAt > now))
    ) {
      return null;
    }
    const detectedAt = existing
      ? noEarlierThan(now, existing.lastDetectedAt)
      : now;

    if (!existing) {
      // A plain create plus unique-race retry avoids an unconditional upsert
      // update that could let stale evidence overwrite a newer first creator.
      try {
        const currentProvider = await db.provider.findUnique({
          where: { id: provider.id },
          select: { alertConfigGeneration: true },
        });
        if (
          currentProvider?.alertConfigGeneration !== evidence.configGeneration
        ) {
          return null;
        }
        const created = await db.providerAlertNotification.create({
          data: {
            providerId: provider.id,
            stateKey: key,
            alertCode: alert.code,
            severity: alert.severity,
            providerName: provider.name,
            providerDisplayName: provider.displayName,
            message: alert.message,
            firstDetectedAt: now,
            lastDetectedAt: now,
            incidentGeneration: 1,
            evidenceConfigGeneration: evidence.configGeneration,
            evidenceWatermarkAt: evidence.at,
            evidenceWatermarkState: "active",
            pagerDutyAuditState: "generation_scoped",
          },
        });
        const stillCurrent = await db.provider.findUnique({
          where: { id: provider.id },
          select: { alertConfigGeneration: true },
        });
        return stillCurrent?.alertConfigGeneration === evidence.configGeneration
          ? created
          : null;
      } catch (error) {
        if (isPrismaUniqueConstraint(error)) continue;
        throw error;
      }
    }

    if (existing.resolvedAt) {
      // Only one worker may advance a resolved row into the next incident. A
      // contender that observed the same resolved generation loses this CAS and
      // then reads the winner's open generation without resetting firstDetected.
      const reopened = await db.providerAlertNotification.updateMany({
        where: {
          id: existing.id,
          incidentGeneration: existing.incidentGeneration,
          resolvedAt: existing.resolvedAt,
          provider: {
            is: { alertConfigGeneration: evidence.configGeneration },
          },
          AND: [
            { OR: evidenceAtMostConditions(evidence) },
          ],
        },
        data: {
          severity: alert.severity,
          providerName: provider.name,
          providerDisplayName: provider.displayName,
          message: alert.message,
          firstDetectedAt: now,
          lastDetectedAt: detectedAt,
          resolvedAt: null,
          incidentGeneration: { increment: 1 },
          evidenceConfigGeneration: evidence.configGeneration,
          evidenceWatermarkAt: evidence.at,
          evidenceWatermarkState: "active",
          pagerDutyAuditState: "generation_scoped",
          operationClaimToken: null,
          operationClaimExpiresAt: null,
          operationClaimConfigGeneration: null,
        },
      });
      if (reopened.count === 0) continue;
    } else {
      // An open row can be closed by a resolver after this read. Refresh only
      // the exact still-open generation; if the resolver wins, loop and reopen
      // it as the next incident instead of triggering the resolved generation.
      const refreshed = await db.providerAlertNotification.updateMany({
        where: {
          id: existing.id,
          incidentGeneration: existing.incidentGeneration,
          resolvedAt: null,
          provider: {
            is: { alertConfigGeneration: evidence.configGeneration },
          },
          AND: [
            { OR: evidenceAtMostConditions(evidence) },
          ],
        },
        data: {
          severity: alert.severity,
          providerName: provider.name,
          providerDisplayName: provider.displayName,
          message: alert.message,
          lastDetectedAt: detectedAt,
          evidenceConfigGeneration: evidence.configGeneration,
          evidenceWatermarkAt: evidence.at,
          evidenceWatermarkState: "active",
        },
      });
      if (refreshed.count === 0) continue;
    }

    const activated = await db.providerAlertNotification.findUniqueOrThrow({
      where: { id: existing.id },
      include: {
        provider: { select: { alertConfigGeneration: true } },
      },
    });
    if (
      activated.resolvedAt === null &&
      activated.provider.alertConfigGeneration === evidence.configGeneration &&
      compareEvidence(activated, evidence) === 0
    ) {
      return activated;
    }
    if (activated.provider.alertConfigGeneration !== evidence.configGeneration) {
      return null;
    }
  }
  throw new Error(`Alert incident ${key} changed too often to activate safely`);
}

function generationMatches(
  persistedGeneration: number | null,
  incidentGeneration: number
): boolean {
  return (
    persistedGeneration === incidentGeneration ||
    (persistedGeneration === null && incidentGeneration === 1)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverProviderAlerts(options: {
  now?: Date;
  config?: AlertDeliveryConfig;
  db?: PrismaLike;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  clock?: () => Date;
} = {}): Promise<AlertDeliveryResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readAlertDeliveryConfig();
  const db = options.db ?? prisma;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const clock =
    options.clock ??
    (options.now ? () => new Date(options.now!.getTime()) : () => new Date());
  const settings = {
    timeoutMs: boundedPositiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxAttempts: Math.max(
      1,
      Math.floor(boundedPositiveNumber(config.maxAttempts, DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS))
    ),
    retryBaseMs: boundedNonNegativeNumber(
      config.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
      MAX_RETRY_BASE_MS
    ),
  };
  const claimLeaseDurationMs = triggerClaimLeaseMs(settings);
  // The env reader emits one destination of each kind, but injected test/config
  // objects may repeat a destination. De-duplicate by the same persistent key so
  // one maintenance pass never sends it twice.
  const channels = [...new Map(config.channels.map((channel) => [channelKey(channel), channel])).values()];
  const pagerDutyChannels = channels.filter(
    (channel): channel is Extract<AlertDeliveryChannel, { kind: "pagerduty" }> =>
      channel.kind === "pagerduty"
  );
  const operationClaimLeaseDurationMs =
    claimLeaseDurationMs * Math.max(1, channels.length) + 30_000;
  const result: AlertDeliveryResult = {
    evaluatedProviders: 0,
    activeAlerts: 0,
    sent: 0,
    resolved: 0,
    skipped: 0,
    errors: [],
    persistenceDegraded: [],
  };
  let deferredSummaryTimeout: Error | null = null;

  const providers = await db.provider.findMany({
    where: {
      OR: [
        { isActive: true },
        { alertNotifications: { some: { resolvedAt: null } } },
      ],
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      displayName: true,
      apiKey: true,
      config: true,
      secretConfig: true,
      isActive: true,
      alertConfigGeneration: true,
      refreshIntervalMin: true,
      plan: {
        select: {
          billingMode: true,
          fixedMonthlyCostUsd: true,
          monthlyBudgetUsd: true,
          monthlyRequestLimit: true,
          lowBalanceUsd: true,
          lowCredits: true,
          renewalDate: true,
          billingInterval: true,
          mustKeepFunded: true,
        },
      },
      snapshots: {
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: { balance: true, totalCost: true, totalRequests: true, credits: true, fetchedAt: true },
      },
    },
  });
  // Production delivery uses the same canonical poll+pushed+subscription
  // computation as /api/budget-status. Tests/callers that inject a partial DB
  // retain the legacy snapshot-only path because that DB may not expose the
  // external-event tables required by computeBudgetStatus.
  const canonicalByProviderId = options.db
    ? new Map<string, Awaited<ReturnType<typeof computeBudgetStatus>>["providers"][number]>()
    : new Map(
        (await computeBudgetStatus(now)).providers.map((status) => [status.id, status])
      );

  result.evaluatedProviders = providers.length;

  for (const provider of providers) {
    const alertState = buildProviderAlertState(
      {
        isActive: provider.isActive,
        refreshIntervalMin: provider.refreshIntervalMin,
        snapshotExpected: providerPollSnapshotExpected(provider),
        plan: provider.plan,
        latestSnapshot: provider.snapshots[0] ?? null,
      },
      now
    );
    const canonical = canonicalByProviderId.get(provider.id);
    if (canonical && provider.isActive) {
      const nonBudgetAlerts = alertState.alerts.filter(
        (alert) => alert.code !== "budget_exceeded" && alert.code !== "budget_warning"
      );
      alertState.alerts = [...nonBudgetAlerts, ...canonical.alerts];
    }
    const deliverableAlerts = alertState.alerts.filter((alert) =>
      shouldDeliverSeverity(alert.severity, config.minSeverity)
    );
    result.activeAlerts += deliverableAlerts.length;

    const activeKeys = new Set(deliverableAlerts.map((alert) => stateKey(provider.id, alert)));
    const openNotifications = await db.providerAlertNotification.findMany({
      where: { providerId: provider.id, resolvedAt: null },
      select: {
        id: true,
        stateKey: true,
        alertCode: true,
        severity: true,
        message: true,
        firstDetectedAt: true,
        lastDetectedAt: true,
        incidentGeneration: true,
        pagerDutyAuditState: true,
        operationClaimGeneration: true,
        evidenceConfigGeneration: true,
        evidenceWatermarkAt: true,
        evidenceWatermarkState: true,
      },
    });
    for (const notification of openNotifications) {
      if (activeKeys.has(notification.stateKey)) continue;

      const resolutionEvidence = alertEvidence(
        provider,
        notification.alertCode as ProviderAlert["code"],
        now,
        "clear"
      );

      const operationClaim = await claimNotificationOperation(
        db,
        notification,
        resolutionEvidence,
        operationClaimLeaseDurationMs,
        clock
      );
      if (!operationClaim) {
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "incident",
          error:
            compareEvidence(notification, resolutionEvidence) > 0
              ? STALE_ALERT_EVIDENCE_MESSAGE
              : NOTIFICATION_OPERATION_IN_PROGRESS_MESSAGE,
        });
        continue;
      }
      let operationClosed = false;
      try {

      const pagerDutyStates = await db.providerAlertChannelDelivery.findMany({
        where: {
          notificationId: notification.id,
          channelKind: "pagerduty",
        },
        select: {
          channelKey: true,
          lastAttemptAt: true,
          lastSucceededAt: true,
          lastSucceededIncidentGeneration: true,
          lastResolvedAt: true,
          lastResolvedIncidentGeneration: true,
          lastError: true,
          triggerClaimToken: true,
          triggerClaimExpiresAt: true,
          triggerIncidentGeneration: true,
          resolveClaimToken: true,
          resolveClaimGeneration: true,
          resolveClaimExpiresAt: true,
          resolveIncidentGeneration: true,
          pagerDutyDedupKey: true,
        },
      });
      const legacyAuditPending =
        notification.pagerDutyAuditState === "legacy_unknown";
      const resolvedForIncident = (state: (typeof pagerDutyStates)[number]) =>
        generationMatches(
          state.lastResolvedIncidentGeneration,
          notification.incidentGeneration
        ) &&
        state.lastResolvedAt !== null &&
        state.lastResolvedAt >= notification.firstDetectedAt;
      const relevantTriggerStates = pagerDutyStates.filter(
        (state) =>
          !resolvedForIncident(state) &&
          (legacyAuditPending ||
            ((generationMatches(
              state.triggerIncidentGeneration,
              notification.incidentGeneration
            ) ||
              generationMatches(
                state.lastSucceededIncidentGeneration,
                notification.incidentGeneration
              )) &&
              ((state.lastSucceededAt !== null &&
                state.lastSucceededAt >= notification.firstDetectedAt) ||
                state.lastError === TRIGGER_OUTCOME_UNKNOWN_MARKER ||
                state.triggerClaimToken !== null)))
      );
      const pagerDutyTriggerInProgress = relevantTriggerStates.some(
        (state) =>
          state.triggerClaimToken !== null &&
          state.triggerClaimExpiresAt !== null &&
          state.triggerClaimExpiresAt > now &&
          generationMatches(
            state.triggerIncidentGeneration,
            notification.incidentGeneration
          )
      );
      if (pagerDutyTriggerInProgress) {
        // Never allow an older resolve to overtake an accepted trigger whose
        // outcome has not yet crossed the durable boundary.
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "pagerduty",
          error: PAGERDUTY_TRIGGER_IN_PROGRESS_RESOLVE_MESSAGE,
        });
        continue;
      }

      const configuredPagerDutyKeys = new Set(
        pagerDutyChannels.map((channel) => channelKey(channel))
      );
      const originalPagerDutyDestinationMissing = relevantTriggerStates.some(
        (state) => !configuredPagerDutyKeys.has(state.channelKey)
      );
      if (originalPagerDutyDestinationMissing) {
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "pagerduty",
          error:
            "PagerDuty resolve pending because the original routing key is not configured",
        });
        continue;
      }
      if (legacyAuditPending && pagerDutyChannels.length === 0) {
        // Pre-generation rows could have crossed PagerDuty's boundary before a
        // channel-state write failed. Keep the local incident open until an
        // operator supplies a routing key for one idempotent legacy-key audit.
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "pagerduty",
          error: PAGERDUTY_LEGACY_AUDIT_PENDING_MESSAGE,
        });
        continue;
      }

      const channelsToResolve = pagerDutyChannels.filter((channel) => {
        if (legacyAuditPending) return true;
        const state = pagerDutyStates.find(
          (entry) => entry.channelKey === channelKey(channel)
        );
        return Boolean(state && relevantTriggerStates.includes(state));
      });
      const resolvedAlert: ProviderAlert = {
        code: notification.alertCode as ProviderAlert["code"],
        severity: normalizeSeverity(notification.severity) ?? "warning",
        message: notification.message,
      };
      let allPagerDutyResolvesSent = true;
      for (const channel of channelsToResolve) {
        const key = channelKey(channel);
        const state = pagerDutyStates.find((entry) => entry.channelKey === key);
        if (state && resolvedForIncident(state)) continue;
        if (
          state?.resolveClaimToken &&
          state.resolveClaimExpiresAt &&
          state.resolveClaimExpiresAt > now &&
          generationMatches(
            state.resolveIncidentGeneration,
            notification.incidentGeneration
          )
        ) {
          allPagerDutyResolvesSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error: PAGERDUTY_RESOLVE_IN_PROGRESS_MESSAGE,
          });
          continue;
        }

        const exactDedupKey = legacyAuditPending
          ? pagerDutyDedupKey(
              provider.id,
              notification.alertCode,
              notification.incidentGeneration,
              "legacy_unknown"
            )
          : state?.pagerDutyDedupKey ??
            pagerDutyDedupKey(
              provider.id,
              notification.alertCode,
              notification.incidentGeneration,
              notification.pagerDutyAuditState
            );
        const claim = await claimResolveDelivery(
          db,
          notification.id,
          channel,
          notification.incidentGeneration,
          state?.resolveClaimGeneration ?? 0,
          exactDedupKey,
          operationClaim,
          claimLeaseDurationMs,
          clock
        );
        if (!claim) {
          allPagerDutyResolvesSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error: PAGERDUTY_RESOLVE_IN_PROGRESS_MESSAGE,
          });
          continue;
        }

        let attempts: number;
        try {
          attempts = await sendToChannel(
            channel,
            provider,
            resolvedAlert,
            now,
            fetchImpl,
            settings,
            sleepImpl,
            "resolve",
            claim.pagerDutyDedupKey
          );
        } catch (error) {
          allPagerDutyResolvesSent = false;
          const failure = failureDetails(error);
          const outcomeAt = noEarlierThan(now, clock());
          try {
            await recordResolveOutcome(
              db,
              notification.id,
              channel,
              claim,
              outcomeAt,
              failure.attempts,
              failure.message
            );
          } catch (persistenceError) {
            if (
              !isPrismaModelTimeout(
                persistenceError,
                "ProviderAlertChannelDelivery"
              )
            ) {
              throw persistenceError;
            }
            noteChannelPersistenceDegradation(
              result,
              {
                providerId: provider.id,
                alertCode: notification.alertCode,
                channel: channel.kind,
              },
              "resolve_failure_outcome",
              persistenceError
            );
          }
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error: failure.message,
          });
          continue;
        }

        const outcomeAt = noEarlierThan(now, clock());
        try {
          await recordResolveOutcome(
            db,
            notification.id,
            channel,
            claim,
            outcomeAt,
            attempts,
            null
          );
        } catch (persistenceError) {
          if (
            !isPrismaModelTimeout(
              persistenceError,
              "ProviderAlertChannelDelivery"
            )
          ) {
            throw persistenceError;
          }
          allPagerDutyResolvesSent = false;
          noteChannelPersistenceDegradation(
            result,
            {
              providerId: provider.id,
              alertCode: notification.alertCode,
              channel: channel.kind,
            },
            "resolve_success_outcome",
            persistenceError
          );
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error:
              "PagerDuty resolve was accepted but its channel state timed out; the idempotent resolve remains pending",
          });
        }
      }

      if (!allPagerDutyResolvesSent) continue;
      const closedAt = noEarlierThan(
        noEarlierThan(
          noEarlierThan(now, operationClaim.claimedAt),
          clock()
        ),
        notification.lastDetectedAt
      );
      const closed = await db.providerAlertNotification.updateMany({
        where: {
          id: notification.id,
          incidentGeneration: notification.incidentGeneration,
          resolvedAt: null,
          operationClaimToken: operationClaim.token,
          operationClaimGeneration: operationClaim.generation,
          operationClaimIncidentGeneration:
            operationClaim.incidentGeneration,
          operationClaimConfigGeneration:
            operationClaim.configGeneration,
          operationClaimExpiresAt: { gt: closedAt },
          provider: {
            is: {
              alertConfigGeneration: resolutionEvidence.configGeneration,
            },
          },
          AND: [
            { OR: evidenceAtMostConditions(resolutionEvidence) },
          ],
        },
        data: {
          resolvedAt: closedAt,
          evidenceConfigGeneration: resolutionEvidence.configGeneration,
          evidenceWatermarkAt: resolutionEvidence.at,
          evidenceWatermarkState: "clear",
          operationClaimToken: null,
          operationClaimExpiresAt: null,
          operationClaimConfigGeneration: null,
          ...(legacyAuditPending
            ? { pagerDutyAuditState: "legacy_audited" }
            : {}),
        },
      });
      if (closed.count !== 1) throw new TriggerDeliveryClaimLostError();
      operationClosed = true;
      result.resolved += 1;
      } finally {
        if (!operationClosed) {
          await releaseNotificationOperation(db, notification.id, operationClaim);
        }
      }
    }

    for (const alert of deliverableAlerts) {
      const activationEvidence = alertEvidence(
        provider,
        alert.code,
        now,
        "active"
      );
      const notification = await activateProviderAlertNotification(
        db,
        provider,
        alert,
        now,
        activationEvidence
      );

      if (!notification) {
        result.skipped += 1;
        result.errors.push({
          providerId: provider.id,
          alertCode: alert.code,
          channel: "incident",
          error: STALE_ALERT_EVIDENCE_MESSAGE,
        });
        continue;
      }

      if (channels.length === 0) {
        result.skipped += 1;
        continue;
      }

      const operationClaim = await claimNotificationOperation(
        db,
        notification,
        activationEvidence,
        operationClaimLeaseDurationMs,
        clock
      );
      if (!operationClaim) {
        result.skipped += 1;
        result.errors.push({
          providerId: provider.id,
          alertCode: alert.code,
          channel: "incident",
          error: NOTIFICATION_OPERATION_IN_PROGRESS_MESSAGE,
        });
        continue;
      }
      try {

      const channelStates = await db.providerAlertChannelDelivery.findMany({
        where: { notificationId: notification.id },
        select: {
          channelKey: true,
          lastAttemptAt: true,
          lastSucceededAt: true,
          lastSucceededIncidentGeneration: true,
          lastError: true,
          triggerClaimToken: true,
          triggerClaimGeneration: true,
          triggerClaimExpiresAt: true,
          triggerIncidentGeneration: true,
        },
      });
      const stateByChannelKey = new Map(
        channelStates.map((state) => [state.channelKey, state])
      );
      let hasDeferredDueChannel = false;
      const dueChannels = channels.filter((channel) => {
        const persisted = stateByChannelKey.get(channelKey(channel));
        if (
          persisted?.triggerClaimToken &&
          persisted.triggerClaimExpiresAt &&
          persisted.triggerClaimExpiresAt > now &&
          generationMatches(
            persisted.triggerIncidentGeneration,
            notification.incidentGeneration
          )
        ) {
          hasDeferredDueChannel = true;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_CLAIM_IN_PROGRESS_MESSAGE,
          });
          return false;
        }
        if (
          persisted?.lastError === TRIGGER_OUTCOME_UNKNOWN_MARKER &&
          persisted.lastAttemptAt &&
          generationMatches(
            persisted.triggerIncidentGeneration,
            notification.incidentGeneration
          ) &&
          !dueForChannel(
            persisted.lastAttemptAt,
            persisted.triggerIncidentGeneration,
            notification.incidentGeneration,
            notification.firstDetectedAt,
            now,
            config.reminderHours
          )
        ) {
          hasDeferredDueChannel = true;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_OUTCOME_UNKNOWN_MESSAGE,
          });
          return false;
        }
        // lastSentAt is a migration bridge for rows written before channel
        // state existed. It prevents a one-time replay of every successful
        // legacy notification immediately after this additive table ships.
        const lastSucceededAt = persisted
          ? persisted.lastSucceededAt
          : notification.lastSentAt;
        return dueForChannel(
          lastSucceededAt,
          persisted?.lastSucceededIncidentGeneration ?? null,
          notification.incidentGeneration,
          notification.firstDetectedAt,
          now,
          config.reminderHours
        );
      });

      if (dueChannels.length === 0) {
        result.skipped += 1;
        continue;
      }

      let allDueChannelsSent = !hasDeferredDueChannel;
      let anyChannelSent = false;
      for (const channel of dueChannels) {
        // Atomically claim a durable generation before crossing the external
        // call boundary. Concurrent workers cannot both own the same channel,
        // and a crashed owner recovers only after lease expiry + reminder due.
        const claim = await claimTriggerDelivery(
          db,
          notification.id,
          channel,
          notification.incidentGeneration,
          stateByChannelKey.get(channelKey(channel))?.triggerClaimGeneration ?? 0,
          channel.kind === "pagerduty"
            ? pagerDutyDedupKey(
                provider.id,
                alert.code,
                notification.incidentGeneration,
                notification.pagerDutyAuditState
              )
            : null,
          operationClaim,
          claimLeaseDurationMs,
          clock
        );
        if (!claim) {
          allDueChannelsSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_CLAIM_IN_PROGRESS_MESSAGE,
          });
          continue;
        }

        let attempts: number;
        try {
          attempts = await sendToChannel(
            channel,
            provider,
            alert,
            now,
            fetchImpl,
            settings,
            sleepImpl,
            "trigger",
            claim.pagerDutyDedupKey
          );
        } catch (error) {
          allDueChannelsSent = false;
          const failure = failureDetails(error);
          const outcomeAt = noEarlierThan(now, clock());
          if (failure.outcome === "unknown") {
            try {
              await recordTriggerUnknownOutcome(
                db,
                notification.id,
                channel,
                claim,
                outcomeAt,
                failure.attempts
              );
            } catch (persistenceError) {
              if (
                !isPrismaModelTimeout(
                  persistenceError,
                  "ProviderAlertChannelDelivery"
                )
              ) {
                throw persistenceError;
              }
              // The durable claim already encodes unknown outcome. Its lease
              // expiry plus the reminder interval bounds recovery.
              noteChannelPersistenceDegradation(
                result,
                {
                  providerId: provider.id,
                  alertCode: alert.code,
                  channel: channel.kind,
                },
                "trigger_unknown_outcome",
                persistenceError
              );
            }
          } else {
            try {
              await recordTriggerOutcome(
                db,
                notification.id,
                channel,
                claim,
                outcomeAt,
                failure.attempts,
                failure.message
              );
            } catch (persistenceError) {
              if (
                !isPrismaModelTimeout(
                  persistenceError,
                  "ProviderAlertChannelDelivery"
                )
              ) {
                throw persistenceError;
              }
              noteChannelPersistenceDegradation(
                result,
                {
                  providerId: provider.id,
                  alertCode: alert.code,
                  channel: channel.kind,
                },
                "trigger_rejected_outcome",
                persistenceError
              );
            }
          }
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error:
              failure.outcome === "unknown"
                ? TRIGGER_TRANSPORT_UNKNOWN_MESSAGE
                : failure.message,
          });
          continue;
        }

        anyChannelSent = true;
        const outcomeAt = noEarlierThan(now, clock());
        try {
          await recordTriggerOutcome(
            db,
            notification.id,
            channel,
            claim,
            outcomeAt,
            attempts,
            null
          );
        } catch (error) {
          if (!isPrismaModelTimeout(error, "ProviderAlertChannelDelivery")) throw error;

          // The external endpoint accepted the delivery. The durable intent
          // remains an explicit unknown outcome, so do not relabel this as a
          // failed send or retry it automatically on the next maintenance tick.
          allDueChannelsSent = false;
          noteChannelPersistenceDegradation(
            result,
            {
              providerId: provider.id,
              alertCode: alert.code,
              channel: channel.kind,
            },
            "trigger_success_outcome",
            error
          );
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_SUCCESS_PERSISTENCE_TIMEOUT_MESSAGE,
          });
        }
      }

      if (allDueChannelsSent && anyChannelSent) {
        try {
          const summaryAt = noEarlierThan(
            noEarlierThan(now, operationClaim.claimedAt),
            clock()
          );
          const summary = await db.providerAlertNotification.updateMany({
            where: {
              id: notification.id,
              incidentGeneration: notification.incidentGeneration,
              resolvedAt: null,
              evidenceConfigGeneration:
                activationEvidence.configGeneration,
              evidenceWatermarkAt: activationEvidence.at,
              evidenceWatermarkState: "active",
              operationClaimToken: operationClaim.token,
              operationClaimGeneration: operationClaim.generation,
              operationClaimIncidentGeneration:
                operationClaim.incidentGeneration,
              operationClaimConfigGeneration:
                operationClaim.configGeneration,
              operationClaimExpiresAt: { gt: summaryAt },
              provider: {
                is: {
                  alertConfigGeneration: activationEvidence.configGeneration,
                },
              },
            },
            data: {
              lastSentAt: summaryAt,
              sendCount: { increment: 1 },
            },
          });
          if (summary.count !== 1) throw new TriggerDeliveryClaimLostError();
        } catch (error) {
          if (!isPrismaModelTimeout(error, "ProviderAlertNotification")) throw error;
          deferredSummaryTimeout ??= error;
          result.sent += 1;
          continue;
        }
        result.sent += 1;
      }
      } finally {
        await releaseNotificationOperation(db, notification.id, operationClaim);
      }
    }
  }

  if (deferredSummaryTimeout) {
    throw new AlertNotificationSummaryPersistenceTimeout(deferredSummaryTimeout, {
      ...result,
      errors: [...result.errors],
    });
  }
  return result;
}
