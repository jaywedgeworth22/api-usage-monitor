import { useState, Fragment } from "react";
import { type Provider } from "@/app/settings/page";
import { isExternalBillingStale } from "@/components/ExternalBillingDetails";
import ProviderIntegrationInfo, { publicConfigFieldNames } from "@/components/ProviderIntegrationInfo";
import { getProviderIntegrationProfile } from "@/lib/provider-integration-catalog";

interface ProviderTableProps {
  providers: Provider[];
  actionLoading: string | null;
  deleteConfirm: string | null;
  onEdit: (provider: Provider) => void;
  onDeleteConfirmStart: (id: string) => void;
  onDeleteConfirmCancel: () => void;
  onDelete: (id: string) => void;
  onAddProvider: () => void;
  onToggleActive: (provider: Provider) => void;
  onFetchNow: (id: string) => void;
}

type SortField = "name" | "type" | "status" | "spend" | "alerts" | "credits" | "lastFetched";
type SortDirection = "asc" | "desc";

function SortHeader({
  field,
  label,
  className = "",
  align = "left",
  activeField,
  direction,
  onSort,
}: {
  field: SortField;
  label: string;
  className?: string;
  align?: "left" | "right";
  activeField: SortField;
  direction: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const isActive = activeField === field;
  return (
    <th
      aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={`px-6 py-3 font-medium text-gray-500 dark:text-gray-400 ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`group flex w-full items-center hover:text-gray-800 dark:hover:text-gray-100 ${
          align === "right" ? "justify-end text-right" : "justify-start text-left"
        }`}
      >
        {label}
        <span className={`ml-1 ${isActive ? "text-gray-500 dark:text-gray-300" : "text-gray-300 opacity-0 group-hover:opacity-100 group-focus:opacity-100 dark:text-gray-600"}`}>
          {isActive ? (direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function providerProfile(provider: Provider) {
  return getProviderIntegrationProfile(provider.name, provider.type);
}

function resolvedSpendCoverage(provider: Provider) {
  return (
    provider.spendCoverage ??
    (provider.spentUsd != null || provider.latestSnapshot?.totalCost != null
      ? "complete"
      : "unknown")
  );
}

function knownSpendUsd(provider: Provider) {
  return (
    provider.spentUsd ??
    provider.latestSnapshot?.totalCost ??
    provider.estimatedMonthlyCostUsd
  );
}

function unpricedEventCount(provider: Provider) {
  return (
    (provider.pushedUnpricedEventCount ?? 0) +
    (provider.pushedUnclassifiedCostEventCount ?? 0)
  );
}

export default function ProviderTable({
  providers,
  actionLoading,
  deleteConfirm,
  onEdit,
  onDeleteConfirmStart,
  onDeleteConfirmCancel,
  onDelete,
  onAddProvider,
  onToggleActive,
  onFetchNow,
}: ProviderTableProps) {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (type: string) => {
    setCollapsedGroups(prev => ({ ...prev, [type]: !prev[type] }));
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const sortHeaderProps = {
    activeField: sortField,
    direction: sortDirection,
    onSort: handleSort,
  };

  const formatDateObject = (dateStr: string | null) => {
    if (!dateStr) return null;
    return new Date(dateStr);
  };

  const formatUsd = (amount: number | null | undefined) => {
    if (amount == null) return "--";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const hasAnyCredits = providers.some(
    (p) => p.latestSnapshot?.credits != null
  );

  const countProviderAlerts = (provider: Provider) => ({
    open: provider.alerts.filter((a) => a.severity !== "info").length,
    info: provider.alerts.filter((a) => a.severity === "info").length,
    critical: provider.alerts.filter((a) => a.severity === "critical").length,
  });

  const sortedProviders = [...providers].sort((a, b) => {
    let comparison = 0;
    switch (sortField) {
      case "name":
        comparison = a.displayName.localeCompare(b.displayName);
        break;
      case "type":
        comparison =
          providerProfile(a).category.localeCompare(providerProfile(b).category) ||
          providerProfile(a).mode.localeCompare(providerProfile(b).mode);
        break;
      case "status":
        comparison = (a.isActive ? 1 : 0) - (b.isActive ? 1 : 0);
        break;
      case "spend":
        comparison = knownSpendUsd(a) - knownSpendUsd(b);
        break;
      case "alerts":
        comparison = countProviderAlerts(a).open - countProviderAlerts(b).open;
        break;
      case "credits": {
        const valA = a.latestSnapshot?.credits ?? 0;
        const valB = b.latestSnapshot?.credits ?? 0;
        comparison = valA - valB;
        break;
      }
      case "lastFetched": {
        const dateA = a.latestSnapshot?.fetchedAt ? new Date(a.latestSnapshot.fetchedAt).getTime() : 0;
        const dateB = b.latestSnapshot?.fetchedAt ? new Date(b.latestSnapshot.fetchedAt).getTime() : 0;
        comparison = dateA - dateB;
        break;
      }
    }
    return sortDirection === "asc" ? comparison : -comparison;
  });

  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-800">
        <p className="text-gray-500 dark:text-gray-400">No providers configured yet.</p>
        <button
          type="button"
          onClick={onAddProvider}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Add your first provider
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <table className="responsive-table w-full text-sm">
        <caption className="sr-only">Configured API providers</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
            <SortHeader {...sortHeaderProps} field="name" label="Name" />
            <SortHeader {...sortHeaderProps} field="type" label="Tracking" className="hidden sm:table-cell" />
            <SortHeader {...sortHeaderProps} field="status" label="Status" className="hidden sm:table-cell" />
            <SortHeader {...sortHeaderProps} field="spend" label="Spend / Budget" />
            <SortHeader {...sortHeaderProps} field="alerts" label="Alerts" />
            {hasAnyCredits && (
              <SortHeader {...sortHeaderProps} field="credits" label="Credits" align="right" />
            )}
            <SortHeader {...sortHeaderProps} field="lastFetched" label="Last fetched" className="hidden xl:table-cell" />
            <th className="px-6 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(
            sortedProviders.reduce((acc, provider) => {
              const category = providerProfile(provider).category;
              if (!acc[category]) acc[category] = [];
              acc[category].push(provider);
              return acc;
            }, {} as Record<string, Provider[]>)
          )
            .sort(([categoryA], [categoryB]) => categoryA.localeCompare(categoryB))
            .map(([category, groupProviders]) => {
              const groupSpend = groupProviders.reduce(
                (sum, provider) => sum + knownSpendUsd(provider),
                0
              );
              const groupBudget = groupProviders.reduce((sum, p) => sum + (p.plan?.monthlyBudgetUsd ?? 0), 0);
              const incompleteGroupCount = groupProviders.filter(
                (provider) => resolvedSpendCoverage(provider) !== "complete"
              ).length;
              
              const isCollapsed = collapsedGroups[category] || false;
              
              return (
                <Fragment key={category}>
                  <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800/50">
                    <td
                      data-label=""
                      colSpan={hasAnyCredits ? 8 : 7}
                      className="table-group-cell p-0"
                    >
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleGroup(category)}
                        className="flex w-full items-center justify-between px-6 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        <div className="flex items-center gap-2">
                          <svg 
                            className={`w-4 h-4 text-gray-400 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                          <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 select-none">
                            {category} <span className="font-normal normal-case opacity-75">({groupProviders.length})</span>
                          </span>
                        </div>
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                          {incompleteGroupCount > 0 ? "Known group spend" : "Group spend"}: {formatUsd(groupSpend)} {groupBudget > 0 && ` / ${formatUsd(groupBudget)}`}
                          {incompleteGroupCount > 0
                            ? ` · ${incompleteGroupCount} incomplete`
                            : ""}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed && groupProviders.map((provider) => {
                    const alertCounts = countProviderAlerts(provider);
                    const connectedBilling = provider.externalBilling?.[0];
                    const billingRecordCount = provider.externalBilling?.length ?? 0;
                    const staleBillingCount = (provider.externalBilling ?? []).filter((record) =>
                      isExternalBillingStale(
                        record,
                        Math.min(24 * 60 * 60 * 1_000, Math.max(60 * 60 * 1_000, provider.refreshIntervalMin * 3 * 60 * 1_000))
                      )
                    ).length;
                    const fetchedDate = formatDateObject(provider.latestSnapshot?.fetchedAt ?? null);
                    const spendCoverage = resolvedSpendCoverage(provider);
                    const unpricedCount = unpricedEventCount(provider);

                    return (
                      <tr
                        key={provider.id}
                        className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                      >
                <td data-label="Name" className="px-6 py-4">
                  <div>
                    <ProviderIntegrationInfo
                      providerName={provider.name}
                      providerType={provider.type}
                      displayName={provider.displayName}
                      variant="name"
                      instanceState={{
                        isActive: provider.isActive,
                        primaryCredentialConfigured: Boolean(provider.keyPreview),
                        keyPreview: provider.keyPreview,
                        publicConfigFields: publicConfigFieldNames(provider.config),
                        protectedConfigFields: provider.secretConfigMeta?.fields ?? [],
                        protectedConfigReadable: provider.secretConfigMeta?.readable,
                        lastSnapshotAt: provider.latestSnapshot?.fetchedAt ?? null,
                        externalBillingRecordCount: provider.externalBilling?.length ?? 0,
                        externalBillingSources: [...new Set((provider.externalBilling ?? []).map((record) => record.source))].sort(),
                      }}
                    />
                    <p className="text-xs text-gray-400 dark:text-gray-500">{provider.name}</p>
                    {provider.label && (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{provider.label}</p>
                    )}
                    {provider.groupId && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                        Shared balance
                      </span>
                    )}
                  </div>
                </td>
                <td data-label="Tracking" className="px-6 py-4 hidden sm:table-cell">
                  <span className="inline-flex rounded bg-gray-100 px-2 py-0.5 text-xs font-medium uppercase text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                    {providerProfile(provider).mode.replace("-", " ")}
                  </span>
                </td>
                <td data-label="Status" className="px-6 py-4 hidden sm:table-cell">
                  <button
                    type="button"
                    aria-label={`${provider.isActive ? "Deactivate" : "Activate"} ${provider.displayName}`}
                    onClick={() => onToggleActive(provider)}
                    disabled={actionLoading === provider.id}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors ${
                      provider.isActive
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                        : "bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-400"
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
                <td data-label="Spend / Budget" className="px-6 py-4">
                  <div className="text-xs">
                    <p className="font-medium text-gray-900 dark:text-gray-100">
                      {spendCoverage === "unknown" || spendCoverage === "legacy_unknown"
                        ? "Cost not reported"
                        : `${formatUsd(knownSpendUsd(provider))}${spendCoverage === "partial" ? " known" : ""} MTD`}
                    </p>
                    {spendCoverage === "complete" && provider.projectedEomUsd != null ? (
                      <p className="text-gray-600 dark:text-gray-300">Projected {formatUsd(provider.projectedEomUsd)}</p>
                    ) : spendCoverage === "partial" && provider.projectedEomUsd != null ? (
                      <p className="text-gray-600 dark:text-gray-300">
                        Known-cost projection {formatUsd(provider.projectedEomUsd)}
                      </p>
                    ) : (
                      <p className="text-gray-500 dark:text-gray-400">Projection unavailable</p>
                    )}
                    {spendCoverage === "partial" && unpricedCount > 0 && (
                      <p className="text-amber-600 dark:text-amber-300">
                        {unpricedCount} unpriced event{unpricedCount === 1 ? "" : "s"}
                      </p>
                    )}
                    {(spendCoverage === "unknown" || spendCoverage === "legacy_unknown") &&
                      unpricedCount > 0 && (
                        <p className="text-amber-600 dark:text-amber-300">
                          {unpricedCount} usage event{unpricedCount === 1 ? "" : "s"} without cost
                        </p>
                      )}
                    <p className="text-gray-600 dark:text-gray-300">
                      Budget {formatUsd(provider.plan?.monthlyBudgetUsd)}
                    </p>
                    <span className="mt-1 inline-flex rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                      {provider.billingMode}
                    </span>
                    {connectedBilling && (
                      <p className="mt-1 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                        Provider billing: {billingRecordCount} record{billingRecordCount === 1 ? "" : "s"} · {connectedBilling.serviceName || connectedBilling.planName || connectedBilling.kind}
                        {connectedBilling.status ? ` · ${connectedBilling.status}` : ""}
                        {staleBillingCount > 0 ? ` · ${staleBillingCount} stale` : ""}
                      </p>
                    )}
                  </div>
                </td>
                <td data-label="Alerts" className="px-6 py-4">
                  {alertCounts.open > 0 ? (
                    <span
                      className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                        alertCounts.critical > 0
                          ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                      }`}
                    >
                      {alertCounts.open}{" "}
                      open
                    </span>
                  ) : alertCounts.info > 0 ? (
                    <span className="inline-flex rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                      Needs setup
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                      OK
                    </span>
                  )}
                </td>
                {hasAnyCredits && (
                  <td data-label="Credits" className="px-6 py-4 text-right text-xs text-purple-600 dark:text-purple-300">
                    {provider.latestSnapshot?.credits != null
                      ? new Intl.NumberFormat("en-US").format(
                          provider.latestSnapshot.credits
                        )
                      : "--"}
                  </td>
                )}
                <td data-label="Last fetched" className="px-6 py-4 hidden xl:table-cell">
                  {fetchedDate ? (
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-900 dark:text-gray-100">
                        {fetchedDate.toLocaleDateString()}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {fetchedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-500 dark:text-gray-400">Never</span>
                  )}
                </td>
                <td data-label="Actions" className="px-6 py-4">
                  <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      aria-label={`Fetch ${provider.displayName} now`}
                      onClick={() => onFetchNow(provider.id)}
                      disabled={actionLoading === provider.id}
                      className="rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"
                    >
                      {actionLoading === provider.id ? "..." : "Fetch Now"}
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit ${provider.displayName}`}
                      onClick={() => onEdit(provider)}
                      className="rounded-md bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                    >
                      Edit
                    </button>
                    {deleteConfirm === provider.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Confirm deletion of ${provider.displayName}`}
                          onClick={() => onDelete(provider.id)}
                          disabled={actionLoading === provider.id}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel deletion of ${provider.displayName}`}
                          onClick={() => onDeleteConfirmCancel()}
                          className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${provider.displayName}`}
                        onClick={() => onDeleteConfirmStart(provider.id)}
                        className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-900/60"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
          </Fragment>
          );
        })}
        </tbody>
      </table>
    </div>
  );
}
