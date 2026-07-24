"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import type { ProjectBudgetStatus } from "@/components/ProjectsPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";

export interface ProjectBudgetResponse {
  projects: ProjectBudgetStatus[];
  summary: {
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  };
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const signal = AbortSignal.timeout(20_000);
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch ${label}`);
  }
  return response.json() as Promise<T>;
}

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 15_000;

export function useDashboardData() {
  const [providers, setProviders] = useState<any[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectBudgetResponse["summary"] | null>(null);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);
  const isFetchingRef = useRef(false);
  const lastSuccessAtRef = useRef(0);
  const portfolioFetchInFlightRef = useRef(false);

  const fetchProviders = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    const startForegroundUiState = () => {
      if (loadedOnce.current) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");
      setWarnings([]);
    };

    if (isFetchingRef.current) {
      if (!background && loadedOnce.current) {
        setRefreshing(true);
      }
      return;
    }
    isFetchingRef.current = true;

    if (background) {
      // no loading/refreshing UI state
    } else {
      startForegroundUiState();
    }

    try {
      const [providersResult, subscriptionsResult] = await Promise.allSettled([
        fetchJson<unknown[]>("/api/providers?view=dashboard", "providers"),
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
      setLoading(false);
      setRefreshing(false);
      isFetchingRef.current = false;
    }
  }, []);

  const fetchPortfolioData = useCallback(async () => {
    if (portfolioFetchInFlightRef.current) return;
    portfolioFetchInFlightRef.current = true;
    setPortfolioLoading(true);
    setPortfolioError("");
    const failures: string[] = [];
    try {
      try {
        setUsageSummary(
          await fetchJson<ExternalUsageSummary>(
            "/api/usage-events?days=30",
            "app telemetry"
          )
        );
      } catch {
        failures.push("External app telemetry is temporarily unavailable.");
      }
      try {
        const response = await fetchJson<ProjectBudgetResponse>(
          "/api/projects?includeSummary=1",
          "projects"
        );
        setProjects(response.projects);
        setProjectSummary(response.summary);
      } catch {
        failures.push("Project budgets are temporarily unavailable.");
      }
      setPortfolioError(failures.join(" "));
      setPortfolioLoaded(failures.length === 0);
    } finally {
      setPortfolioLoading(false);
      portfolioFetchInFlightRef.current = false;
    }
  }, []);

  const refreshDashboard = useCallback(async () => {
    await fetchProviders();
    if (portfolioOpen) await fetchPortfolioData();
  }, [fetchPortfolioData, fetchProviders, portfolioOpen]);

  // Initial load
  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  // Auto-refresh on interval + focus/visibility
  useEffect(() => {
    const refreshIfDue = () => {
      if (document.hidden) return;
      if (Date.now() - lastSuccessAtRef.current < FOCUS_REFRESH_THROTTLE_MS) return;
      fetchProviders({ background: true });
    };

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

  // Portfolio auto-refresh when open
  useEffect(() => {
    if (!portfolioOpen) return;
    if (!document.hidden) void fetchPortfolioData();
    const interval = window.setInterval(
      () => {
        if (!document.hidden) void fetchPortfolioData();
      },
      AUTO_REFRESH_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [fetchPortfolioData, portfolioOpen]);

  const openAttentionPanel = useCallback(() => {
    window.requestAnimationFrame(() => {
      document.getElementById("attention")?.scrollIntoView({ block: "start" });
    });
  }, []);

  // Hash-based attention navigation
  useEffect(() => {
    const openIfAttentionHash = () => {
      if (window.location.hash !== "#attention") return;
      openAttentionPanel();
    };
    openIfAttentionHash();
    window.addEventListener("hashchange", openIfAttentionHash);
    return () => window.removeEventListener("hashchange", openIfAttentionHash);
  }, [loading, openAttentionPanel]);

  return {
    providers,
    usageSummary,
    projects,
    subscriptions,
    projectSummary,
    portfolioOpen,
    setPortfolioOpen,
    portfolioLoaded,
    portfolioLoading,
    portfolioError,
    loading,
    refreshing,
    error,
    warnings,
    lastUpdatedAt,
    fetchProviders,
    fetchPortfolioData,
    refreshDashboard,
    openAttentionPanel,
  };
}
