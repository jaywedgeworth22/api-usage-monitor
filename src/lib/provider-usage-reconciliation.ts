import { prisma } from "@/lib/prisma";
import { sumMonthToDateExternalCostByProvider } from "@/lib/external-usage-events";
import { getProviderIntegrationProfile } from "@/lib/provider-integration-catalog";
import {
  canonicalProviderKey,
  resolveProviderIdentity,
} from "@/lib/provider-identity";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

/**
 * Period-level reconciliation (DESIGN-usage-compliance-classifier §3d).
 *
 * For each active provider, compares what the apps SELF-REPORTED via pushed
 * telemetry against the provider's own AUTHORITATIVE month-to-date cost, and
 * records the delta as an auditable `ProviderUsageReconciliation` row.
 *
 * Two rules this module exists to enforce:
 *   1. A provider whose billing simply cannot be verified is labelled
 *      "unverifiable" EXPLICITLY — never skipped, so a structurally-blind
 *      provider can never read as silently reconciled/ok.
 *   2. Rows are UPSERTED on the (providerId, periodStart, periodEnd, keyRef)
 *      unique key, so repeated passes update one row per provider-period
 *      instead of destroying and recreating history.
 *
 * This is an audit layer ONLY. It never feeds the max() budget-spend logic in
 * budget-status.ts.
 */

const DEFAULT_ABS_TOLERANCE_USD = 0.01;
const DEFAULT_RATIO_TOLERANCE = 0.05;
const RAW_RETENTION_DAYS = 90;
const VERIFIED_SOURCE = "usage-snapshot";

/** Provider-wide rows use the "" sentinel — see the schema comment on keyRef. */
const PROVIDER_WIDE_KEY_REF = "";

export interface ProviderUsageReconciliationResult {
  examined: number;
  reconciled: number;
  discrepancies: number;
  unverifiable: number;
  pending: number;
  /** Kept for the maintenance summary. */
  reconciledCount: number;
}

function resolveTolerance(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Month bounds are computed as STABLE UTC instants. periodEnd must not be
 * "now": the unique key includes it, so a moving end would address a different
 * row every pass and defeat the upsert entirely.
 */
export function monthBounds(now: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  return { periodStart, periodEnd };
}

export function isReconcilableVisibility(visibility: string): boolean {
  return visibility === "actual" || visibility === "partial";
}

export function reconciliationStatus(
  reportedCostUsd: number,
  verifiedCostUsd: number,
  absTolerance: number,
  ratioTolerance: number
): "ok" | "discrepancy" {
  const allowed = Math.max(
    absTolerance,
    Math.abs(verifiedCostUsd) * ratioTolerance
  );
  return Math.abs(verifiedCostUsd - reportedCostUsd) <= allowed
    ? "ok"
    : "discrepancy";
}

export async function reconcileProviderUsage(
  now: Date = new Date()
): Promise<ProviderUsageReconciliationResult> {
  const { periodStart, periodEnd } = monthBounds(now);
  const rawCutoff = new Date(
    now.getTime() - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const absTolerance = resolveTolerance(
    "USAGE_RECONCILIATION_ABS_TOLERANCE_USD",
    DEFAULT_ABS_TOLERANCE_USD
  );
  const ratioTolerance = resolveTolerance(
    "USAGE_RECONCILIATION_RATIO_TOLERANCE",
    DEFAULT_RATIO_TOLERANCE
  );

  // ONE aggregation call per pass. This helper is on budget-status's hot path
  // (~336k-row groupBy) — the boot-OOM incident came from running two of these
  // concurrently, so it must never be called per-provider inside the loop.
  const [providers, pushedCosts] = await Promise.all([
    prisma.provider.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        type: true,
        snapshots: {
          where: {
            fetchedAt: { gte: periodStart },
            totalCost: { not: null },
            costScope: "calendar_month_to_date",
          },
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { totalCost: true },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(periodStart, rawCutoff),
  ]);

  // Index the pushed-cost map by canonical provider key so alias spellings
  // (e.g. google_ai vs google-ai) reconcile against the same bucket.
  const pushedByCanonicalKey = new Map<
    string,
    { usagePushed: number; eventCount: number }
  >();
  for (const [name, cost] of pushedCosts.entries()) {
    const key = canonicalProviderKey(name);
    const existing = pushedByCanonicalKey.get(key);
    const eventCount =
      cost.pricedEventCount +
      cost.unpricedEventCount +
      cost.unclassifiedCostEventCount;
    if (existing) {
      existing.usagePushed += cost.usagePushed;
      existing.eventCount += eventCount;
    } else {
      pushedByCanonicalKey.set(key, {
        usagePushed: cost.usagePushed,
        eventCount,
      });
    }
  }

  let reconciled = 0;
  let discrepancies = 0;
  let unverifiable = 0;
  let pending = 0;

  // A pushed-cost bucket is canonical-key scoped, but several ACTIVE Provider
  // rows can share one canonical key (Provider.name has no unique constraint;
  // alias spellings collapse too). Attributing the whole bucket to each row
  // would report the same pushed dollars N times and manufacture false
  // discrepancies on a perfectly reconciled month. Attributing to one owner
  // row while siblings are recorded as unverifiable still generates a false
  // discrepancy for a genuine split. Therefore, every row in a multi-row key
  // is marked unverifiable.
  // Keyed off the PROVIDER ROWS, not the pushed buckets: two same-key rows are
  // ambiguous whether or not any telemetry has been pushed yet, and a bucket
  // that arrives later must not suddenly be double-counted.
  const rowsByCanonicalKey = new Map<string, string[]>();
  for (const provider of providers) {
    const key = canonicalProviderKey(provider.name);
    const bucket = rowsByCanonicalKey.get(key);
    if (bucket) bucket.push(provider.id);
    else rowsByCanonicalKey.set(key, [provider.id]);
  }
  const ownerIdByCanonicalKey = new Map<string, string>();
  for (const [key, ids] of rowsByCanonicalKey.entries()) {
    if (ids.length === 1) {
      ownerIdByCanonicalKey.set(key, ids[0]);
    }
    // If ids.length > 1, no owner is set (remains undefined). Thus, all rows
    // for this key will have ambiguous attribution.
  }

  for (const provider of providers) {
    const canonicalKey = canonicalProviderKey(provider.name);
    const ownerId = ownerIdByCanonicalKey.get(canonicalKey);
    // If no single owner could be resolved, or this provider isn't the owner,
    // the attribution is ambiguous and its pushed slice cannot be separated.
    const ambiguousAttribution = ownerId == null || ownerId !== provider.id;
    const pushed =
      ambiguousAttribution
        ? { usagePushed: 0, eventCount: 0 }
        : pushedByCanonicalKey.get(canonicalKey) ?? {
            usagePushed: 0,
            eventCount: 0,
          };
    const reportedCostUsd = pushed.usagePushed;
    const reportedEventCount = pushed.eventCount;

    const visibility = getProviderIntegrationProfile(
      provider.name,
      provider.type
    ).billing.visibility;
    const snapshotCost = provider.snapshots[0]?.totalCost ?? null;

    let status: string;
    let verifiedCostUsd: number | null = null;
    let deltaUsd: number | null = null;
    let deltaRatio: number | null = null;

    if (ambiguousAttribution) {
      // Explicit, never a silent skip and never a computed delta.
      status = "unverifiable";
      unverifiable += 1;
    } else if (!isReconcilableVisibility(visibility)) {
      // metadata | manual | none — structurally not verifiable. Recorded
      // EXPLICITLY so the dashboard can say "unverifiable" instead of implying
      // this provider was checked and found fine.
      status = "unverifiable";
      unverifiable += 1;
    } else if (snapshotCost == null) {
      // Verifiable in principle, but no authoritative month-to-date cost has
      // been polled yet this period.
      status = "pending";
      pending += 1;
    } else {
      verifiedCostUsd = snapshotCost;
      deltaUsd = snapshotCost - reportedCostUsd;
      deltaRatio =
        reportedCostUsd !== 0 ? deltaUsd / reportedCostUsd : null;
      status = reconciliationStatus(
        reportedCostUsd,
        snapshotCost,
        absTolerance,
        ratioTolerance
      );
      if (status === "discrepancy") discrepancies += 1;
      reconciled += 1;
    }

    const row = {
      reportedCostUsd,
      reportedEventCount,
      verifiedCostUsd,
      verifiedSource: verifiedCostUsd == null ? null : VERIFIED_SOURCE,
      deltaUsd,
      deltaRatio,
      status,
      checkedAt: now,
    };

    await withInternalUsageWriteAdmission(async () => {
      await prisma.providerUsageReconciliation.upsert({
        where: {
          providerId_periodStart_periodEnd_keyRef: {
            providerId: provider.id,
            periodStart,
            periodEnd,
            keyRef: PROVIDER_WIDE_KEY_REF,
          },
        },
        create: {
          providerId: provider.id,
          periodStart,
          periodEnd,
          keyRef: PROVIDER_WIDE_KEY_REF,
          ...row,
        },
        update: row,
      });
    });
  }

  return {
    examined: providers.length,
    reconciled,
    discrepancies,
    unverifiable,
    pending,
    reconciledCount: reconciled + unverifiable + pending,
  };
}
