"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AddProviderModal from "@/components/AddProviderModal";
import AddProjectModal, { Project } from "@/components/AddProjectModal";
import AddSubscriptionModal, { type SubscriptionFormValue } from "@/components/AddSubscriptionModal";
import SubscriptionsPanel, { type SubscriptionRow } from "@/components/SubscriptionsPanel";
import ProviderTable from "@/components/ProviderTable";
import ProjectTable from "@/components/ProjectTable";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";

export type BillingMode = "actual" | "estimated" | "manual";
type SettingsTab = "api-keys" | "notifications" | "billing";

export interface ProviderPlan {
  billingMode: BillingMode;
  fixedMonthlyCostUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyRequestLimit: number | null;
  lowBalanceUsd: number | null;
  lowCredits: number | null;
  renewalDate: string | null;
  billingInterval: string | null;
  mustKeepFunded: boolean;
  notes: string | null;
}

export interface ProviderAlert {
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
  isActive: boolean;
  refreshIntervalMin: number;
  groupId: string | null;
  label: string | null;
  keyPreview?: string | null;
  plan: ProviderPlan | null;
  allocations: { projectId: string; percentage: number }[];
  externalBilling?: ExternalBillingRecord[];
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  alerts: ProviderAlert[];
  estimatedMonthlyCostUsd: number;
  spentUsd?: number;
  projectedEomUsd?: number;
  billingMode: BillingMode;
  createdAt: string;
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

function parseSettingsTab(value: string | null): SettingsTab {
  return value === "notifications" || value === "billing" ? value : "api-keys";
}

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const activeTab = parseSettingsTab(searchParams.get("tab"));
  const [providers, setProviders] = useState<Provider[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [subscriptionModalOpen, setSubscriptionModalOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<Provider | null>(null);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editSubscription, setEditSubscription] = useState<SubscriptionFormValue | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<string | null>(null);
  const [deleteSubscriptionConfirm, setDeleteSubscriptionConfirm] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const providersLoaded = useRef(false);
  const projectsLoaded = useRef(false);
  const subscriptionsLoaded = useRef(false);

  const fetchProviders = useCallback(async () => {
    try {
      if (!providersLoaded.current) setLoading(true);
      setError("");
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data = await res.json();
      setProviders(data);
      providersLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      if (!projectsLoaded.current) setProjectsLoading(true);
      setError("");
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const data = await res.json();
      setProjects(data);
      projectsLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const fetchSubscriptions = useCallback(async () => {
    try {
      if (!subscriptionsLoaded.current) setSubscriptionsLoading(true);
      setError("");
      const res = await fetch("/api/subscriptions");
      if (!res.ok) throw new Error("Failed to fetch subscriptions");
      const data = await res.json();
      setSubscriptions(data);
      subscriptionsLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscriptions");
    } finally {
      setSubscriptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount
    fetchProviders();
    fetchProjects();
    fetchSubscriptions();
  }, [fetchProviders, fetchProjects, fetchSubscriptions]);

  const handleSave = async (provider: {
    id?: string;
    name: string;
    displayName: string;
    type: string;
    apiKey?: string;
    config?: Record<string, unknown>;
    label?: string | null;
    plan?: ProviderPlan | null;
    allocations?: { projectId: string; percentage: number }[];
  }) => {
    if (provider.id) {
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: provider.displayName,
          apiKey: provider.apiKey,
          config: provider.config,
          label: provider.label,
          plan: provider.plan,
          allocations: provider.allocations ?? [],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update");
      }
    } else {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create");
      }
    }
    await fetchProviders();
    setEditProvider(null);
  };

  const handleDelete = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setActionLoading(null);
      setDeleteConfirm(null);
    }
  };

  const handleSaveProject = async (project: Project) => {
    if (project.id) {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update project");
      }
    } else {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create project");
      }
    }
    await fetchProjects();
    setEditProject(null);
  };

  const handleDeleteProject = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete project");
      await fetchProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete project");
    } finally {
      setActionLoading(null);
      setDeleteProjectConfirm(null);
    }
  };

  const handleSaveSubscription = async (subscription: SubscriptionFormValue) => {
    const url = subscription.id ? `/api/subscriptions/${subscription.id}` : "/api/subscriptions";
    const res = await fetch(url, {
      method: subscription.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to save subscription");
    }
    await fetchSubscriptions();
    setEditSubscription(null);
  };

  const handleDeleteSubscription = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/subscriptions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete subscription");
      await fetchSubscriptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete subscription");
    } finally {
      setActionLoading(null);
      setDeleteSubscriptionConfirm(null);
    }
  };

  const handleToggleActive = async (provider: Provider) => {
    setActionLoading(provider.id);
    try {
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !provider.isActive }),
      });
      if (!res.ok) throw new Error("Failed to update");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setActionLoading(null);
    }
  };

  const handleFetchNow = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/providers/${id}/fetch`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to fetch");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setActionLoading(null);
    }
  };

  if (
    (loading && activeTab === "api-keys") ||
    ((projectsLoading || subscriptionsLoading) && activeTab === "billing")
  ) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-32 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-10 w-32 bg-gray-200 dark:bg-gray-700 rounded-lg"></div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="h-12 bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800"></div>
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-white dark:bg-gray-800"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        {activeTab === "api-keys" ? (
          <button
            type="button"
            onClick={() => {
              setEditProvider(null);
              setModalOpen(true);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add API Key
          </button>
        ) : activeTab === "billing" ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setEditProject(null);
                setProjectModalOpen(true);
              }}
              className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
            >
              Add Project
            </button>
            <button
              type="button"
              onClick={() => {
                setEditSubscription(null);
                setSubscriptionModalOpen(true);
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Add Subscription
            </button>
          </div>
        ) : null}
      </div>

      <nav aria-label="Settings sections" className="flex overflow-x-auto border-b border-gray-200 dark:border-gray-800">
        <Link
          href="/settings?tab=api-keys"
          id="settings-tab-api-keys"
          aria-current={activeTab === "api-keys" ? "page" : undefined}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === "api-keys"
              ? "border-blue-500 text-blue-600 dark:text-blue-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
        >
          API Keys
        </Link>
        <Link
          href="/settings?tab=notifications"
          id="settings-tab-notifications"
          aria-current={activeTab === "notifications" ? "page" : undefined}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === "notifications"
              ? "border-blue-500 text-blue-600 dark:text-blue-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
        >
          Notifications
        </Link>
        <Link
          href="/settings?tab=billing"
          id="settings-tab-billing"
          aria-current={activeTab === "billing" ? "page" : undefined}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
            activeTab === "billing"
              ? "border-blue-500 text-blue-600 dark:text-blue-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
        >
          Billing & Projects
        </Link>
      </nav>

      {error && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
          {error}
        </p>
      )}

      <section id={`settings-panel-${activeTab}`} aria-label={`${activeTab} settings`}>
      {activeTab === "api-keys" ? (
        <div className="space-y-6">
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-blue-900 dark:text-blue-100 flex items-center gap-2 mb-3">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              How Usage Tracking Works
            </h2>
            <div className="grid sm:grid-cols-3 gap-4 text-sm text-blue-800 dark:text-blue-200">
              <div className="space-y-1">
                <p className="font-medium text-blue-900 dark:text-blue-100">1. Poll Adapters</p>
                <p className="text-xs opacity-90">The monitor actively queries provider APIs (e.g. OpenAI) on a schedule. Best for services with billing endpoints.</p>
              </div>
              <div className="space-y-1">
                <p className="font-medium text-blue-900 dark:text-blue-100">2. Pushed Telemetry</p>
                <p className="text-xs opacity-90">Apps explicitly send usage events to the monitor. Used for &quot;blind&quot; providers (e.g. Anthropic, Robinhood) without billing APIs.</p>
              </div>
              <div className="space-y-1">
                <p className="font-medium text-blue-900 dark:text-blue-100">3. OTLP Metrics</p>
                <p className="text-xs opacity-90">Standardized metrics streaming. Perfect for tracking natively supported tools like Claude Code via <code className="px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-800 text-[10px]">/v1/metrics</code>.</p>
              </div>
            </div>
          </div>
          <ProviderTable
            providers={providers}
            actionLoading={actionLoading}
            deleteConfirm={deleteConfirm}
            onEdit={(provider) => {
              setEditProvider(provider);
              setModalOpen(true);
            }}
            onDeleteConfirmStart={setDeleteConfirm}
            onDeleteConfirmCancel={() => setDeleteConfirm(null)}
            onDelete={handleDelete}
            onAddProvider={() => {
              setEditProvider(null);
              setModalOpen(true);
            }}
            onToggleActive={handleToggleActive}
            onFetchNow={handleFetchNow}
          />
        </div>
      ) : activeTab === "notifications" ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Notification Preferences</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
            Configure how you want to be alerted about budget overruns, payment failures, and system issues.
          </p>
          <div className="space-y-4 max-w-md">
            <div className="flex items-start gap-3">
              <div className="flex h-6 items-center">
                <input
                  id="email-alerts"
                  name="email-alerts"
                  type="checkbox"
                  defaultChecked
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600 dark:border-gray-600 dark:bg-gray-900 dark:ring-offset-gray-900"
                />
              </div>
              <div className="text-sm leading-6">
                <label htmlFor="email-alerts" className="font-medium text-gray-900 dark:text-gray-100">Email Alerts</label>
                <p className="text-gray-500 dark:text-gray-400">Receive critical alerts via email immediately.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex h-6 items-center">
                <input
                  id="slack-alerts"
                  name="slack-alerts"
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600 dark:border-gray-600 dark:bg-gray-900 dark:ring-offset-gray-900"
                />
              </div>
              <div className="text-sm leading-6">
                <label htmlFor="slack-alerts" className="font-medium text-gray-900 dark:text-gray-100">Slack Integration</label>
                <p className="text-gray-500 dark:text-gray-400">Send notifications to a designated Slack channel.</p>
              </div>
            </div>
          </div>
          <button type="button" className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            Save Preferences
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          <SubscriptionsPanel
            subscriptions={subscriptions}
            onAdd={() => {
              setEditSubscription(null);
              setSubscriptionModalOpen(true);
            }}
            onEdit={(sub) => {
              setEditSubscription({
                id: sub.id,
                providerId: sub.provider.id,
                projectId: sub.project?.id ?? null,
                name: sub.name,
                description: sub.description,
                costUsd: sub.costUsd,
                currency: sub.currency,
                interval: sub.interval,
                intervalCount: sub.intervalCount,
                anchorDay: sub.anchorDay,
                startDate: sub.startDate,
                autoRenew: sub.autoRenew,
                status: sub.status,
                notes: sub.notes,
                externalBillingSource: sub.externalBillingSource,
                externalBillingId: sub.externalBillingId,
              });
              setSubscriptionModalOpen(true);
            }}
            onDelete={handleDeleteSubscription}
            deleteConfirm={deleteSubscriptionConfirm}
            setDeleteConfirm={setDeleteSubscriptionConfirm}
            actionLoading={actionLoading}
          />

          <ProjectTable
            projects={projects}
            actionLoading={actionLoading}
            deleteProjectConfirm={deleteProjectConfirm}
            onEdit={(project) => {
              setEditProject(project);
              setProjectModalOpen(true);
            }}
            onDeleteConfirmStart={setDeleteProjectConfirm}
            onDeleteConfirmCancel={() => setDeleteProjectConfirm(null)}
            onDelete={handleDeleteProject}
            onAddProject={() => {
              setEditProject(null);
              setProjectModalOpen(true);
            }}
          />
        </div>
      )}
      </section>

      <AddProviderModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditProvider(null);
        }}
        onSave={handleSave}
        editProvider={editProvider}
        existingProviders={providers}
      />
      
      <AddProjectModal
        open={projectModalOpen}
        onClose={() => {
          setProjectModalOpen(false);
          setEditProject(null);
        }}
        onSave={handleSaveProject}
        editProject={editProject}
      />

      <AddSubscriptionModal
        open={subscriptionModalOpen}
        onClose={() => {
          setSubscriptionModalOpen(false);
          setEditSubscription(null);
        }}
        onSave={handleSaveSubscription}
        editSubscription={editSubscription}
        providers={providers.map((p) => ({
          id: p.id,
          name: p.name,
          displayName: p.displayName,
          externalBilling: p.externalBilling,
        }))}
        projects={projects
          .filter((p): p is Project & { id: string } => Boolean(p.id))
          .map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  );
}

function SettingsPageFallback() {
  return (
    <div className="space-y-6 animate-pulse" aria-label="Loading settings">
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 bg-gray-200 rounded" />
        <div className="h-10 w-32 bg-gray-200 rounded-lg" />
      </div>
      <div className="h-12 rounded bg-gray-100" />
      <div className="h-64 rounded-xl border border-gray-200 bg-white" />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsPageFallback />}>
      <SettingsPageContent />
    </Suspense>
  );
}
