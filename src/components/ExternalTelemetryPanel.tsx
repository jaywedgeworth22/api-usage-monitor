"use client";

import { useState } from "react";

export type ExternalCostCoverage = "complete" | "partial" | "unknown" | "legacy_unknown";

export interface ExternalUsageGroup {
  sourceApp: string;
  environment: string | null;
  provider: string;
  canonicalProvider: string;
  service: string | null;
  projectId: string | null;
  metricType: string;
  unit: string | null;
  projectName?: string | null;
  matchedProvider?: {
    id: string;
    name: string;
    displayName: string;
  } | null;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  costCoverage: ExternalCostCoverage;
  totalCostUsd: number;
  receiptCashPaidUsd?: number;
  estimatedApiEquivalentUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

export interface ExternalUsageSummary {
  days: number;
  totalCostUsd: number;
  receiptCashPaidUsd?: number;
  estimatedApiEquivalentUsd: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  costCoverage: ExternalCostCoverage;
  totalRequests: number;
  eventCount: number;
  groups: ExternalUsageGroup[];
}

interface ExternalTelemetryPanelProps {
  usageSummary: ExternalUsageSummary;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function costLabel(
  totalCostUsd: number,
  coverage: ExternalCostCoverage,
  unpricedEventCount: number,
  unclassifiedCostEventCount: number
): string {
  if (coverage === "complete") return usd.format(totalCostUsd);
  if (coverage === "partial") {
    const unknownEvents = unpricedEventCount + unclassifiedCostEventCount;
    return `${usd.format(totalCostUsd)} known · ${unknownEvents} unpriced`;
  }
  if (coverage === "legacy_unknown") {
    return totalCostUsd !== 0
      ? `${usd.format(totalCostUsd)} recorded · historical coverage unknown`
      : "Historical cost unknown";
  }
  return "Cost not reported";
}

function identityToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export default function ExternalTelemetryPanel({ usageSummary }: ExternalTelemetryPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const externalCost = usageSummary.totalCostUsd;
  const receiptCashPaid = usageSummary.receiptCashPaidUsd ?? 0;
  const estimatedApiEquivalent = usageSummary.estimatedApiEquivalentUsd;
  const externalRequests = usageSummary.totalRequests;
  const visibleGroups = showAll ? usageSummary.groups : usageSummary.groups.slice(0, 8);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            External App Telemetry
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Last {usageSummary.days} days from sibling app reports
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Tracked cash spend
          </p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {costLabel(
              externalCost,
              usageSummary.costCoverage,
              usageSummary.unpricedEventCount,
              usageSummary.unclassifiedCostEventCount
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {new Intl.NumberFormat("en-US").format(externalRequests)} requests
          </p>
          {estimatedApiEquivalent > 0 && (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              Claude API-equivalent estimate: {usd.format(estimatedApiEquivalent)}
              <span className="block text-[10px] font-normal">
                Excluded from cash spend · verify Anthropic Console billing
              </span>
            </p>
          )}
          {receiptCashPaid > 0 && (
            <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Receipt cash paid: {usd.format(receiptCashPaid)}
              <span className="block text-[10px] font-normal">
                Reconciled with observed usage by max, not added twice
              </span>
            </p>
          )}
        </div>
      </div>
      {usageSummary.groups.length === 0 ? (
        <div className="px-6 py-5 text-sm text-gray-500 dark:text-gray-400">
          No app telemetry received yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse responsive-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Source
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Provider
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  Usage
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Quota
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {visibleGroups.map((group) => {
                const normalizedUnit = group.unit?.trim().toLowerCase();
                const requestBased =
                  normalizedUnit === "request" ||
                  normalizedUnit === "requests" ||
                  (group.totalQuantity === 0 && group.totalRequests !== 0);
                const displayedUsage =
                  requestBased
                    ? group.totalRequests
                    : group.totalQuantity;
                const displayedUnit =
                  group.unit || (requestBased ? "requests" : group.metricType);
                const hasEstimatedApiEquivalent =
                  group.estimatedApiEquivalentUsd > 0;
                const groupReceiptCash = group.receiptCashPaidUsd ?? 0;
                const hasReceiptCash = groupReceiptCash > 0;
                const usagePercent =
                  group.limit != null && group.limit > 0
                    ? Math.min((displayedUsage / group.limit) * 100, 999)
                    : null;
                return (
                  <tr
                    key={`${group.sourceApp}-${group.environment ?? ""}-${group.provider}-${group.service ?? ""}-${group.projectId ?? ""}-${group.metricType}-${group.unit ?? ""}`}
                    className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <td className="px-6 py-4" data-label="Source">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {group.sourceApp}
                        {group.environment ? ` / ${group.environment}` : ""}
                      </p>
                      {group.projectName && (
                        <span className="inline-flex mt-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-100 dark:border-blue-800">
                          {group.projectName}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4" data-label="Provider">
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {group.provider}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {group.service || "API"} · {displayedUnit}
                      </p>
                      {group.matchedProvider &&
                        identityToken(group.matchedProvider.name) !==
                          identityToken(group.provider) && (
                        <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                          Matched to {group.matchedProvider.displayName}
                        </p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right" data-label="Usage">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {hasReceiptCash
                          ? usd.format(groupReceiptCash)
                          : hasEstimatedApiEquivalent
                          ? usd.format(group.estimatedApiEquivalentUsd)
                          : new Intl.NumberFormat("en-US").format(displayedUsage)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {hasReceiptCash
                          ? "Receipt cash paid · max-reconciled with observed usage"
                          : hasEstimatedApiEquivalent
                          ? "API-equivalent estimate · excluded from cash spend"
                          : costLabel(
                              group.totalCostUsd,
                              group.costCoverage,
                              group.unpricedEventCount,
                              group.unclassifiedCostEventCount
                            )}
                      </p>
                    </td>
                    <td className="px-6 py-4" data-label="Quota">
                      {usagePercent != null ? (
                        <div className="w-32">
                          <div
                            role="progressbar"
                            aria-label={`${group.provider} quota usage`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.min(usagePercent, 100)}
                            className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden"
                          >
                            <div
                              className={`h-full ${
                                usagePercent >= 90
                                  ? "bg-red-500 dark:bg-red-600"
                                  : usagePercent >= 70
                                    ? "bg-amber-500 dark:bg-amber-600"
                                    : "bg-emerald-500 dark:bg-emerald-600"
                              }`}
                              style={{ width: `${Math.min(usagePercent, 100)}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                            {usagePercent.toFixed(1)}% of{" "}
                            {new Intl.NumberFormat("en-US").format(group.limit ?? 0)}
                            {group.limitWindow ? `/${group.limitWindow}` : ""}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-500">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {usageSummary.groups.length > 8 && (
            <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                type="button"
                onClick={() => setShowAll((expanded) => !expanded)}
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
              >
                {showAll ? "Show fewer groups" : `Show all ${usageSummary.groups.length} groups`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
