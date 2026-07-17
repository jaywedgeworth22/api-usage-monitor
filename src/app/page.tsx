"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  type ProviderCostCoverage,
  type ProviderCostCoverageCaveat,
} from "@/components/ProviderCard";
import SentryHealthCard from "@/components/SentryHealthCard";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";
import DashboardCharts from "@/components/DashboardCharts";
import ExternalTelemetryPanel, { type ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import ProjectsPanel, { type ProjectBudgetStatus } from "@/components/ProjectsPanel";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import PaidServicesPanel from "@/components/PaidServicesPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import DashboardProviderWorkspace from "@/components/DashboardProviderWorkspace";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  refreshIntervalMin: number;
  isActive: boolean;
  groupId: string | null;
  label: string | null;
  keyPreview?: string | null;
  anthropicAdminApiConfigured?: boolean;
  geminiKeyStatus?: {
    state: "valid" | "invalid" | "unreadable" | "unavailable" | "unchecked" | "not_configured";
    httpStatus: number | null;
    availableModelCount: number | null;
    checkedAt: string | null;
  } | null;
  geminiBillingStatus?: {
    state: "ready" | "pending" | "error" | "configuration_changed" | "unchecked" | "not_configured";
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  geminiMonitoringStatus?: {
    state: "ready" | "empty" | "partial" | "permission_denied" | "error" | "configuration_changed" | "project_required" | "credential_required" | "unchecked" | "not_configured";
    projectId: string | null;
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  config?: Record<string, unknown>;
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  spentUsd?: number;
  receiptCashPaidUsd?: number;
  receiptCashEventCount?: number;
  observedVariableUsageUsd?: number;
  estimatedApiEquivalentUsd?: number;
  snapshotCostFetchedAt?: string | null;
  spendCoverage: ProviderCostCoverage;
  costCoverageCaveat?: ProviderCostCoverageCaveat | null;
  pushedCostCoverage: ProviderCostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  externalBilling?: ExternalBillingRecord[];
  plan: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    renewalDate: string | null;
    billingInterval: string | null;
    notes: string | null;
  } | null;
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

interface ProjectBudgetResponse {
  projects: ProjectBudgetStatus[];
  summary: {
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  };
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch ${label}`);
  }
  return response.json() as Promise<T>;
}

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 15_000;

export default function DashboardPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectBudgetResponse["summary"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);
  const isFetchingRef = useRef(false);
  const lastSuccessAtRef = useRef(0);
  const portfolioDetailsRef = useRef<HTMLDetailsElement>(null);

  const fetchProviders = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    // Background refreshes (interval poll, focus/visibility refetch) must never blank
    // the UI or disable the manual refresh button - only data and the timestamp update.
    // Foreground calls (initial load, manual refresh/retry) show refreshing/loading and
    // clear the error/warnings immediately, matching prior behavior - clearing them up
    // front for background calls would instead flash the (still-empty) main content or
    // blank the visible warnings banner mid-flight. setWarnings(nextWarnings) below always
    // runs after Promise.allSettled (which never rejects), so background outcomes still
    // update the banner atomically once the fetch settles.
    const startForegroundUiState = () => {
      if (loadedOnce.current && hasProviderData.current) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");
      setWarnings([]);
    };

    if (isFetchingRef.current) {
      // Guard against overlapping in-flight refreshes: don't start a second fetch.
      // Background calls just no-op here - the in-flight fetch already covers them. But a
      // foreground call (manual refresh/retry) must not silently drop the click with no
      // feedback: "upgrade" the in-flight fetch by applying the same UI state a fresh
      // foreground call would, then return without starting one. The in-flight fetch's own
      // finally block clears refreshing/loading unconditionally once it settles, so the
      // button reflects the outcome either way.
      if (!background) startForegroundUiState();
      return;
    }
    isFetchingRef.current = true;

    if (background) {
      // no loading/refreshing UI state
    } else {
      startForegroundUiState();
    }

    try {
      const [providersResult, usageResult, projectsResult, subscriptionsResult] = await Promise.allSettled([
        fetchJson<Provider[]>("/api/providers", "providers"),
        fetchJson<ExternalUsageSummary>("/api/usage-events?days=30", "app telemetry"),
        fetchJson<ProjectBudgetResponse>("/api/projects?includeSummary=1", "projects"),
        fetchJson<SubscriptionRow[]>("/api/subscriptions", "paid services"),
      ]);

      const nextWarnings: string[] = [];
      if (providersResult.status === "fulfilled") {
        setProviders(providersResult.value);
        hasProviderData.current = true;
        setError("");
      } else if (!hasProviderData.current) {
        setError(providersResult.reason instanceof Error ? providersResult.reason.message : "Failed to load providers");
      } else {
        nextWarnings.push("Provider data could not be refreshed; showing the last successful result.");
      }

      if (usageResult.status === "fulfilled") {
        setUsageSummary(usageResult.value);
      } else {
        nextWarnings.push("External app telemetry is temporarily unavailable.");
      }

      if (projectsResult.status === "fulfilled") {
        setProjects(projectsResult.value.projects);
        setProjectSummary(projectsResult.value.summary);
      } else {
        nextWarnings.push("Project budgets are temporarily unavailable.");
      }

      if (subscriptionsResult.status === "fulfilled") {
        setSubscriptions(subscriptionsResult.value);
      } else {
        nextWarnings.push("Tracked subscriptions are temporarily unavailable.");
      }

      setWarnings(nextWarnings);
      if (providersResult.status === "fulfilled") {
        setLastUpdatedAt(new Date().toISOString());
        lastSuccessAtRef.current = Date.now();
      }
    } finally {
      loadedOnce.current = true;
      // Cleared unconditionally: background calls never set these to true, and this also
      // covers the case where a foreground call "upgraded" this in-flight fetch via the
      // guard above and set them itself.
      setLoading(false);
      setRefreshing(false);
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    // Refetch on regained focus / visibility, throttled so tab-switching doesn't
    // hammer the API when the last refresh (poll, focus, or manual) was recent.
    const refreshIfDue = () => {
      if (document.hidden) return;
      if (Date.now() - lastSuccessAtRef.current < FOCUS_REFRESH_THROTTLE_MS) return;
      fetchProviders({ background: true });
    };

    // Skip ticks while the tab is hidden; visibilitychange picks up the refresh on return.
    const handleIntervalTick = () => {
      if (document.hidden) return;
      fetchProviders({ background: true });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) refreshIfDue();
    };

    const intervalId = window.setInterval(handleIntervalTick, AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfDue);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfDue);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchProviders]);

  // Shared open+scroll routine for the "Portfolio detail" accordion: used both by the
  // #attention hash-open effect below and by DashboardSummaryCards' Open Alerts cell so a
  // re-click while the hash is already #attention (and the accordion was re-closed) still works.
  const openAttentionPanel = useCallback(() => {
    if (portfolioDetailsRef.current) portfolioDetailsRef.current.open = true;
    document.getElementById("attention")?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    const openIfAttentionHash = () => {
      if (window.location.hash !== "#attention") return;
      openAttentionPanel();
    };
    openIfAttentionHash();
    window.addEventListener("hashchange", openIfAttentionHash);
    return () => window.removeEventListener("hashchange", openIfAttentionHash);
  }, [loading, openAttentionPanel]); // re-run after the skeleton is replaced - the details ref is null during loading

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
    (sum, p) => sum + (p.spentUsd ?? p.latestSnapshot?.totalCost ?? 0),
    0
  );
  const totalProjectedMonthlyCost = providers.reduce(
    (sum, p) => sum + (p.projectedEomUsd || 0),
    0
  );
  const incompleteCostProviderCount = providers.filter(
    (provider) => provider.isActive && provider.spendCoverage !== "complete"
  ).length;
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
  ).sort((left, right) => {
    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    return (
      severityRank[left.alert.severity] - severityRank[right.alert.severity] ||
      left.provider.displayName.localeCompare(right.provider.displayName) ||
      left.alert.message.localeCompare(right.alert.message)
    );
  });
  const criticalCount = attentionItems.filter(
    (item) => item.alert.severity === "critical"
  ).length;

  // "Portfolio detail" accordion summary line - page-level state only (no Sentry/telemetry
  // counts: SentryHealthCard fetches its own data and page.tsx has no Sentry state).
  const portfolioSummaryParts = [
    `${subscriptions.length} paid service${subscriptions.length === 1 ? "" : "s"}`,
  ];
  if (projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) {
    portfolioSummaryParts.push(`${projects.length} project${projects.length === 1 ? "" : "s"}`);
  }
  portfolioSummaryParts.push(
    `${attentionItems.length} open alert${attentionItems.length === 1 ? "" : "s"}`
  );
  const portfolioSummary = `${portfolioSummaryParts.join(" · ")} · charts & health`;

  if (loading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-24"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-96"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-14"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p role="alert" className="text-red-600">{error}</p>
        <button
          type="button"
          onClick={() => fetchProviders()}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex items-center gap-3">
          {lastUpdatedAt && (
            <span className="hidden text-xs text-gray-500 sm:inline">
              Updated {new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button
            type="button"
            onClick={() => fetchProviders()}
            disabled={refreshing}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {warnings.join(" ")}
        </div>
      )}

      <DashboardSummaryCards
        totalBalance={totalBalance}
        totalProjectedMonthlyCost={totalProjectedMonthlyCost}
        totalCost={totalCost}
        incompleteCostProviderCount={incompleteCostProviderCount}
        attentionItemsCount={attentionItems.length}
        criticalCount={criticalCount}
        hasAnyCredits={hasAnyCredits}
        totalCredits={totalCredits}
        onAlertsNavigate={openAttentionPanel}
      />

      <DashboardProviderWorkspace providers={providers} subscriptions={subscriptions} />

      <details ref={portfolioDetailsRef} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-gray-200 bg-white px-6 py-4 text-sm font-semibold text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
          Portfolio detail
          <span className="ml-1 min-w-0 truncate text-xs font-normal text-gray-500 dark:text-gray-400">
            {portfolioSummary}
          </span>
        </summary>
        <div className="mt-8 space-y-8">
          <PaidServicesPanel
            providers={providers}
            subscriptions={subscriptions}
            variant="dashboard"
            maxItems={6}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              {usageSummary && <ExternalTelemetryPanel usageSummary={usageSummary} />}

              {(projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) && (
                <ProjectsPanel projects={projects} summary={projectSummary} />
              )}
            </div>
            <div className="space-y-8">
              <DashboardCharts providers={providers} />
              <SentryHealthCard />
            </div>
          </div>

          <div id="attention" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
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
        </div>
      </details>
    </div>
  );
}
