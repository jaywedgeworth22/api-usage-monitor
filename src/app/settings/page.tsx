"use client";

import { useState, useEffect, useCallback } from "react";
import AddProviderModal from "@/components/AddProviderModal";

type BillingMode = "actual" | "estimated" | "manual";

interface ProviderPlan {
  billingMode: BillingMode;
  fixedMonthlyCostUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyRequestLimit: number | null;
  lowBalanceUsd: number | null;
  lowCredits: number | null;
  renewalDate: string | null;
  mustKeepFunded: boolean;
  notes: string | null;
}

interface ProviderAlert {
  severity: "critical" | "warning" | "info";
  message: string;
}

interface Provider {
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
  alerts: ProviderAlert[];
  estimatedMonthlyCostUsd: number;
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

export default function SettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<Provider | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data = await res.json();
      setProviders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleSave = async (provider: {
    id?: string;
    name: string;
    displayName: string;
    type: string;
    apiKey?: string;
    config?: Record<string, unknown>;
    label?: string | null;
    plan?: ProviderPlan | null;
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

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleString();
  };

  const formatUsd = (amount: number | null | undefined) => {
    if (amount == null) return "--";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatDateOnly = (dateStr: string | null | undefined) => {
    if (!dateStr) return "--";
    return new Date(dateStr).toLocaleDateString();
  };

  const hasAnyCredits = providers.some(
    (p) => p.latestSnapshot?.credits != null
  );

  const countProviderAlerts = (provider: Provider) => ({
    open: provider.alerts.filter((a) => a.severity !== "info").length,
    info: provider.alerts.filter((a) => a.severity === "info").length,
    critical: provider.alerts.filter((a) => a.severity === "critical").length,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <button
          onClick={() => {
            setEditProvider(null);
            setModalOpen(true);
          }}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          Add Provider
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
          {error}
        </p>
      )}

      {providers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center bg-white rounded-xl border border-gray-200">
          <p className="text-gray-500">No providers configured yet.</p>
          <button
            onClick={() => setModalOpen(true)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            Add your first provider
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Name
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Label
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Type
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Status
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Spend / Budget
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Renewal
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Alerts
                </th>
                {hasAnyCredits && (
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Credits
                  </th>
                )}
                <th className="text-left px-6 py-3 font-medium text-gray-500">
                  Last Fetched
                </th>
                <th className="text-right px-6 py-3 font-medium text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => {
                const alertCounts = countProviderAlerts(provider);

                return (
                <tr
                  key={provider.id}
                  className="border-b border-gray-50 hover:bg-gray-50"
                >
                  <td className="px-6 py-4">
                    <div>
                      <p className="font-medium text-gray-900">
                        {provider.displayName}
                      </p>
                      <p className="text-xs text-gray-400">{provider.name}</p>
                      {provider.groupId && (
                        <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 text-amber-700 border border-amber-200">
                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                          </svg>
                          Shared balance
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-xs text-gray-400">
                      {provider.label || "--"}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex px-2 py-0.5 text-xs font-medium uppercase rounded bg-gray-100 text-gray-500">
                      {provider.type}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleToggleActive(provider)}
                      disabled={actionLoading === provider.id}
                      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors ${
                        provider.isActive
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-gray-100 text-gray-400"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          provider.isActive ? "bg-emerald-500" : "bg-gray-300"
                        }`}
                      />
                      {provider.isActive ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-xs">
                      <p className="font-medium text-gray-900">
                        {formatUsd(provider.estimatedMonthlyCostUsd)}
                      </p>
                      <p className="text-gray-400">
                        Budget {formatUsd(provider.plan?.monthlyBudgetUsd)}
                      </p>
                      <span className="inline-flex mt-1 px-1.5 py-0.5 rounded bg-gray-100 text-[10px] font-medium uppercase text-gray-500">
                        {provider.billingMode}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-xs text-gray-500">
                    {formatDateOnly(provider.plan?.renewalDate)}
                  </td>
                  <td className="px-6 py-4">
                    {alertCounts.open > 0 ? (
                      <span
                        className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                          alertCounts.critical > 0
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {alertCounts.open}{" "}
                        open
                      </span>
                    ) : alertCounts.info > 0 ? (
                      <span className="inline-flex px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-medium">
                        Needs setup
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
                        OK
                      </span>
                    )}
                  </td>
                  {hasAnyCredits && (
                    <td className="px-6 py-4 text-right text-purple-600 text-xs">
                      {provider.latestSnapshot?.credits != null
                        ? new Intl.NumberFormat("en-US").format(
                            provider.latestSnapshot.credits
                          )
                        : "--"}
                    </td>
                  )}
                  <td className="px-6 py-4 text-gray-500 text-xs">
                    {formatDate(provider.latestSnapshot?.fetchedAt ?? null)}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleFetchNow(provider.id)}
                        disabled={actionLoading === provider.id}
                        className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors disabled:opacity-50"
                      >
                        {actionLoading === provider.id ? "..." : "Fetch Now"}
                      </button>
                      <button
                        onClick={() => {
                          setEditProvider(provider);
                          setModalOpen(true);
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-md transition-colors"
                      >
                        Edit
                      </button>
                      {deleteConfirm === provider.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(provider.id)}
                            disabled={actionLoading === provider.id}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(provider.id)}
                          className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      )}

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
    </div>
  );
}
