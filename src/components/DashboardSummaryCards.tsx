import React from "react";

interface DashboardSummaryCardsProps {
  totalProviderFunds: number;
  totalProjectedMonthlyCost: number;
  totalCost: number;
  incompleteCostProviderCount: number;
  ambiguousCostFamilyCount: number;
  attentionItemsCount: number;
  criticalCount: number;
  onAlertsNavigate?: () => void;
}

export default function DashboardSummaryCards({
  totalProviderFunds,
  totalProjectedMonthlyCost,
  totalCost,
  incompleteCostProviderCount,
  ambiguousCostFamilyCount,
  attentionItemsCount,
  criticalCount,
  onAlertsNavigate,
}: DashboardSummaryCardsProps) {
  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-100 sm:grid-cols-4 dark:border-gray-700 dark:bg-gray-700"
    >
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Open Alerts
        </p>
        <a
          href="#attention"
          onClick={onAlertsNavigate}
          className="block hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
        >
          <p
            className={`mt-1 text-lg font-semibold tabular-nums ${
              criticalCount > 0 ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {attentionItemsCount}
          </p>
          {criticalCount > 0 && (
            <p className="mt-0.5 text-[11px] text-red-500 dark:text-red-400">{criticalCount} critical &rarr;</p>
          )}
          {criticalCount === 0 && attentionItemsCount > 0 && (
            <p className="mt-0.5 text-[11px] text-amber-500 dark:text-amber-400">View details &rarr;</p>
          )}
        </a>
      </div>
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {incompleteCostProviderCount > 0 || ambiguousCostFamilyCount > 0
            ? "Known Spend This Month"
            : "Tracked Spend This Month"}
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-400">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalCost)}
        </p>
        {incompleteCostProviderCount > 0 && (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-300">
            {incompleteCostProviderCount} provider cost{incompleteCostProviderCount === 1 ? "" : "s"} incomplete
          </p>
        )}
        {ambiguousCostFamilyCount > 0 && (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-300">
            {ambiguousCostFamilyCount} multi-key famil{ambiguousCostFamilyCount === 1 ? "y" : "ies"} excluded
          </p>
        )}
      </div>
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {incompleteCostProviderCount > 0 || ambiguousCostFamilyCount > 0
            ? "Known-Cost Projection"
            : "Projected Monthly Spend"}
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalProjectedMonthlyCost)}
        </p>
        {(incompleteCostProviderCount > 0 || ambiguousCostFamilyCount > 0) && (
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
            Excludes unreported or ambiguous provider costs
          </p>
        )}
      </div>
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Known Provider Funds
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalProviderFunds)}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
          Excludes ambiguous, brokerage, and merchant assets
        </p>
      </div>
    </div>
  );
}
