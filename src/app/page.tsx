"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ProviderCard from "@/components/ProviderCard";
import SentryHealthCard from "@/components/SentryHealthCard";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
  groupId: string | null;
  label: string | null;
  keyPreview?: string | null;
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  billingMode: "actual" | "estimated" | "manual";
  alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

interface ExternalUsageGroup {
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  projectId: string | null;
  projectName?: string | null;
  eventCount: number;
  totalCostUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

export interface ProjectBudgetStatus {
  id: string;
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "exceeded" | "unconfigured";
}

interface ExternalUsageSummary {
  days: number;
  totalCostUsd: number;
  totalRequests: number;
  eventCount: number;
  groups: ExternalUsageGroup[];
}

export default function DashboardPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const [providersRes, usageRes, projectsRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/usage-events?days=30"),
        fetch("/api/projects"),
      ]);
      if (!providersRes.ok) throw new Error("Failed to fetch providers");
      if (!usageRes.ok) throw new Error("Failed to fetch app telemetry");
      if (!projectsRes.ok) throw new Error("Failed to fetch projects");
      setProviders(await providersRes.json());
      setUsageSummary(await usageRes.json());
      setProjects(await projectsRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount
    fetchProviders();
  }, [fetchProviders]);

  // Deduplicate balance by groupId: only count each group's balance once
  const seenGroups = new Set<string | null>();
  const totalBalance = providers.reduce((sum, p) => {
    const balance = p.latestSnapshot?.balance || 0;
    if (!p.groupId) {
      return sum + balance;
    }
    if (seenGroups.has(p.groupId)) {
      return sum;
    }
    seenGroups.add(p.groupId);
    // Use the first non-null balance in the group
    const groupProviders = providers.filter((x) => x.groupId === p.groupId);
    const groupBalance = groupProviders.find((x) => x.latestSnapshot?.balance != null)?.latestSnapshot?.balance;
    return sum + (groupBalance ?? 0);
  }, 0);
  const totalCost = providers.reduce(
    (sum, p) => sum + (p.latestSnapshot?.totalCost || 0),
    0
  );
  const totalProjectedMonthlyCost = providers.reduce(
    (sum, p) => sum + (p.projectedEomUsd || 0),
    0
  );
  const externalCost = usageSummary?.totalCostUsd ?? 0;
  const externalRequests = usageSummary?.totalRequests ?? 0;
  const totalCredits = providers.reduce(
    (sum, p) => sum + (p.latestSnapshot?.credits || 0),
    0
  );
  const hasAnyCredits = providers.some(
    (p) => p.latestSnapshot?.credits != null
  );
  const attentionItems = providers.flatMap((provider) =>
    provider.alerts
      .filter((alert) => alert.severity !== "info")
      .map((alert) => ({ provider, alert }))
  );
  const criticalCount = attentionItems.filter(
    (item) => item.alert.severity === "critical"
  ).length;

  if (loading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded"></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-gray-100 rounded-xl border border-gray-200 p-6 h-28"></div>
          ))}
        </div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-48"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-gray-100 rounded-xl border border-gray-200 p-6 h-40"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-600">{error}</p>
        <button
          onClick={fetchProviders}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Total Balance</p>
          <p className="text-3xl font-bold text-gray-900">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(totalBalance)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Projected Monthly Spend</p>
          <p className="text-3xl font-bold text-gray-900">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(totalProjectedMonthlyCost)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Usage Cost This Month</p>
          <p className="text-3xl font-bold text-amber-600">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(totalCost)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Open Alerts</p>
          <p
            className={`text-3xl font-bold ${
              criticalCount > 0 ? "text-red-600" : "text-amber-600"
            }`}
          >
            {attentionItems.length}
          </p>
          {criticalCount > 0 && (
            <p className="text-xs text-red-500 mt-1">{criticalCount} critical</p>
          )}
        </div>
        {hasAnyCredits && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <p className="text-sm text-gray-500 mb-1">Total Credits</p>
            <p className="text-3xl font-bold text-purple-600">
              {new Intl.NumberFormat("en-US").format(totalCredits)}
            </p>
          </div>
        )}
      </div>

      {usageSummary && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">
                External App Telemetry
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Last {usageSummary.days} days from sibling app reports
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold text-gray-900">
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(externalCost)}
              </p>
              <p className="text-xs text-gray-500">
                {new Intl.NumberFormat("en-US").format(externalRequests)} requests
              </p>
            </div>
          </div>
          {usageSummary.groups.length === 0 ? (
            <div className="px-6 py-5 text-sm text-gray-500">
              No app telemetry received yet.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {usageSummary.groups.slice(0, 8).map((group) => {
                const usagePercent =
                  group.limit && group.totalQuantity
                    ? Math.min((group.totalQuantity / group.limit) * 100, 999)
                    : null;
                return (
                  <div
                    key={`${group.sourceApp}-${group.environment ?? ""}-${group.provider}-${group.service ?? ""}-${group.projectId ?? ""}`}
                    className="px-6 py-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {group.sourceApp}
                          {group.environment ? ` / ${group.environment}` : ""}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {group.provider}
                          {group.service ? ` - ${group.service}` : ""}
                        </p>
                        {group.projectName && (
                          <span className="inline-flex mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-50 text-blue-700 border border-blue-100">
                            {group.projectName}
                          </span>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-gray-900">
                          {new Intl.NumberFormat("en-US").format(
                            group.totalRequests || group.totalQuantity
                          )}
                        </p>
                        <p className="text-xs text-gray-500">
                          {group.totalCostUsd
                            ? new Intl.NumberFormat("en-US", {
                                style: "currency",
                                currency: "USD",
                              }).format(group.totalCostUsd)
                            : `${group.eventCount} events`}
                        </p>
                      </div>
                    </div>
                    {usagePercent != null && (
                      <div className="mt-3">
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${
                              usagePercent >= 90
                                ? "bg-red-500"
                                : usagePercent >= 70
                                  ? "bg-amber-500"
                                  : "bg-emerald-500"
                            }`}
                            style={{ width: `${Math.min(usagePercent, 100)}%` }}
                          />
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          {usagePercent.toFixed(1)}% of{" "}
                          {new Intl.NumberFormat("en-US").format(group.limit ?? 0)}
                          {group.limitWindow ? ` per ${group.limitWindow}` : ""}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <SentryHealthCard />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Attention</h2>
          <Link href="/settings" className="text-xs font-medium text-blue-600">
            Manage budgets
          </Link>
        </div>
        {attentionItems.length === 0 ? (
          <div className="px-6 py-5 text-sm text-gray-500">
            No payment, budget, or limit alerts.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {attentionItems.slice(0, 8).map(({ provider, alert }, index) => (
              <Link
                key={`${provider.id}-${index}`}
                href={`/providers/${provider.id}`}
                className="flex items-start justify-between gap-4 px-6 py-4 hover:bg-gray-50"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {provider.displayName}
                    {provider.label ? ` - ${provider.label}` : ""}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{alert.message}</p>
                </div>
                <span
                  className={`text-xs font-medium px-2 py-1 rounded-full ${
                    alert.severity === "critical"
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {alert.severity}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>


      {/* Projects Section */}
      {projects.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">Projects</h2>
            <Link href="/settings" className="text-xs font-medium text-blue-600">
              Manage projects
            </Link>
          </div>
          <div className="divide-y divide-gray-100">
            {projects.map((project) => {
              const usagePercent = project.percentUsed != null ? project.percentUsed * 100 : null;
              return (
                <div key={project.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{project.name}</p>
                      {project.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{project.description}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-900">
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                        }).format(project.spentUsd)}
                      </p>
                      {project.monthlyBudgetUsd != null && (
                        <p className="text-xs text-gray-500">
                          of {new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                          }).format(project.monthlyBudgetUsd)}
                        </p>
                      )}
                    </div>
                  </div>
                  {usagePercent != null && (
                    <div className="mt-3">
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            usagePercent >= 90
                              ? "bg-red-500"
                              : usagePercent >= 70
                                ? "bg-amber-500"
                                : "bg-emerald-500"
                          }`}
                          style={{ width: `${Math.min(usagePercent, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Provider Grid */}
      {providers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <svg
            className="w-16 h-16 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <p className="text-gray-500 text-lg">No providers configured yet</p>
          <Link
            href="/settings"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add your first provider
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              id={provider.id}
              name={provider.name}
              displayName={provider.displayName}
              type={provider.type}
              label={provider.label}
              keyPreview={provider.keyPreview}
              estimatedMonthlyCostUsd={provider.estimatedMonthlyCostUsd}
              projectedEomUsd={provider.projectedEomUsd}
              billingMode={provider.billingMode}
              alerts={provider.alerts}
              latestSnapshot={provider.latestSnapshot}
            />
          ))}
        </div>
      )}
    </div>
  );
}
