import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";
import { AdapterError, type AdapterErrorCode } from "@/lib/adapters/helpers";
import {
  isUsageMaintenanceHealthy,
  runUsageMaintenance,
} from "@/lib/usage-maintenance";
import { ensureAgentSyncProviderSeeded } from "@/lib/ensure-agent-sync-provider";
import {
  bootstrapStGeminiCredentialToInfisical,
  syncProviderCredentialsFromInfisical,
  type InfisicalCredentialSyncResult,
  type StGeminiInfisicalBootstrapResult,
} from "@/lib/infisical-provider-sync";
import {
  markSchedulerStarted,
  markSchedulerTickCompleted,
  markSchedulerTickStarted,
} from "@/lib/runtime-health";
import { reconcileProviderExternalBilling } from "@/lib/provider-external-billing";
import { Prisma, type Provider, type UsageSnapshot } from "@prisma/client";
import {
  isRetryablePartialSnapshot,
  withSnapshotSyncFailure,
} from "@/lib/snapshot-sync-status";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
const providerAttemptTokens = new Map<string, symbol>();

function assertProviderAttemptCurrent(
  providerId: string,
  token: symbol,
  signal?: AbortSignal
): void {
  if (signal?.aborted || providerAttemptTokens.get(providerId) !== token) {
    throw new AdapterError("Provider fetch was superseded before it could commit", {
      code: "SUPERSEDED",
      retryable: true,
    });
  }
}

function resolveProviderTimeoutMs(): number {
  const raw = process.env.ADAPTER_PROVIDER_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_PROVIDER_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return parsed;
}

export async function recordProviderUsage(
  provider: Provider,
  signal?: AbortSignal
): Promise<UsageSnapshot> {
  const attemptToken = Symbol(provider.id);
  providerAttemptTokens.set(provider.id, attemptToken);
  try {
    const usage = await fetchProviderUsage(provider);
    assertProviderAttemptCurrent(provider.id, attemptToken, signal);

    const snapshot = await withInternalUsageWriteAdmission(async () => {
      assertProviderAttemptCurrent(provider.id, attemptToken, signal);
      return prisma.$transaction(async (tx) => {
        const billingSyncs = [
          ...(usage.externalBilling ? [usage.externalBilling] : []),
          ...(usage.externalBillingSyncs ?? []),
        ];
        for (const sync of billingSyncs) {
          assertProviderAttemptCurrent(provider.id, attemptToken, signal);
          await reconcileProviderExternalBilling(provider.id, sync, tx);
        }

        assertProviderAttemptCurrent(provider.id, attemptToken, signal);
        const snapshot = await tx.usageSnapshot.create({
          data: {
            providerId: provider.id,
            fetchedAt: new Date(),
            balance: usage.balance,
            totalCost: usage.totalCost,
            fixedCostIncludedUsd: usage.fixedCostIncludedUsd,
            costWindowStart: usage.costWindowStart
              ? new Date(usage.costWindowStart)
              : null,
            costWindowEnd: usage.costWindowEnd
              ? new Date(usage.costWindowEnd)
              : null,
            costScope: usage.costScope,
            costIncludesUnknownFixed: usage.costIncludesUnknownFixed ?? false,
            totalRequests: usage.totalRequests,
            credits: usage.credits,
            rawData:
              withSnapshotSyncFailure(usage.rawData, usage.postPersistError) ??
              undefined,
          },
        });
        // A newer attempt may have started while SQLite was awaiting the INSERT.
        // Throwing here rolls the whole transaction back, including billing syncs.
        assertProviderAttemptCurrent(provider.id, attemptToken, signal);
        return snapshot;
      });
    });
    if (usage.postPersistError) throw usage.postPersistError;
    return snapshot;
  } finally {
    if (providerAttemptTokens.get(provider.id) === attemptToken) {
      providerAttemptTokens.delete(provider.id);
    }
  }
}

// Guards fetchAllDueProviders against concurrent callers (scheduler tick vs a
// manual /api/cron/fetch-all trigger, or two overlapping manual triggers)
// both treating the same provider as "due" and firing duplicate fetches.
// This app runs as a single Node process against a local SQLite file, so a
// simple in-process mutex is sufficient - there is no multi-instance/
// multi-process deployment for this service to coordinate across.
export interface ProviderFetchError {
  providerId: string;
  name: string;
  error: string;
  code: AdapterErrorCode | "UNKNOWN";
  status: number | null;
  retryable: boolean;
}

export interface ProviderFetchOutcome {
  providerId: string;
  name: string;
  status: "success" | "failure" | "skipped";
  durationMs: number;
  errorCode?: AdapterErrorCode | "UNKNOWN";
}

export interface FetchAllProvidersResult {
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  errors: ProviderFetchError[];
  outcomes: ProviderFetchOutcome[];
  // Safe status/code only. The one-time bootstrap never returns credential
  // material or an upstream response body.
  credentialBootstrap?: StGeminiInfisicalBootstrapResult;
  // Safe counts/status codes only; no Infisical names, tokens, or values.
  credentialSync?: InfisicalCredentialSyncResult;
}

let fetchAllInFlight: Promise<FetchAllProvidersResult> | null = null;

export async function fetchAllDueProviders(): Promise<FetchAllProvidersResult> {
  // If a run is already in progress, wait for it and return its result
  // instead of starting a second, overlapping pass over the same providers.
  if (fetchAllInFlight) {
    return fetchAllInFlight;
  }

  const run = (async () => {
    await withInternalUsageWriteAdmission(() => ensureAgentSyncProviderSeeded());
    // The default-off, exact ST Gemini bootstrap must run before the normal
    // one-way Infisical pull so a successful create can be adopted and bound
    // in this same provider-maintenance pass.
    const credentialBootstrap =
      await bootstrapStGeminiCredentialToInfisical();
    const suppressStGeminiPull =
      credentialBootstrap.enabled &&
      credentialBootstrap.status !== "created" &&
      credentialBootstrap.status !== "already_present_same";
    let credentialSync: InfisicalCredentialSyncResult;
    try {
      // Network reads happen before the sync helper takes the internal SQLite
      // writer lease, so Infisical latency never blocks usage ingest. Any
      // failure keeps encrypted last-known-good credentials in place.
      credentialSync = await syncProviderCredentialsFromInfisical({
        suppressStGemini: suppressStGeminiPull,
      });
      if (credentialSync.failed > 0) {
        console.warn(
          `[infisical-provider-sync] retained last-known-good credentials for ${credentialSync.failed} failed mapping(s)`
        );
      }
    } catch {
      console.error(
        "[infisical-provider-sync] unexpected failure; retained existing provider credentials"
      );
      credentialSync = {
        enabled: true,
        configured: true,
        sources: [],
        created: 0,
        updated: 0,
        unchanged: 0,
        missing: 0,
        failed: 1,
      };
    }
    const providers = await prisma.provider.findMany({
      where: { isActive: true },
      include: {
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { fetchedAt: true, rawData: true },
        },
      },
    });

    let successes = 0;
    let failures = 0;
    let skipped = 0;
    const errors: ProviderFetchError[] = [];
    const outcomes: ProviderFetchOutcome[] = [];
    const now = Date.now();
    const providerTimeoutMs = resolveProviderTimeoutMs();

    for (const { snapshots, ...provider } of providers) {
      const startedAt = Date.now();
      const latestSnapshot = snapshots[0];
      const intervalMs = provider.refreshIntervalMin * 60 * 1000;
      // Pushed quota/credit events intentionally create rawData-less
      // snapshots. They may be newer than the last poll snapshot, but must not
      // hide its retry marker or make an old/missing poll look fresh.
      const latestPollSnapshot =
        latestSnapshot?.rawData == null
          ? await prisma.usageSnapshot.findFirst({
              where: {
                providerId: provider.id,
                rawData: { not: Prisma.DbNull },
              },
              orderBy: { fetchedAt: "desc" },
              select: { fetchedAt: true, rawData: true },
            })
          : latestSnapshot;
      const latestPollFetchedAt = latestPollSnapshot?.fetchedAt.getTime();
      if (
        latestPollFetchedAt &&
        !isRetryablePartialSnapshot(latestPollSnapshot?.rawData) &&
        now - latestPollFetchedAt < intervalMs
      ) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      try {
        // Outer per-provider time budget: a single pathological adapter
        // (hung DNS, a fetchJson call whose own timeout got bypassed via a
        // caller-supplied signal, etc.) must not stall the rest of the
        // sequential loop. If the budget is exhausted we record it as a
        // failure and move on. The adapter request may still finish in the
        // background, but the abort/generation guard prevents it from writing
        // stale snapshot or billing state after the timeout.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const attemptController = new AbortController();
        try {
          await Promise.race([
            recordProviderUsage(provider, attemptController.signal),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => {
                  attemptController.abort();
                  reject(
                    new AdapterError(
                      `Provider ${provider.name} timed out after ${providerTimeoutMs}ms`,
                      { code: "TIMEOUT", retryable: true }
                    )
                  );
                },
                providerTimeoutMs
              );
              // Don't let a still-pending timeout keep the event loop (and the
              // Node process) alive on its own in one-shot/test contexts.
              timeoutHandle.unref?.();
            }),
          ]);
        } finally {
          // Always clear the timer - whether the provider succeeded, threw, or
          // the timeout won the race - so a winning provider doesn't leave a
          // stray timer lingering for up to the full budget every poll pass.
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        successes++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "success",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const typed = error instanceof AdapterError ? error : null;
        // Push/manual-only adapters intentionally report UNSUPPORTED because
        // there is no safe provider API to poll. That is a capability state,
        // not a failed scheduler operation; counting it as a failure makes a
        // healthy tick look broken even though no provider request was made.
        if (typed?.code === "UNSUPPORTED") {
          skipped++;
          outcomes.push({
            providerId: provider.id,
            name: provider.name,
            status: "skipped",
            durationMs: Date.now() - startedAt,
            errorCode: typed.code,
          });
          continue;
        }

        failures++;
        errors.push({
          providerId: provider.id,
          name: provider.name,
          error: error instanceof Error ? error.message : "Failed to fetch",
          code: typed?.code ?? "UNKNOWN",
          status: typed?.status ?? null,
          retryable: typed?.retryable ?? false,
        });
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "failure",
          durationMs: Date.now() - startedAt,
          errorCode: typed?.code ?? "UNKNOWN",
        });
      }
    }

    return {
      total: providers.length,
      successes,
      failures,
      skipped,
      errors,
      outcomes,
      credentialBootstrap,
      credentialSync,
    };
  })();

  fetchAllInFlight = run;
  try {
    return await run;
  } finally {
    // Only clear the in-flight marker if it's still our own run - avoids a
    // pathological case where a later run somehow got assigned first.
    if (fetchAllInFlight === run) {
      fetchAllInFlight = null;
    }
  }
}

const POLL_INTERVAL_MS = 15 * 60 * 1000; // matches the old external cron's */15 schedule exactly - don't change the cadence, only where it runs
let schedulerStarted = false;

export interface UsagePollingSchedulerTickDependencies {
  fetchProviders?: typeof fetchAllDueProviders;
  runMaintenance?: typeof runUsageMaintenance;
  markTickStarted?: typeof markSchedulerTickStarted;
  markTickCompleted?: typeof markSchedulerTickCompleted;
}

export async function runUsagePollingSchedulerTick(
  dependencies: UsagePollingSchedulerTickDependencies = {}
): Promise<void> {
  const markTickStarted = dependencies.markTickStarted ?? markSchedulerTickStarted;
  const markTickCompleted = dependencies.markTickCompleted ?? markSchedulerTickCompleted;
  markTickStarted();
  try {
    const result = await (dependencies.fetchProviders ?? fetchAllDueProviders)();
    const maintenance = await (dependencies.runMaintenance ?? runUsageMaintenance)();
    const maintenanceHealthy = isUsageMaintenanceHealthy(maintenance);
    markTickCompleted(maintenanceHealthy, {
      total: result.total,
      successes: result.successes,
      failures: result.failures,
      skipped: result.skipped,
      maintenanceHealthy,
      cloudflareLegacyHandoff:
        maintenance.subscriptionAdoption.cloudflareLegacyHandoff,
    });
  } catch (error) {
    markTickCompleted(false, null);
    console.error("[usage-scheduler] tick failed", error);
  }
}

export function startUsagePollingScheduler(): void {
  if (schedulerStarted) return; // instrumentation.register() can fire more than once in some Next.js scenarios - guard against double-scheduling
  schedulerStarted = true;
  markSchedulerStarted();
  setInterval(() => void runUsagePollingSchedulerTick(), POLL_INTERVAL_MS);
  void runUsagePollingSchedulerTick(); // also run once immediately on boot, don't wait a full interval
}
