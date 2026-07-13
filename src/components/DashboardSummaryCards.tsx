import React from "react";

interface DashboardSummaryCardsProps {
  totalBalance: number;
  totalProjectedMonthlyCost: number;
  totalCost: number;
  incompleteCostProviderCount: number;
  attentionItemsCount: number;
  criticalCount: number;
  hasAnyCredits: boolean;
  totalCredits: number;
}

export default function DashboardSummaryCards({
  totalBalance,
  totalProjectedMonthlyCost,
  totalCost,
  incompleteCostProviderCount,
  attentionItemsCount,
  criticalCount,
  hasAnyCredits,
  totalCredits,
}: DashboardSummaryCardsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Open Alerts</p>
        <a href="#attention" className="block hover:opacity-80 transition-opacity">
          <p
            className={`text-3xl font-bold ${
              criticalCount > 0 ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {attentionItemsCount}
          </p>
          {criticalCount > 0 && (
            <p className="text-xs text-red-500 dark:text-red-400 mt-1">{criticalCount} critical &rarr;</p>
          )}
          {criticalCount === 0 && attentionItemsCount > 0 && (
            <p className="text-xs text-amber-500 dark:text-amber-400 mt-1">View details &rarr;</p>
          )}
        </a>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
          {incompleteCostProviderCount > 0
            ? "Known Spend This Month"
            : "Tracked Spend This Month"}
        </p>
        <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalCost)}
        </p>
        {incompleteCostProviderCount > 0 && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">
            {incompleteCostProviderCount} provider cost{incompleteCostProviderCount === 1 ? "" : "s"} incomplete
          </p>
        )}
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
          {incompleteCostProviderCount > 0
            ? "Known-Cost Projection"
            : "Projected Monthly Spend"}
        </p>
        <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalProjectedMonthlyCost)}
        </p>
        {incompleteCostProviderCount > 0 && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Excludes unreported provider costs
          </p>
        )}
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Total Balance</p>
        <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalBalance)}
        </p>
      </div>
      {hasAnyCredits && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Total Credits</p>
          <p className="text-3xl font-bold text-purple-600 dark:text-purple-400">
            {new Intl.NumberFormat("en-US").format(totalCredits)}
          </p>
        </div>
      )}
    </div>
  );
}
