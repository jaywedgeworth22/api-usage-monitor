import { prisma } from "@/lib/prisma";
import { getProviderIntegrationProfile } from "@/lib/provider-integration-catalog";
import { monthBounds } from "@/lib/provider-usage-reconciliation";

/**
 * Read-only compliance summary for one provider (DESIGN §3f).
 *
 * Surfaces the audit layer built in §3c/§3d so drift is visible instead of
 * merely recorded: how much of this provider's pushed telemetry was actually
 * verified against the provider's own numbers, how much money the two sides
 * disagree about, and — crucially — an explicit "unverifiable" state for
 * providers whose billing simply cannot be checked.
 *
 * This is display-only. It never feeds budgets, alerts, or the max() spend
 * logic; it reports what the audit layer already persisted.
 */

export type ComplianceState =
  | "verified"
  | "discrepancy"
  | "partial"
  | "pending"
  | "unverifiable";

export interface ProviderComplianceSummary {
  /** Overall badge state for this provider. */
  state: ComplianceState;
  /**
   * Share of generation-id-carrying events that reached a settled verification
   * (match or discrepancy), 0..1. Null when nothing is verifiable at all.
   */
  verifiedCoverage: number | null;
  verifiableEventCount: number;
  verifiedEventCount: number;
  matchedEventCount: number;
  discrepancyEventCount: number;
  pendingEventCount: number;
  /** Events whose retry budget was exhausted or that carry no verifiable source. */
  unverifiableEventCount: number;
  /** Signed provider-verified minus self-reported, for the current period. */
  periodDeltaUsd: number | null;
  periodReportedCostUsd: number | null;
  periodVerifiedCostUsd: number | null;
  periodStatus: string | null;
  /** Why this provider cannot be verified, when that is the case. */
  unverifiableReason: string | null;
  checkedAt: Date | null;
}

const UNVERIFIABLE_REASONS: Record<string, string> = {
  metadata:
    "This provider exposes usage metadata only — it publishes no authoritative cash total to reconcile against.",
  manual:
    "This provider has no billing API; its cost is entered manually, so there is nothing to verify automatically.",
  none: "This provider exposes no billing surface at all.",
};

export function isVerifiableVisibility(visibility: string): boolean {
  return visibility === "actual" || visibility === "partial";
}

/**
 * Share of permanently-failed events above which a provider may no longer be
 * called "Verified". Event-level "unverifiable" is written ONLY by the
 * verification worker's retry-exhausted branch, i.e. a check was attempted
 * MAX_VERIFICATION_ATTEMPTS times and failed every time (expired/foreign
 * generation id, sustained 429/5xx). That is a verification FAILURE, not a
 * benign "not applicable" — so a material population of them must visibly
 * degrade the badge instead of being quietly discounted.
 */
const MAX_EXHAUSTED_SHARE_FOR_VERIFIED = 0.05;

/**
 * Derives the badge state. Ordering is deliberate: a real money disagreement
 * outranks incomplete coverage, and "unverifiable" is never allowed to read as
 * healthy — an unverifiable provider is explicitly labelled, never silently ok.
 */
export function deriveComplianceState(input: {
  verifiable: boolean;
  verifiableEventCount: number;
  verifiedEventCount: number;
  discrepancyEventCount: number;
  unverifiableEventCount: number;
  periodStatus: string | null;
}): ComplianceState {
  if (!input.verifiable) return "unverifiable";
  if (input.discrepancyEventCount > 0 || input.periodStatus === "discrepancy") {
    return "discrepancy";
  }
  if (input.periodStatus === "unverifiable") return "unverifiable";
  if (input.verifiableEventCount === 0) {
    // Nothing can settle. If the period had calls and every one of them
    // exhausted its retries, say so rather than implying a check is still
    // coming — or, worse, reporting a clean period as "verified".
    if (input.unverifiableEventCount > 0) return "unverifiable";
    return input.periodStatus === "ok" ? "verified" : "pending";
  }
  if (input.verifiedEventCount === 0) return "pending";
  if (input.verifiedEventCount < input.verifiableEventCount) return "partial";
  // Every event that could settle did settle — but a material share of this
  // provider's calls exhausted their retries and were never checked at all.
  // Claiming "Verified" here would be exactly the silent-OK this initiative
  // exists to prevent.
  if (
    input.unverifiableEventCount >
    (input.verifiableEventCount + input.unverifiableEventCount) *
      MAX_EXHAUSTED_SHARE_FOR_VERIFIED
  ) {
    return "partial";
  }
  return "verified";
}

export async function getProviderComplianceSummary(
  provider: { id: string; name: string; type: string },
  now: Date = new Date()
): Promise<ProviderComplianceSummary> {
  const { periodStart, periodEnd } = monthBounds(now);
  const visibility = getProviderIntegrationProfile(
    provider.name,
    provider.type
  ).billing.visibility;
  const verifiable = isVerifiableVisibility(visibility);

  const [statusGroups, reconciliation] = await Promise.all([
    // Per-event verification state for this provider's generation-id-carrying
    // events in the current period.
    prisma.externalUsageEvent.groupBy({
      by: ["verificationStatus"],
      where: {
        provider: provider.name,
        providerRequestId: { not: null },
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      _count: { _all: true },
    }),
    prisma.providerUsageReconciliation.findUnique({
      where: {
        providerId_periodStart_periodEnd_keyRef: {
          providerId: provider.id,
          periodStart,
          periodEnd,
          keyRef: "",
        },
      },
    }),
  ]);

  let matchedEventCount = 0;
  let discrepancyEventCount = 0;
  let pendingEventCount = 0;
  let unverifiableEventCount = 0;
  for (const group of statusGroups) {
    const count = group._count._all;
    switch (group.verificationStatus) {
      case "match":
        matchedEventCount += count;
        break;
      case "discrepancy":
        discrepancyEventCount += count;
        break;
      case "unverifiable":
        unverifiableEventCount += count;
        break;
      // null / "pending" / "error" are all still awaiting a settled result.
      default:
        pendingEventCount += count;
        break;
    }
  }

  const verifiedEventCount = matchedEventCount + discrepancyEventCount;
  const verifiableEventCount =
    verifiedEventCount + pendingEventCount + unverifiableEventCount;
  // Coverage is reported over EVERY event carrying a generation id, including
  // the retry-exhausted ones. An earlier revision excluded them on the theory
  // that they were a benign "n/a" bucket — they are not: the only writer of
  // event-level "unverifiable" is the worker's exhausted-retry branch, so each
  // one is a check that was attempted and permanently failed. Excluding them
  // let 1 success alongside 99 failures render as "100% verified".
  const coverageDenominator =
    verifiedEventCount + pendingEventCount + unverifiableEventCount;

  return {
    state: deriveComplianceState({
      verifiable,
      verifiableEventCount: verifiedEventCount + pendingEventCount,
      verifiedEventCount,
      discrepancyEventCount,
      unverifiableEventCount,
      periodStatus: reconciliation?.status ?? null,
    }),
    verifiedCoverage:
      coverageDenominator > 0 ? verifiedEventCount / coverageDenominator : null,
    verifiableEventCount,
    verifiedEventCount,
    matchedEventCount,
    discrepancyEventCount,
    pendingEventCount,
    unverifiableEventCount,
    periodDeltaUsd: reconciliation?.deltaUsd ?? null,
    periodReportedCostUsd: reconciliation?.reportedCostUsd ?? null,
    periodVerifiedCostUsd: reconciliation?.verifiedCostUsd ?? null,
    periodStatus: reconciliation?.status ?? null,
    // An "unverifiable" badge must always carry its explanation, whichever way
    // it was reached: provider billing visibility, an ambiguous period
    // attribution (two active rows sharing a canonical provider key), or every
    // generation id in the period exhausting its retries.
    unverifiableReason: !verifiable
      ? UNVERIFIABLE_REASONS[visibility] ?? null
      : reconciliation?.status === "unverifiable"
        ? "This period could not be attributed to a single provider record — more than one active provider shares this identity, so its pushed usage cannot be split between them."
        : verifiedEventCount === 0 && unverifiableEventCount > 0
          ? "Every recorded call this period exhausted its verification retries — the provider could not confirm any of them."
          : null,
    checkedAt: reconciliation?.checkedAt ?? null,
  };
}
